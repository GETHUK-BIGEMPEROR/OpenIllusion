"""Engines: how studio inputs become a request, and back.

There are two kinds. A *cloud* engine is one Comfy Router model; its request
is the model's own JSON body. A *local* engine is a ComfyUI workflow template
(``templates/local/*.json``); its request is the API-format workflow itself,
with the studio's fields written into the inputs its bindings name.

Either way the request is built as a *template*: media slots appear as tokens
such as ``{{image:1}}`` or ``{{video:1|url}}``. The template is what the Raw
tab shows and what a generation stores; ``materialize`` swaps tokens for real data
(a data URI for Router, an uploaded v2 asset for ComfyUI) just before submit.
"""

from __future__ import annotations

import copy
import functools
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from PIL import Image

from . import media, paths, prep

log = logging.getLogger("openillusion")

TOKEN = re.compile(r"^\{\{(image|video|audio):(\d+)(?:\|(uri|b64|url))?\}\}$")

ROLE_PHRASE = {
    "character": "the character",
    "outfit": "the outfit",
    "location": "the location",
    "style": "the style",
    "product": "the product",
    "motion": "the motion",
    "base": "the image to edit",
    "edit": "the image to edit",
}


@dataclass
class Engine:
    id: str
    mode: str  # motion | edit
    label: str
    provider: str
    blurb: str
    max_images: int
    min_images: int = 0
    needs_video: bool = False
    video_window: tuple[float, float] | None = None  # seconds
    fps_window: tuple[float, float] = (23.976, 60.0)
    url_only: bool = False
    params: list[dict] = field(default_factory=list)
    build: Callable[[dict], dict] | None = None
    curated: bool = True
    kind: str = "cloud"  # cloud (Comfy Router) | local (ComfyUI workflow via v2)
    workflow: dict | None = None
    bindings: dict[str, list] = field(default_factory=dict)
    outputs: list[str] = field(default_factory=list)
    hints: dict = field(default_factory=dict)
    source: str | None = None
    prompt: dict | None = None  # local templates: {label, hint, required} for the prompt box
    examples: list[str] = field(default_factory=list)  # prompts that are known to work
    tips: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    inputs: list[dict] = field(default_factory=list)  # what each image/video slot is for: {slot, label, hint}
    data: dict | None = None  # the template file as loaded (local templates)
    path: Path | None = None
    origin: str = "shipped"  # shipped (in the package) | user (the user's templates folder)
    edited: bool = False  # a user file overrides a shipped template with the same id
    cover: Path | None = None  # poster the template ships with; the user can override it
    cover_video: Path | None = None  # optional short loop shown over the poster
    size: dict | None = None  # how inputs are cropped and sized before the run (see prep.py)
    default_prompt: str = ""  # what the prompt box opens with
    default_inputs: dict[str, Path] = field(default_factory=dict)  # sample media each slot opens with, by slot


def role_sentences(inputs: list[dict]) -> str:
    """'Image 1 is the character. Video 1 is the motion.'"""
    out = []
    for i in inputs:
        kind, _, n = i["slot"].partition(":")
        phrase = ROLE_PHRASE.get(i.get("role", ""), f"the {i.get('role', 'reference')}")
        out.append(f"{kind.capitalize()} {n} is {phrase}.")
    return " ".join(out)


def box_rows(boxes: list[dict]) -> list[dict]:
    """FLUX 3 edit rows. Boxes arrive as fractions; FLUX wants [ymin, xmin, ymax, xmax] in 0..1000."""

    def conv(b):
        if not b:
            return None
        x, y, w, h = (float(v) for v in b)
        q = lambda v: max(0, min(1000, round(v * 1000)))
        return [q(y), q(x), q(y + h), q(x + w)]

    rows = []
    for n, b in enumerate(boxes, start=1):
        src = conv(b.get("rect"))
        rows.append(
            {
                "id": f"box_{n}",
                "from": b.get("from") or "image_1",
                "src_bbox": src,
                "tgt_bbox": conv(b.get("target")) or src,
                "desc": b.get("label", "").strip(),
            }
        )
    return rows


def prompt_with_boxes(prompt: str, boxes: list[dict]) -> str:
    rows = box_rows([b for b in boxes if b.get("label", "").strip()])
    if not rows:
        return prompt
    return f"{prompt.rstrip()}\n{json.dumps(rows, separators=(', ', ': '))}"


# ---- request builders -----------------------------------------------------


