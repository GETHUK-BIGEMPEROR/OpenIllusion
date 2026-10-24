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
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from . import media, paths

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
    prompt: dict | None = None  # local templates: {label, hint} for the prompt box


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


def build_h3(spec: dict) -> dict:
    p = spec.get("params", {})
    content: list[dict] = [{"type": "text", "text": spec.get("prompt", "")}]
    for i in _images(spec["inputs"]):
        content.append({"type": "image_url", "image_url": {"url": "{{%s}}" % i["slot"]}, "role": "reference_image"})
    # Recast keeps the clip's motion; Swap edits the clip itself (base_video).
    video_role = "base_video" if p.get("motion_mode") == "swap" else "reference_video"
    for v in _videos(spec["inputs"]):
        content.append({"type": "video_url", "video_url": {"url": "{{%s}}" % v["slot"]}, "role": video_role})
    body: dict[str, Any] = {
        "content": content,
        "duration": int(p.get("duration", 8)),
        "resolution": p.get("resolution", "768P"),
    }
    if p.get("ratio") and p["ratio"] != "adaptive":
        body["ratio"] = p["ratio"]
    if p.get("seed") not in (None, "", -1):
        body["seed"] = int(p["seed"])
    if p.get("aigc_watermark"):
        body["aigc_watermark"] = True
    return body


def build_genjutsu(spec: dict) -> dict:
    p = spec.get("params", {})
    body: dict[str, Any] = {
        "video_url": "{{video:1|url}}",
        "image_urls": ["{{%s|url}}" % i["slot"] for i in _images(spec["inputs"])],
        "resolution": p.get("resolution", "720p"),
    }
    if spec.get("prompt"):
        body["prompt"] = spec["prompt"]
    return body


def build_flux3(spec: dict) -> dict:
    p = spec.get("params", {})
    body: dict[str, Any] = {
        "prompt": prompt_with_boxes(spec.get("prompt", ""), spec.get("boxes", [])),
        "aspect_ratio": p.get("aspect_ratio", "auto"),
        "resolution": p.get("resolution", "1k"),
        "grounding": bool(p.get("grounding", False)),
        "safety_tolerance": int(p.get("safety_tolerance", 2)),
    }
    imgs = _images(spec["inputs"])
    if imgs:
        body["images"] = ["{{%s|b64}}" % i["slot"] for i in imgs]
    return body


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


def load_template(data: dict) -> "Engine":
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
    )
    e.build = lambda spec, _e=e: build_local(_e, spec)
    return e


def template_dirs() -> list[Path]:
    return [paths.package_root() / "templates" / "local", paths.user_root() / "templates"]


def load_templates() -> dict[str, "Engine"]:
    out: dict[str, Engine] = {}
    for d in template_dirs():
        if not d.is_dir():
            continue
        for f in sorted(d.glob("*.json")):
            try:
                e = load_template(json.loads(f.read_text("utf-8")))
                out[e.id] = e
            except (ValueError, KeyError) as ex:
                log.warning("OpenIllusion: skipped template %s: %s", f.name, ex)
    return out


SEG = "segmented"