def _images(inputs):
    return [i for i in inputs if i["slot"].startswith("image:")]


def _videos(inputs):
    return [i for i in inputs if i["slot"].startswith("video:")]


def build_generic(spec: dict) -> dict:
    """Any model: the schema form's values, plus prompt and media where the
    schema has obvious fields for them. The Raw tab covers the rest."""
    body = dict(spec.get("params", {}))
    if spec.get("prompt"):
        body.setdefault("prompt", spec["prompt"])
    imgs = _images(spec["inputs"])
    if imgs and "images" not in body and "image" not in body and "image_url" not in body:
        body["images"] = ["{{%s}}" % i["slot"] for i in imgs]
    vids = _videos(spec["inputs"])
    if vids and "video" not in body and "video_url" not in body:
        body["video_url"] = "{{video:1}}"
    return body


# ---- local workflow templates --------------------------------------------------

SEED_TOKEN = "{{seed:random}}"

_CASTS: dict[str, Callable[[Any], Any]] = {
    "int": lambda v: int(float(v)),
    "float": lambda v: float(v),
    "str": lambda v: str(v),
    "bool": lambda v: bool(v),
    # A side length in pixels → megapixels of a square that size.
    "megapixels": lambda v: round(float(v) ** 2 / 1_000_000, 3),
}

# Inputs a node can lose without becoming invalid, when what fed them is pruned.
_OPTIONAL_LINKS = {"last_frame", "first_frame", "audio", "mask", "negative"}


def build_local(e: "Engine", spec: dict) -> dict:
    """Write the studio's fields into the template's workflow.

    Media slots the user didn't fill are pruned along with every node that
    only existed to load them, so one template serves one to N references.
    """
    wf = copy.deepcopy(e.workflow or {})
    p = spec.get("params", {})
    slots = {i["slot"] for i in spec.get("inputs", [])}
    for key, targets in e.bindings.items():
        cast_ok = True
        if key == "prompt":
            value: Any = prompt_with_boxes(spec.get("prompt", ""), spec.get("boxes", []))
        elif key.startswith("params."):
            name = key[len("params."):]
            if name not in p:
                continue
            value = p[name]
            if name == "seed" and (value in (None, "") or int(value) < 0):
                value, cast_ok = SEED_TOKEN, False
        elif key in ("size.width", "size.height"):  # the prepared output size, for workflows that make their own canvas
            value = (spec.get("size_px") or {}).get(key[len("size."):])
            if value is None:
                continue
        elif ":" in key:  # a media slot
            value, cast_ok = ("{{%s}}" % key if key in slots else None), False
        else:
            continue
        for t in targets:
            node = wf.get(str(t[0]))
            if node is None:
                continue
            if value is None:
                node["_prune"] = True
                continue
            cast = _CASTS.get(t[2]) if cast_ok and len(t) > 2 else None
            node["inputs"][t[1]] = cast(value) if cast else value
    return prune(wf)


def prune(wf: dict) -> dict:
    gone = {nid for nid, n in wf.items() if n.get("_prune")}
    changed = True
    while changed:
        changed = False
        for nid, n in wf.items():
            if nid in gone:
                continue
            for k, v in list(n.get("inputs", {}).items()):
                if not (_is_link(v) and v[0] in gone):
                    continue
                if "." in k or k in _OPTIONAL_LINKS:  # autogrow slot or optional input
                    del n["inputs"][k]
                else:  # a required input lost its source
                    gone.add(nid)
                    changed = True
                    break
    return {nid: {k: v for k, v in n.items() if k != "_prune"} for nid, n in wf.items() if nid not in gone}