ENGINES: dict[str, Engine] = {
    e.id: e
    for e in [
        Engine(
            id="minimax/minimax-h3",
            mode="motion",
            label="MiniMax H3",
            provider="minimax",
            blurb="Reference-to-video. Keeps the motion of your clip, recasts it from your references. Native stereo audio.",
            max_images=9,
            needs_video=True,
            video_window=(2.0, 15.0),
            params=[
                {"key": "duration", "label": "Duration", "type": "int", "min": 4, "max": 15, "default": 8, "unit": "s"},
                {"key": "resolution", "label": "Resolution", "type": SEG, "options": ["768P", "2K"], "default": "768P"},
                {"key": "ratio", "label": "Aspect", "type": SEG, "options": ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], "default": "adaptive"},
                {"key": "seed", "label": "Seed", "type": "seed", "default": -1},
                {"key": "aigc_watermark", "label": "AIGC watermark", "type": "bool", "default": False},
            ],
            build=build_h3,
        ),
        Engine(
            id="higgsfield/higgsfield-genjutsu-motion-transfer-v1.0",
            mode="motion",
            label="Genjutsu Motion Transfer",
            provider="higgsfield",
            blurb="Higgsfield's motion-transfer model. Takes public URLs only, so each input needs a link.",
            max_images=8,
            min_images=1,
            needs_video=True,
            video_window=(4.0, 30.0),
            url_only=True,
            params=[
                {"key": "resolution", "label": "Resolution", "type": SEG, "options": ["480p", "720p", "1080p"], "default": "720p"},
            ],
            build=build_genjutsu,
        ),
        Engine(
            id="bfl/flux-3-image",
            mode="edit",
            label="FLUX 3",
            provider="bfl",
            blurb="Edit 1–10 images from an instruction. Boxes ride at the end of the prompt as JSON.",
            max_images=10,
            params=[
                {"key": "aspect_ratio", "label": "Aspect", "type": SEG, "options": ["auto", "1:1", "4:5", "3:4", "2:3", "9:16", "16:9", "3:2", "4:3", "21:9"], "default": "auto"},
                {"key": "resolution", "label": "Resolution", "type": SEG, "options": ["768sq", "1k", "1.5k", "2k", "4k"], "default": "1k"},
                {"key": "grounding", "label": "Web grounding", "type": "bool", "default": False},
                {"key": "safety_tolerance", "label": "Safety tolerance", "type": "int", "min": 0, "max": 4, "default": 2},
            ],
            build=build_flux3,
        ),
        Engine(
            id="qwen/qwen-image-3.0", mode="edit", label="Qwen-Image 3.0", provider="qwen",
            blurb="Form generated from the model's Router schema.", max_images=4, build=build_generic, curated=False,
        ),
        Engine(
            id="google/nano-banana-2", mode="edit", label="Nano Banana 2", provider="google",
            blurb="Form generated from the model's Router schema.", max_images=10, build=build_generic, curated=False,
        ),
        Engine(
            id="openai/gpt-image-2.5-sunburst", mode="edit", label="GPT Image 2.5", provider="openai",
            blurb="Form generated from the model's Router schema.", max_images=10, build=build_generic, curated=False,
        ),
        Engine(
            id="byteplus/seedream-5-0-260128", mode="edit", label="Seedream 5", provider="byteplus",
            blurb="Form generated from the model's Router schema.", max_images=10, build=build_generic, curated=False,
        ),
        Engine(
            id="kling/kling-image-o1", mode="edit", label="Kling Image O1", provider="kling",
            blurb="Form generated from the model's Router schema.", max_images=10, build=build_generic, curated=False,
        ),
        Engine(
            id="bria/image-edit-relight", mode="edit", label="Bria Relight", provider="bria",
            blurb="Utility. Form generated from the model's Router schema.", max_images=1, build=build_generic, curated=False,
        ),
        Engine(
            id="bria/image-edit-replace-background", mode="edit", label="Bria Replace background", provider="bria",
            blurb="Utility. Form generated from the model's Router schema.", max_images=1, build=build_generic, curated=False,
        ),
    ]
}


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
    }


def compose(spec: dict) -> dict:
    """Studio state → request template plus warnings. Never rewrites the prompt."""
    e = get(spec["engine"])
    warnings: list[dict] = []
    imgs, vids = _images(spec["inputs"]), _videos(spec["inputs"])
    if len(imgs) > e.max_images:
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} takes at most {e.max_images} images"})
    if len(imgs) < e.min_images:
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} needs at least {e.min_images} image"})
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
    if not spec.get("prompt", "").strip() and (e.id in ("minimax/minimax-h3", "bfl/flux-3-image") or e.kind == "local"):
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