def _is_link(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def load_template(data: dict, base: Path | None = None) -> "Engine":
    if data.get("format") != "openillusion.template":
        raise ValueError("not a openillusion.template")
    tid = data["id"]
    if not tid.startswith("local/"):
        tid = "local/" + tid
    e = Engine(
        id=tid, mode=data.get("mode", "edit"), label=data.get("label", tid), provider=data.get("provider", "local"),
        blurb=data.get("blurb", ""), max_images=int(data.get("max_images", 1)), min_images=int(data.get("min_images", 0)),
        needs_video=bool(data.get("needs_video", False)),
        video_window=tuple(data["video_window"]) if data.get("video_window") else None,
        fps_window=tuple(data.get("fps_window") or (1.0, 60.0)),
        params=data.get("params", []), curated=True, kind="local",
        workflow=data["workflow"], bindings=data.get("bindings", {}), outputs=[str(o) for o in data.get("outputs", [])],
        hints=data.get("hints", {}), source=data.get("source"), prompt=data.get("prompt"),
        examples=list(data.get("examples", [])), tips=list(data.get("tips", [])), tags=list(data.get("tags", [])),
        inputs=list(data.get("inputs", [])),
        cover=(base / data["cover"]) if base and data.get("cover") else None,
        cover_video=(base / data["cover_video"]) if base and data.get("cover_video") else None,
        size=prep.spec_of(data.get("size")),
        default_prompt=str((data.get("defaults") or {}).get("prompt") or ""),
        default_inputs={str(k): (base / v) for k, v in ((data.get("defaults") or {}).get("inputs") or {}).items()} if base else {},
    )
    e.build = lambda spec, _e=e: build_local(_e, spec)
    return e


def template_dirs() -> list[Path]:
    return [paths.templates_dir(), paths.user_root() / "templates"]


def load_templates() -> dict[str, "Engine"]:
    """Shipped templates, then the user's folder; a user file with the same id overrides."""
    out: dict[str, Engine] = {}
    shipped, user = template_dirs()
    for d, origin in ((shipped, "shipped"), (user, "user")):
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                data = json.loads(f.read_text("utf-8"))
                e = load_template(data, base=f.parent)
            except (ValueError, KeyError) as ex:
                log.warning("OpenIllusion: skipped template %s: %s", f.name, ex)
                continue
            e.data, e.path, e.origin = data, f, origin
            e.edited = origin == "user" and e.id in out and out[e.id].origin == "shipped"
            out[e.id] = e
    return out


# ---- editing templates ---------------------------------------------------------
# Edits never touch the shipped file: the whole template is written to the user's
# templates folder, which overrides it by id. Resetting deletes that copy.

_TEXT_LIMIT = {"label": 80, "blurb": 400, "prompt_label": 40, "prompt_hint": 160, "instruction": 2000, "item": 240, "default_prompt": 400}


def _clean(v: Any, limit: int) -> str:
    if not isinstance(v, str):
        raise ValueError("expected text")
    v = v.strip()
    if len(v) > limit:
        raise ValueError(f"keep it under {limit} characters")
    return v


def _clean_list(v: Any, n: int = 20) -> list[str]:
    if not isinstance(v, list) or len(v) > n:
        raise ValueError(f"expected a list of up to {n} items")
    return [x for x in (_clean(i, _TEXT_LIMIT["item"]) for i in v) if x]


def instruction_of(e: Engine) -> dict | None:
    """The fixed text wrapped around the user's prompt, for templates that declare where it lives."""
    where = (e.data or {}).get("instruction")
    if not where or not e.workflow:
        return None
    try:
        return {k: e.workflow[str(n)]["inputs"][inp] for k, (n, inp) in where.items()}
    except (KeyError, TypeError, ValueError):
        return None


def edit_template(engine_id: str, patch: dict) -> Engine:
    e = ENGINES.get(engine_id)
    if e is None or e.kind != "local" or e.data is None or e.path is None:
        raise KeyError(engine_id)
    data = copy.deepcopy(e.data)
    if "label" in patch:
        data["label"] = _clean(patch["label"], _TEXT_LIMIT["label"]) or data["label"]
    if "blurb" in patch:
        data["blurb"] = _clean(patch["blurb"], _TEXT_LIMIT["blurb"])
    for k in ("tags", "examples", "tips"):
        if k in patch:
            data[k] = _clean_list(patch[k])
    if isinstance(patch.get("prompt"), dict):
        pr = dict(data.get("prompt") or {})
        if "label" in patch["prompt"]:
            pr["label"] = _clean(patch["prompt"]["label"], _TEXT_LIMIT["prompt_label"]) or pr.get("label", "Prompt")
        if "hint" in patch["prompt"]:
            pr["hint"] = _clean(patch["prompt"]["hint"], _TEXT_LIMIT["prompt_hint"])
        data["prompt"] = pr
    if isinstance(patch.get("instruction"), dict):
        where = data.get("instruction") or {}
        for k, v in patch["instruction"].items():
            if k not in where:
                raise ValueError(f"this template has no {k!r} instruction")
            if not isinstance(v, str) or len(v) > _TEXT_LIMIT["instruction"]:
                raise ValueError(f"keep the instruction under {_TEXT_LIMIT['instruction']} characters")
            n, inp = where[k]
            data["workflow"][str(n)]["inputs"][inp] = v  # untrimmed: spaces at the joins are part of the sentence
    if "default_prompt" in patch:
        data["defaults"] = {**(data.get("defaults") or {}), "prompt": _clean(patch["default_prompt"], _TEXT_LIMIT["default_prompt"])}
    # Media the template ships with stays where it is.
    for k in ("cover", "cover_video"):
        if data.get(k):
            data[k] = str((e.path.parent / data[k]).resolve())
    if (data.get("defaults") or {}).get("inputs"):
        data["defaults"]["inputs"] = {k: str((e.path.parent / v).resolve()) for k, v in data["defaults"]["inputs"].items()}
    dst = e.path if e.origin == "user" else paths.user_root() / "templates" / (re.sub(r"[^A-Za-z0-9._-]+", "__", e.id) + ".json")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    reload_templates()
    return ENGINES[e.id]


def reset_template(engine_id: str) -> Engine:
    e = ENGINES.get(engine_id)
    if e is None or not e.edited or e.path is None:
        raise KeyError(engine_id)
    e.path.unlink(missing_ok=True)
    reload_templates()
    return ENGINES[engine_id]


# Templates live in templates/local/*.json (shipped) and the user's templates
# folder. Each one is added after it has been run end to end; any other Router
# model is still reachable through ``get`` with a form built from its schema.
ENGINES: dict[str, Engine] = {}


def reload_templates() -> None:
    for k in [k for k, e in ENGINES.items() if e.kind == "local"]:
        ENGINES.pop(k)
    ENGINES.update(load_templates())


reload_templates()


def get(engine_id: str) -> Engine:
    if engine_id in ENGINES:
        return ENGINES[engine_id]
    if engine_id.startswith("local/"):
        raise KeyError(f"No local template {engine_id!r}")
    return Engine(
        id=engine_id, mode="edit", label=engine_id.split("/", 1)[-1], provider=engine_id.split("/", 1)[0],
        blurb="Any Router model. Form generated from its schema.", max_images=10, build=build_generic, curated=False,
    )


def describe(e: Engine) -> dict:
    return {
        "id": e.id, "mode": e.mode, "label": e.label, "provider": e.provider, "blurb": e.blurb,
        "max_images": e.max_images, "min_images": e.min_images, "needs_video": e.needs_video,
        "video_window": e.video_window, "fps_window": e.fps_window, "url_only": e.url_only,
        "params": e.params, "curated": e.curated, "kind": e.kind, "source": e.source, "prompt": e.prompt,
        "examples": e.examples, "tips": e.tips, "tags": e.tags, "inputs": e.inputs, "requires": requirements(e),
        "instruction": instruction_of(e), "origin": e.origin, "edited": e.edited, "size": e.size,
        "defaults": defaults_info(e),
        **_cover_info(e), "cover_custom": user_cover(e.id).is_file(),
    }


def requirements(e: Engine) -> dict:
    """What a local template needs in ComfyUI: model files by folder, and node types."""
    if e.kind != "local" or not e.workflow:
        return {"models": [], "nodes": []}
    hinted = e.hints.get("models", {})
    models = sorted(
        {(v, hinted.get(v, {}).get("folder", "")) for n in e.workflow.values() for v in n.get("inputs", {}).values()
         if isinstance(v, str) and v.endswith((".safetensors", ".ckpt", ".pt", ".pth", ".gguf"))}
    )
    return {
        "models": [{"name": m, "folder": f, "url": hinted.get(m, {}).get("url")} for m, f in models],
        "nodes": sorted({n["class_type"] for n in e.workflow.values()}),
    }


# ---- covers ------------------------------------------------------------------
# A template's tile in the Library: a poster image, plus an optional short muted
# loop. The user's choice (saved under covers/) wins over the one the template
# ships with; neither is required.

COVER_SIDE = 960
COVER_LOOP_SECONDS = 8.0
_VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}


def user_cover(engine_id: str, ext: str = ".webp") -> Path:
    return paths.user_root() / "covers" / (re.sub(r"[^A-Za-z0-9._-]+", "__", engine_id) + ext)


def cover_files(e: Engine) -> tuple[Path | None, Path | None]:
    """(poster, loop) for this template, either may be missing."""
    own = user_cover(e.id)
    if own.is_file():
        loop = user_cover(e.id, ".mp4")
        return own, loop if loop.is_file() else None
    poster = e.cover if e.cover and e.cover.is_file() else None
    loop = e.cover_video if e.cover_video and e.cover_video.is_file() else None
    return poster, loop


def cover_file(e: Engine, video: bool = False) -> Path | None:
    return cover_files(e)[1 if video else 0]


@functools.lru_cache(maxsize=256)
def _aspect(path: str, _mtime: int) -> float:
    with Image.open(path) as img:
        return round(img.width / max(1, img.height), 4)


@functools.lru_cache(maxsize=256)
def _dims(path: str, _mtime: int) -> tuple[int, int]:
    return media.image_size(path)


def default_input(engine_id: str, slot: str) -> Path:
    """The sample file a template opens a slot with."""
    e = ENGINES.get(engine_id)
    p = e.default_inputs.get(slot) if e else None
    if p is None or not p.is_file():
        raise FileNotFoundError(f"{engine_id} has no sample for {slot}")
    return p


def defaults_info(e: Engine) -> dict:
    """What a template opens with: its prompt, and a sample for each slot that has one.
    Samples are assets like uploads (``tpl:<engine>|<slot>``), so runs and remixes treat them the same."""
    inputs = []
    for slot, p in e.default_inputs.items():
        if not p.is_file():
            continue
        v = p.stat().st_mtime_ns // 1_000_000
        w, h = _dims(str(p), v)
        inputs.append({
            "slot": slot, "asset": f"tpl:{e.id}|{slot}", "name": p.name, "kind": "image", "width": w, "height": h,
            "url": f"/api/templates/input?engine={quote(e.id, safe='')}&slot={quote(slot, safe='')}&v={v}",
        })
    return {"prompt": e.default_prompt, "inputs": inputs}


def _cover_info(e: Engine) -> dict:
    poster, loop = cover_files(e)
    if poster is None:
        return {"cover": None, "cover_video": None, "cover_aspect": None}
    v = poster.stat().st_mtime_ns // 1_000_000
    url = f"/api/cover?engine={quote(e.id, safe='')}&v={v}"
    return {
        "cover": url,
        "cover_video": f"{url}&video=1" if loop else None,
        "cover_aspect": _aspect(str(poster), v),
    }


def set_cover(engine_id: str, src: Path, loop: Path | None = None) -> Path:
    """Make ``src`` this template's cover. A video becomes a short muted loop
    plus its first frame as the poster; ``loop`` adds a loop to an image poster."""
    dst = user_cover(engine_id)
    dst.parent.mkdir(parents=True, exist_ok=True)
    clip = loop or (src if src.suffix.lower() in _VIDEO_EXT else None)
    poster = media.frame_at(src) if src.suffix.lower() in _VIDEO_EXT else media.open_image(src)
    mp4 = user_cover(engine_id, ".mp4")
    if clip is None:
        mp4.unlink(missing_ok=True)
    else:
        tmp = mp4.with_suffix(".tmp.mp4")
        media.transcode(clip, tmp, end=COVER_LOOP_SECONDS, max_height=720, max_bytes=4 * 1024 * 1024,
                        min_fps=1, keep_audio=False)
        tmp.replace(mp4)
    return media.save_webp(poster, dst, max_side=COVER_SIDE)


def clear_cover(engine_id: str) -> None:
    user_cover(engine_id).unlink(missing_ok=True)
    user_cover(engine_id, ".mp4").unlink(missing_ok=True)


def compose(spec: dict) -> dict:
    """Studio state → request template plus warnings. Never rewrites the prompt."""
    e = get(spec["engine"])
    warnings: list[dict] = []
    imgs, vids = _images(spec["inputs"]), _videos(spec["inputs"])
    if len(imgs) > e.max_images:
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} takes at most {e.max_images} images"})
    given = {i.get("slot") for i in imgs}
    named = [i for i in (e.inputs or [])[: e.min_images] if i.get("slot") and i.get("label")]
    if named:
        # Templates say which input is missing, in their own words.
        for i in named:
            if i["slot"] not in given:
                label = i["label"].lower()
                warnings.append({"field": "inputs", "level": "error", "text": f"Add {'an' if label[:1] in 'aeiou' else 'a'} {label}"})
    elif len(imgs) < e.min_images:
        n = e.min_images
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} needs at least {n} image{'' if n == 1 else 's'}"})
    if e.needs_video and not vids:
        warnings.append({"field": "video", "level": "error", "text": "Add a driving video"})
    if e.video_window:
        for v in vids:
            d = v.get("trimmed_duration") or v.get("duration")
            if d and not (e.video_window[0] - 0.05 <= d <= e.video_window[1] + 0.05):
                warnings.append({"field": "video", "level": "error", "text": f"Trim the clip to {e.video_window[0]:g}–{e.video_window[1]:g} s (now {d:.1f} s)"})
    if e.url_only:
        for i in spec["inputs"]:
            if not i.get("url"):
                warnings.append({"field": i["slot"], "level": "error", "text": f"{e.label} takes public URLs only. Add a link for {i['slot']}."})
    prompt_required = (e.prompt or {}).get("required", True)
    if not spec.get("prompt", "").strip() and e.curated and prompt_required:  # raw Router models may not need one
        warnings.append({"field": "prompt", "level": "error", "text": "Write a prompt"})
    if spec.get("raw"):
        template = spec["raw"]
    else:
        template = e.build(spec) if e.build else build_generic(spec)
    return {"template": template, "warnings": warnings, "role_sentences": role_sentences(spec["inputs"])}


def materialize(template: Any, resolve: Callable[[str, int, str], str]) -> Any:
    """Replace whole-string media tokens. ``resolve(kind, n, form)``."""

    def walk(v):
        if isinstance(v, str):
            m = TOKEN.match(v)
            if m:
                return resolve(m.group(1), int(m.group(2)), m.group(3) or "uri")
            return v
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v

    return walk(copy.deepcopy(template))


def tokens_in(template: Any) -> list[tuple[str, int, str]]:
    found = []

    def walk(v):
        if isinstance(v, str):
            m = TOKEN.match(v)
            if m:
                found.append((m.group(1), int(m.group(2)), m.group(3) or "uri"))
        elif isinstance(v, list):
            for x in v:
                walk(x)
        elif isinstance(v, dict):
            for x in v.values():
                walk(x)

    walk(template)
    return found


def file_resolver(inputs: list[dict], base: Path) -> Callable[[str, int, str], str]:
    """Resolve tokens from files on disk (``inputs[*].file`` relative to base)."""
    by_slot = {i["slot"]: i for i in inputs}

    def resolve(kind: str, n: int, form: str) -> str:
        item = by_slot.get(f"{kind}:{n}")
        if not item:
            raise KeyError(f"{kind}:{n} is referenced in the request but has no input")
        if form == "url":
            if not item.get("url"):
                raise KeyError(f"{kind}:{n} needs a public URL for this engine")
            return item["url"]
        path = base / item["file"]
        if kind == "image":
            uri, b64 = media.image_payload(path)
            return b64 if form == "b64" else uri
        mime = {"video": "video/mp4", "audio": "audio/mpeg"}[kind]
        return media.file_data_uri(path, mime)

    return resolve


# ---- results --------------------------------------------------------------

VIDEO_EXT = (".mp4", ".webm", ".mov")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")


def classify_failure(result: Any) -> dict | None:
    """Provider-native failure inside a 200 body (H3 task.status, Higgsfield status)."""
    if not isinstance(result, dict):
        return None
    task = result.get("task")
    if isinstance(task, dict) and task.get("status") in ("failed", "cancelled", "expired"):
        err = task.get("error") or {}
        return {"error_type": "provider_failed", "message": err.get("message") or f"Task {task['status']}"}
    st = result.get("status")
    if st == "nsfw":
        return {"error_type": "content_policy_violation", "message": "The provider declined this request."}
    if st in ("failed", "canceled"):
        return {"error_type": "provider_failed", "message": result.get("error") or f"Request {st}"}
    return None


def find_assets(result: Any) -> list[str]:
    """Every downloadable URL in a native result, best guesses first."""
    preferred: list[str] = []
    others: list[str] = []

    def walk(v, key=""):
        if isinstance(v, str):
            if v.startswith(("http://", "https://")):
                low = v.split("?", 1)[0].lower()
                if key in ("sample", "url") or low.endswith(VIDEO_EXT + IMAGE_EXT):
                    preferred.append(v)
                elif key not in ("status_url", "cancel_url", "response_url"):
                    others.append(v)
        elif isinstance(v, list):
            for x in v:
                walk(x, key)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, k)

    walk(result)
    seen, out = set(), []
    for u in preferred + others:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def result_seed(result: Any) -> int | None:
    if isinstance(result, dict):
        r = result.get("result")
        if isinstance(r, dict) and isinstance(r.get("seed"), int):
            return r["seed"]
        t = result.get("task")
        if isinstance(t, dict) and isinstance(t.get("seed"), int):
            return t["seed"]
    return None
