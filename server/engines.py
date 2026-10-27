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
import random
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable
from urllib.parse import quote

from PIL import Image

from . import media, paths, prep, settings

log = logging.getLogger("openillusion")

# A media slot inside a cloud body. The form says how the file goes in: a data URI (uri), bare
# base64 (b64), a public link (url), or just its MIME type (mime), for bodies that name it beside the bytes.
TOKEN = re.compile(r"^\{\{(image|video|audio):(\d+)(?:\|(uri|b64|url|mime))?\}\}$")

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
    prompt: dict | None = None  # {label, hint, required} of the template's prompt input, if it has one
    examples: list[dict] = field(default_factory=list)  # prompts known to work: {label, text}
    tips: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    inputs: list[dict] = field(default_factory=list)  # the media inputs: {slot, label, hint, size, role}
    fields: list[dict] = field(default_factory=list)  # every input the template takes, in order (see load_template)
    data: dict | None = None  # the template file as loaded (local templates)
    path: Path | None = None
    origin: str = "shipped"  # shipped (in the package) | user (the user's templates folder)
    edited: bool = False  # a user file overrides a shipped template with the same id
    cover: Path | None = None  # poster the template ships with; the user can override it
    cover_video: Path | None = None  # optional short loop shown over the poster
    size: dict | None = None  # how each input is cropped and sized before the run, and a declared output size (see prep.py); filled in for every engine
    default_prompt: str = ""  # what the prompt box opens with
    default_inputs: dict[str, Path] = field(default_factory=dict)  # sample media each slot opens with, by slot
    model: str | None = None  # cloud templates: the Router model the body is sent to
    body: dict | None = None  # cloud templates: the request body, with media tokens and fixed values
    result: list[list] = field(default_factory=list)  # cloud templates: where the media is in the model's output, first match wins
    built: bool = False  # made in the template builder

    def __post_init__(self):
        if self.size is None:
            slots = self.inputs or [{"slot": f"image:{n}"} for n in range(1, max(self.max_images, 1) + 1)] + ([{"slot": "video:1"}] if self.needs_video else [])
            self.size = prep.spec_of(None, slots, self.mode)


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


def boxes_in_crop(boxes: list[dict], crop) -> list[dict]:
    """Boxes are drawn on the whole photo; once it is cropped they are placed in the kept part."""
    if not crop:
        return boxes
    cx, cy, cw, ch = (float(v) for v in crop)
    clamp = lambda v: max(0.0, min(1.0, v))

    def move(r):
        if not r:
            return r
        x, y, w, h = (float(v) for v in r)
        x0, y0 = clamp((x - cx) / cw), clamp((y - cy) / ch)
        x1, y1 = clamp((x + w - cx) / cw), clamp((y + h - cy) / ch)
        return [x0, y0, x1 - x0, y1 - y0]

    return [{**b, "rect": move(b.get("rect")), "target": move(b.get("target"))} for b in boxes]


def prompt_with_boxes(prompt: str, boxes: list[dict], crop=None) -> str:
    rows = box_rows([b for b in boxes_in_crop(boxes, crop) if b.get("label", "").strip()])
    if not rows:
        return prompt
    return f"{prompt.rstrip()}\n{json.dumps(rows, separators=(', ', ': '))}"


def _lead_crop(spec: dict):
    return next((i.get("crop") for i in spec.get("inputs", []) if i.get("slot") == "image:1"), None)


# ---- request builders -----------------------------------------------------


def _images(inputs):
    return [i for i in inputs if i["slot"].startswith("image:")]


def _videos(inputs):
    return [i for i in inputs if i["slot"].startswith("video:")]


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
            value: Any = spec.get("prompt", "")  # sent exactly as written
        elif key.startswith("params."):
            name = key[len("params."):]
            if name not in p:
                continue
            value = p[name]
            if name == "seed" and (value in (None, "") or int(value) < 0):
                value, cast_ok = SEED_TOKEN, False
        elif key == "size":  # a declared output size: the shape and step picked, as width and height
            dims = prep.canvas_size(run_size(e), p.get("aspect"), p.get("out_size"))
            for node, inp, side in (t for t in targets if str(t[0]) in wf):
                wf[str(node)]["inputs"][inp] = dims[0] if side == "width" else dims[1]
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
    reroll(wf)
    return prune(wf)


def reroll(wf: dict) -> dict:
    """Numbers the workflow marks "randomize" (or increment/decrement) after each generate
    get a new value per run, the way ComfyUI does when you queue it; "fixed" ones stay."""
    for n in wf.values():
        for name, mode in ((n.get("_meta") or {}).get("control_after_generate") or {}).items():
            if mode != "fixed" and isinstance(n["inputs"].get(name), int) and not isinstance(n["inputs"][name], bool):
                n["inputs"][name] = random.randrange(2**31)
    return wf


def defaults_workflow(e: "Engine", every_input: bool = False) -> dict:
    """A local template's workflow with its defaults written in: the default prompt, each control
    at its default and a fixed seed. Media slots keep their ``{{slot}}`` tokens (see fill_media).
    Inputs without a sample are pruned unless ``every_input``."""
    if e.kind != "local" or not e.workflow:
        raise KeyError(e.id)
    params = {p["key"]: p.get("default") for p in e.params if p.get("default") is not None}
    for p in e.params:
        if p.get("type") == "seed" and int(params.get(p["key"], -1)) < 0:
            params[p["key"]] = random.randrange(2**31)
    slots = [i["slot"] for i in e.inputs] if every_input else list(e.default_inputs)
    return build_local(e, {"inputs": [{"slot": s} for s in slots], "prompt": e.default_prompt, "params": params})


def fill_media(wf: dict, names: dict[str, str]) -> dict:
    """Swap each ``{{slot}}`` token for a file name in ComfyUI's input folder."""
    for n in wf.values():
        for k, v in n.get("inputs", {}).items():
            if isinstance(v, str) and v.startswith("{{") and v[2:-2] in names:
                n["inputs"][k] = names[v[2:-2]]
    return wf


def build_cloud(e: "Engine", spec: dict) -> dict:
    """A cloud template's body with the studio's fields written in.

    Bindings are paths into the body. Media slots left empty are removed;
    an array field that ends up empty is dropped.
    """
    body = copy.deepcopy(e.body or {})
    p = spec.get("params", {})
    slots = {i["slot"] for i in spec.get("inputs", [])}
    drop: list[list] = []
    for key, targets in e.bindings.items():
        if key == "prompt":
            value: Any = spec.get("prompt", "")
        elif key.startswith("params."):
            name = key[len("params."):]
            if name not in p:
                continue
            value = p[name]
            if name == "seed" and (value in (None, "") or int(value) < 0):
                value = random.randint(0, 2**31 - 1)
        elif ":" in key:
            if key in slots:
                continue  # the token is already in the body
            drop.extend(targets)
            continue
        else:
            continue
        for path in targets:
            _set(body, path, value)
    # Highest indices first, so earlier positions stay valid.
    for path in sorted(drop, key=lambda t: [str(x) if isinstance(x, str) else f"{x:08d}" for x in t], reverse=True):
        _unset(body, path)
        parent = path[:-1]
        while parent and _at(body, parent) in ([], {}):  # an emptied list or object goes too
            _unset(body, parent)
            parent = parent[:-1]
    for k in [k for k, v in body.items() if v == []]:
        del body[k]
    return body


def _at(body: Any, path: list) -> Any:
    try:
        for k in path:
            body = body[k]
        return body
    except (KeyError, IndexError, TypeError):
        return None


def _set(body: Any, path: list, value: Any) -> None:
    cur = body
    for k in path[:-1]:
        cur = cur[k]
    cur[path[-1]] = value


def _unset(body: Any, path: list) -> None:
    try:
        cur = body
        for k in path[:-1]:
            cur = cur[k]
        if isinstance(cur, list):
            cur.pop(path[-1])
        else:
            cur.pop(path[-1], None)
    except (KeyError, IndexError, TypeError):
        pass


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


# ---- template files ------------------------------------------------------------
# A template lists everything a run takes in ``inputs``, in the order the studio shows it:
# photos and clips, the prompt, and settings. Each entry says what it is (``type``), how it
# is presented (label, hint, default, …) and where its value goes (``bind``: node inputs of
# the workflow, or paths into a cloud body). Nothing is written into the request that isn't
# one of these inputs, so the prompt box holds the whole prompt the model reads.

MEDIA = ("image", "video", "audio")
FIELD_TYPES = {*MEDIA, "text", "string", "int", "number", "bool", "seed", "select", "segmented", "size"}
_PARAM_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def upgrade(data: dict) -> dict:
    """A template file in the current format (version 2).

    Version 1 kept media slots, the prompt and settings apart, bindings in their own map,
    and could hide fixed text around the prompt (``instruction`` nodes or ``prompt_wrap``).
    That text is folded into the prompt's default and examples here, so it stays visible
    and editable; the hidden copy in the workflow is emptied.
    """
    if int(data.get("version") or 1) >= 2:
        return data
    d = copy.deepcopy(data)
    binds = d.pop("bindings", None) or {}
    defaults = d.pop("defaults", None) or {}
    samples = defaults.get("inputs") or {}
    max_images, min_images = int(d.pop("max_images", 1)), int(d.pop("min_images", 0))
    needs_video = bool(d.pop("needs_video", False))
    window, fps = d.pop("video_window", None), d.pop("fps_window", None)
    d.pop("video_max_height", None)  # clips are sized like photos now
    named = d.pop("inputs", None) or [{"slot": f"image:{n}"} for n in range(1, max_images + 1)] + ([{"slot": "video:1"}] if needs_video else [])
    fields: list[dict] = []
    n_img = 0
    for i in named:
        kind, _, n = i["slot"].partition(":")
        f: dict[str, Any] = {"key": i["slot"], "type": kind, "label": i.get("label") or f"{kind.capitalize()} {n}"}
        if kind == "image":
            n_img += 1
            f["required"] = n_img <= min_images
        elif kind == "video":
            f["required"] = needs_video
            f.update({k: v for k, v in (("window", window), ("fps", fps)) if v})
        f.update({k: i[k] for k in ("hint", "size", "role") if i.get(k)})
        if samples.get(i["slot"]):
            f["default"] = samples[i["slot"]]
        f["bind"] = binds.get(i["slot"], [])
        fields.append(f)

    pr = d.pop("prompt", None) or {}
    wrap = d.pop("prompt_wrap", None) or {}
    instr = d.pop("instruction", None) or {}
    start, end = wrap.get("start", ""), wrap.get("end", "")
    for part, (nid, inp) in instr.items() if not wrap and d.get("workflow") else ():
        node = d["workflow"].get(str(nid))
        if node is not None and isinstance(node["inputs"].get(inp), str):
            if part == "start":
                start = node["inputs"][inp]
            elif part == "end":
                end = node["inputs"][inp]
            node["inputs"][inp] = ""
    examples = d.pop("examples", None) or []
    if "prompt" in binds and not pr.get("hidden"):
        wrapped = bool(start or end)
        f = {"key": "prompt", "type": "text", "label": "Prompt" if wrapped else pr.get("label") or "Prompt"}
        if pr.get("hint") and not wrapped:
            f["hint"] = pr["hint"]
        f["required"] = True if wrapped else bool(pr.get("required", True))
        f["default"] = f"{start}{defaults.get('prompt') or ''}{end}"
        if examples:
            f["examples"] = [{"label": x, "text": f"{start}{x}{end}"} if wrapped else x for x in examples]
        f["bind"] = binds["prompt"]
        fields.append(f)
    for p in d.pop("params", None) or []:
        fields.append({**p, "advanced": p.get("advanced", True), "bind": binds.get(f"params.{p['key']}", [])})
    computed = {k: v for k, v in binds.items() if k.startswith("size.")}
    if computed:
        d["computed"] = computed
    d["inputs"], d["version"] = fields, 2
    return d


def lift_computed(data: dict) -> dict:
    """Older files wrote an output size through ``computed`` bindings and kept its shape and
    step in the size block. That is a declared ``size`` input now; a file that still has the
    old form gets one, with the same nodes."""
    comp = data.get("computed") or {}
    if not comp or any(f.get("type") == "size" for f in data.get("inputs") or []):
        return data
    d = copy.deepcopy(data)
    comp = d.pop("computed")
    size = d.get("size") or {}
    bind = [[str(t[0]), t[1], side] for side in ("width", "height") for t in comp.get(f"size.{side}") or []]
    if bind:
        f = {"key": "size", "type": "size", "label": "Output size", "bind": bind}
        f.update({k: size.pop(k) for k in ("aspect", "aspects", "default") if k in size})
        d["inputs"] = [*(d.get("inputs") or []), f]
    size.pop("follows", None)
    return d


def _examples(v: Any) -> list[dict]:
    """Prompt ideas: plain strings, or {label, text} when the chip shows a short name for a long prompt."""
    out = []
    for x in v or []:
        if isinstance(x, str) and x.strip():
            out.append({"label": x.strip(), "text": x})
        elif isinstance(x, dict) and isinstance(x.get("text"), str) and x["text"].strip():
            out.append({"label": str(x.get("label") or x["text"]).strip(), "text": x["text"]})
    return out


def _field(f: Any) -> dict:
    if not isinstance(f, dict) or f.get("type") not in FIELD_TYPES or not isinstance(f.get("key"), str):
        raise ValueError(f"bad input {f!r:.80}")
    key, t = f["key"], f["type"]
    if t in MEDIA:
        if not re.fullmatch(rf"{t}:\d+", key):
            raise ValueError(f"a {t} input's key is {t}:<n>, not {key!r}")
    elif t == "size":
        if key != "size" or not f.get("bind") or any(len(b) != 3 or b[2] not in ("width", "height") for b in f["bind"]):
            raise ValueError("a size input is keyed size and binds [node, input, width|height]")
    elif not (key == "prompt" or _PARAM_KEY.match(key)) or re.match(r"^(image|video|audio)$", key):
        raise ValueError(f"bad input key {key!r}")
    out = {**f, "bind": [list(b) for b in f.get("bind") or []]}
    # A photo or clip is named by its place ("Image 1"), the prompt is "Prompt": the prompt says what each one is.
    if t in MEDIA:
        for k in ("hint", "size", "role", "area"):
            out.pop(k, None)
        out["label"] = f"{t.capitalize()} {key.split(':')[1]}"
    elif key == "prompt":
        out.pop("hint", None)
        out["label"] = "Prompt"
    out.setdefault("label", key)
    if "examples" in f:
        out["examples"] = _examples(f["examples"])
    return out


def load_template(data: dict, base: Path | None = None) -> "Engine":
    if data.get("format") != "openillusion.template":
        raise ValueError("not a openillusion.template")
    data = lift_computed(upgrade(data))
    cloud = data.get("kind") == "cloud"
    tid = data["id"]
    prefix = "cloud/" if cloud else "local/"
    if not tid.startswith(prefix):
        tid = prefix + tid
    if cloud and not data.get("model"):
        raise ValueError("a cloud template names its model")
    result = data.get("result") or []
    if not isinstance(result, list) or not all(isinstance(p, list) and p and all(isinstance(k, (str, int)) for k in p) for p in result):
        raise ValueError("result: a list of paths into the model's output")
    # Every template has a title: Explore, Create and the Library show it.
    if not isinstance(data.get("label"), str) or not data["label"].split(" · ")[0].strip():
        raise ValueError("a template needs a label (its title)")
    fields = [_field(f) for f in data.get("inputs") or []]
    if len({f["key"] for f in fields}) != len(fields):
        raise ValueError("two inputs share a key")
    media = [f for f in fields if f["type"] in MEDIA]
    images = [f for f in media if f["type"] == "image"]
    video = next((f for f in media if f["type"] == "video"), None)
    text = next((f for f in fields if f["key"] == "prompt"), None)
    out = next((f for f in fields if f["type"] == "size"), None)
    bindings = {}
    for f in fields:
        bindings[f["key"] if f["type"] in (*MEDIA, "size") or f["key"] == "prompt" else f"params.{f['key']}"] = f["bind"]
    slots = [{"slot": f["key"], "label": f["label"]} for f in media]
    e = Engine(
        id=tid, mode=data.get("mode", "edit"), label=data["label"].strip(), provider=data.get("provider", "local"),
        blurb=data.get("blurb", ""), max_images=len(images), min_images=sum(1 for f in images if f.get("required", True)),
        needs_video=bool(video and video.get("required", True)),
        video_window=tuple(video["window"]) if video and video.get("window") else None,
        fps_window=tuple(video.get("fps") or (1.0, 60.0)) if video else (1.0, 60.0),
        params=[{k: v for k, v in f.items() if k != "bind"} for f in fields if f["type"] not in (*MEDIA, "size") and f["key"] != "prompt"],
        curated=True, kind="cloud" if cloud else "local",
        workflow=None if cloud else data["workflow"], bindings=bindings, outputs=[str(o) for o in data.get("outputs", [])],
        model=data.get("model") if cloud else None, body=data.get("body") if cloud else None, built=bool(data.get("built")),
        result=[list(p) for p in result] if cloud else [],
        hints=data.get("hints", {}), source=data.get("source"),
        prompt={k: text[k] for k in ("label", "required") if k in text} if text else None,
        examples=text.get("examples", []) if text else [], tags=list(data.get("tags", [])),
        inputs=slots, fields=fields,
        cover=(base / data["cover"]) if base and data.get("cover") else None,
        cover_video=(base / data["cover_video"]) if base and data.get("cover_video") else None,
        size=prep.spec_of(data.get("size"), slots, data.get("mode", "edit"), out),
        default_prompt=str(text.get("default") or "") if text else "",
        default_inputs={f["key"]: (base / f["default"]) for f in media if f.get("default")} if base else {},
    )
    e.build = (lambda spec, _e=e: build_cloud(_e, spec)) if cloud else (lambda spec, _e=e: build_local(_e, spec))
    return e


def template_dirs() -> list[Path]:
    """Shipped local and cloud templates, then the user's folder."""
    return [paths.templates_dir(), paths.cloud_templates_dir(), paths.user_root() / "templates"]


def load_templates() -> dict[str, "Engine"]:
    """Shipped templates, then the user's folder; a user file with the same id overrides."""
    out: dict[str, Engine] = {}
    *shipped, user = template_dirs()
    for d, origin in [*((s, "shipped") for s in shipped), (user, "user")]:
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

_TEXT_LIMIT = {"label": 80, "blurb": 400, "item": 240, "text": 4000, "examples": 12}


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


def _edit_input(f: dict, ch: Any) -> None:
    """The prompt's default and ideas. Photos and clips have nothing to edit here: they're named by their place."""
    if not isinstance(ch, dict):
        raise ValueError("expected an object per input")
    if ("default" in ch or "examples" in ch) and f["type"] != "text":
        raise ValueError(f"{f.get('label') or f['key']}: only the prompt takes a default and ideas")
    if "default" in ch:
        f["default"] = _clean(ch["default"], _TEXT_LIMIT["text"])
    if "examples" in ch:
        if not isinstance(ch["examples"], list) or len(ch["examples"]) > _TEXT_LIMIT["examples"]:
            raise ValueError(f"up to {_TEXT_LIMIT['examples']} ideas")
        rows = []
        for x in ch["examples"]:
            x = x if isinstance(x, dict) else {"text": x}
            text = _clean(x.get("text", ""), _TEXT_LIMIT["text"])
            if text:
                rows.append({"label": _clean(x.get("label") or "", _TEXT_LIMIT["item"]) or text[:60], "text": text})
        f["examples"] = rows


def edit_template(engine_id: str, patch: dict) -> Engine:
    e = ENGINES.get(engine_id)
    if e is None or e.data is None or e.path is None:
        raise KeyError(engine_id)
    data = upgrade(copy.deepcopy(e.data))
    if "label" in patch:
        data["label"] = _clean(patch["label"], _TEXT_LIMIT["label"]) or data["label"]
    if "blurb" in patch:
        data["blurb"] = _clean(patch["blurb"], _TEXT_LIMIT["blurb"])
    if "tags" in patch:
        data["tags"] = _clean_list(patch["tags"])
    data.pop("tips", None)
    if "inputs" in patch:
        if not isinstance(patch["inputs"], dict):
            raise ValueError("inputs: expected an object keyed by input")
        by_key = {f["key"]: f for f in data["inputs"]}
        for key, ch in patch["inputs"].items():
            if key not in by_key:
                raise ValueError(f"this template has no input {key!r}")
            _edit_input(by_key[key], ch)
    # Media the template ships with stays where it is; a user file is rewritten in place.
    if e.origin != "user":
        for k in ("cover", "cover_video"):
            if data.get(k):
                data[k] = str((e.path.parent / data[k]).resolve())
        for f in data["inputs"]:
            if f.get("type") in MEDIA and f.get("default"):
                f["default"] = str((e.path.parent / f["default"]).resolve())
    dst = e.path if e.origin == "user" else paths.user_root() / "templates" / (re.sub(r"[^A-Za-z0-9._-]+", "__", e.id) + ".json")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    reload_templates()
    return ENGINES[e.id]


def delete_template(engine_id: str) -> None:
    """Remove a template made in the builder, with its media and custom cover."""
    e = ENGINES.get(engine_id)
    if e is None or not e.built or e.origin != "user" or e.edited or e.path is None:
        raise KeyError(engine_id)
    import shutil

    media_dir = e.path.parent / "media" / e.path.stem
    if media_dir.is_dir() and media_dir.parent == e.path.parent / "media":
        shutil.rmtree(media_dir, ignore_errors=True)
    for ext in (".webp", ".mp4"):
        user_cover(e.id, ext).unlink(missing_ok=True)
    e.path.unlink(missing_ok=True)
    reload_templates()


def duplicate_template(engine_id: str) -> Engine:
    """Copy a template into the user's folder as a new one they own: editable, deletable,
    with its samples and cover copied alongside so it never depends on the original."""
    e = ENGINES.get(engine_id)
    if e is None or e.data is None or e.path is None:
        raise KeyError(engine_id)
    import shutil

    data = upgrade(copy.deepcopy(e.data))
    prefix = "cloud/" if e.kind == "cloud" else "local/"
    base = re.sub(r"-copy(-\d+)?$", "", e.id.split("/", 1)[-1])
    n, tid = 1, f"{prefix}{base}-copy"
    while tid in ENGINES:
        n += 1
        tid = f"{prefix}{base}-copy-{n}"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "__", tid)
    root = paths.user_root() / "templates"
    media_dir = root / "media" / stem
    media_dir.mkdir(parents=True, exist_ok=True)

    def take(rel: str) -> str:
        src = (e.path.parent / rel).resolve()
        if not src.is_file():
            return rel
        shutil.copyfile(src, media_dir / src.name)
        return f"media/{stem}/{src.name}"

    data["id"], data["built"] = tid, True
    data["label"] = (e.label.split(" · ")[0] + " (copy)" + (" · " + e.label.split(" · ", 1)[1] if " · " in e.label else ""))[:_TEXT_LIMIT["label"]]
    for k in ("cover", "cover_video"):
        if data.get(k):
            data[k] = take(data[k])
    for f in data.get("inputs") or []:
        if f.get("type") in MEDIA and f.get("default"):
            f["default"] = take(f["default"])
    (root / f"{stem}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    poster, loop = user_cover(e.id), user_cover(e.id, ".mp4")
    for src, dst in ((poster, user_cover(tid)), (loop, user_cover(tid, ".mp4"))):
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
    reload_templates()
    return ENGINES[tid]


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
    for k in [k for k, e in ENGINES.items() if e.data is not None]:
        ENGINES.pop(k)
    ENGINES.update(load_templates())


reload_templates()


def router_model(engine_id: str) -> str:
    """The Router model a cloud engine id sends to: a template's model, else the id itself."""
    e = ENGINES.get(engine_id)
    return e.model if e is not None and e.model else engine_id


def get(engine_id: str) -> Engine:
    if engine_id in ENGINES:
        return ENGINES[engine_id]
    raise KeyError(f"No template {engine_id!r}")


def run_size(e: Engine) -> dict:
    """The engine's size spec under the current cap setting (see prep.limit)."""
    return prep.limit(e.size, bool(settings.load().get("uncap_size")))


def describe(e: Engine) -> dict:
    defaults = defaults_info(e)
    samples = {i["slot"]: i for i in defaults["inputs"]}
    # Every input in order, as the studio draws it. A photo or clip carries its sample as an asset, not a path.
    fields = [{k: v for k, v in f.items() if not (f["type"] in MEDIA and k == "default")} | ({"sample": samples.get(f["key"])} if f["type"] in MEDIA else {})
              for f in e.fields]
    return {
        "id": e.id, "mode": e.mode, "label": e.label, "provider": e.provider, "blurb": e.blurb,
        "max_images": e.max_images, "min_images": e.min_images, "needs_video": e.needs_video,
        "video_window": e.video_window, "fps_window": e.fps_window, "url_only": e.url_only,
        "params": e.params, "curated": e.curated, "kind": e.kind, "source": e.source, "prompt": e.prompt,
        "examples": e.examples, "tags": e.tags, "varies": varies(e), "inputs": e.inputs, "fields": fields, "requires": requirements(e),
        "origin": e.origin, "edited": e.edited, "size": run_size(e), "built": e.built, "model": e.model,
        "defaults": defaults,
        **_cover_info(e), "cover_custom": user_cover(e.id).is_file(), "draft": is_draft(e),
    }


def varies(e: Engine) -> bool:
    """Whether two runs with the same inputs can come out different: the workflow re-rolls a seed
    after each generate (ComfyUI's "randomize"), or the template has a seed setting. Variants need it."""
    if any(p.get("type") == "seed" for p in e.params):
        return True
    return any(m != "fixed" for n in (e.workflow or {}).values()
               for m in ((n.get("_meta") or {}).get("control_after_generate") or {}).values())


def is_draft(e: Engine) -> bool:
    """A built template stays a draft until one of its own results becomes its cover."""
    return e.built and cover_files(e)[0] is None


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
# Covers and samples are cached as immutable. Bump this to make browsers fetch them
# again, e.g. after empty bodies were cached while aiohttp's sendfile was broken on Windows.
CACHE_ERA = "&c=2"
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


@functools.lru_cache(maxsize=64)
def _clip(path: str, _mtime: int) -> dict:
    return media.probe(path)


def default_input(engine_id: str, slot: str) -> Path:
    """The sample file a template opens a slot with."""
    e = ENGINES.get(engine_id)
    p = e.default_inputs.get(slot) if e else None
    if p is None or not p.is_file():
        raise FileNotFoundError(f"{engine_id} has no sample for {slot}")
    return p


def default_poster(engine_id: str, slot: str) -> Path:
    """A still of a sample clip, made once and kept in the cache."""
    src = default_input(engine_id, slot)
    dst = paths.cache_dir() / "samples" / f"{re.sub(r'[^A-Za-z0-9._-]+', '__', engine_id + '|' + slot)}-{src.stat().st_mtime_ns}.webp"
    if not dst.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        media.poster(src, dst)
    return dst


def defaults_info(e: Engine) -> dict:
    """What a template opens with: its prompt, and a sample for each slot that has one.
    Samples are assets like uploads (``tpl:<engine>|<slot>``), so runs and remixes treat them the same."""
    inputs = []
    for slot, p in e.default_inputs.items():
        if not p.is_file():
            continue
        v = p.stat().st_mtime_ns // 1_000_000
        url = f"/api/templates/input?engine={quote(e.id, safe='')}&slot={quote(slot, safe='')}&v={v}{CACHE_ERA}"
        item = {"slot": slot, "asset": f"tpl:{e.id}|{slot}", "name": p.name, "url": url}
        if p.suffix.lower() in _VIDEO_EXT:
            info = _clip(str(p), v)
            item.update(kind="video", width=info["width"], height=info["height"], duration=info["duration"], fps=info["fps"],
                        has_audio=info["has_audio"], poster=f"{url}&poster=1")
        else:
            w, h = _dims(str(p), v)
            item.update(kind="image", width=w, height=h)
        inputs.append(item)
    return {"prompt": e.default_prompt, "inputs": inputs}


def _cover_info(e: Engine) -> dict:
    poster, loop = cover_files(e)
    if poster is None:
        return {"cover": None, "cover_video": None, "cover_aspect": None}
    v = poster.stat().st_mtime_ns // 1_000_000
    url = f"/api/cover?engine={quote(e.id, safe='')}&v={v}{CACHE_ERA}"
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


def clip_limits(e: Engine, slot: str) -> tuple[tuple[float, float] | None, tuple[float, float]]:
    """A video input's clip length (None: any) and frame rates: the input's own, else the template's."""
    f = next((f for f in e.fields if f["key"] == slot), None)
    if f is not None:
        return (tuple(f["window"]) if f.get("window") else None), tuple(f.get("fps") or (1.0, 60.0))
    return e.video_window, e.fps_window


def clip_file(slot: str) -> str:
    """Where a generation keeps the clip for a video input: video:1 at driving/driving.mp4, video:2 at driving/driving-2.mp4."""
    n = slot.split(":")[1]
    return "driving/driving.mp4" if n == "1" else f"driving/driving-{n}.mp4"


def poster_file(clip: str) -> str:
    """The poster next to a clip: driving/driving-2.mp4 -> driving/poster-2.webp."""
    return clip.replace("/driving", "/poster", 1).rsplit(".", 1)[0] + ".webp"


def compose(spec: dict) -> dict:
    """Studio state → request template plus warnings. Never rewrites the prompt."""
    e = get(spec["engine"])
    warnings: list[dict] = []
    imgs, vids = _images(spec["inputs"]), _videos(spec["inputs"])
    if len(imgs) > e.max_images:
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} takes at most {e.max_images} images"})
    given = {i.get("slot") for i in spec["inputs"]}
    if e.fields:
        # Which input is missing, by its place: "Add Image 1".
        for f in e.fields:
            if f["type"] in MEDIA and f.get("required", True) and f["key"] not in given:
                warnings.append({"field": "video" if f["type"] == "video" else "inputs", "level": "error", "text": f"Add {f['label']}"})
    elif len(imgs) < e.min_images:
        n = e.min_images
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} needs at least {n} image{'' if n == 1 else 's'}"})
    for v in vids:
        window, _ = clip_limits(e, v["slot"])
        d = v.get("trimmed_duration") or v.get("duration")
        if window and d and not (window[0] - 0.05 <= d <= window[1] + 0.05):
            f = next((f for f in e.fields if f["key"] == v["slot"]), None)
            what = f["label"] if f and len(vids) > 1 else "the clip"
            warnings.append({"field": "video", "level": "error", "text": f"Trim {what} to {window[0]:g}–{window[1]:g} s (now {d:.1f} s)"})
    if e.url_only:
        for i in spec["inputs"]:
            if not i.get("url"):
                warnings.append({"field": i["slot"], "level": "error", "text": f"{e.label} takes public URLs only. Add a link for {i['slot']}."})
    prompt_required = bool(e.prompt and e.prompt.get("required", True))
    if not spec.get("prompt", "").strip() and prompt_required:
        warnings.append({"field": "prompt", "level": "error", "text": "Write a prompt"})
    if spec.get("raw"):
        template = spec["raw"]
    else:
        template = e.build(spec)
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
    encoded: dict[str, str] = {}  # one data URI per slot, however many times the body names it

    def resolve(kind: str, n: int, form: str) -> str:
        slot = f"{kind}:{n}"
        item = by_slot.get(slot)
        if not item:
            raise KeyError(f"{slot} is referenced in the request but has no input")
        if form == "url":
            if not item.get("url"):
                raise KeyError(f"{slot} needs a public URL for this engine")
            return item["url"]
        if slot not in encoded:
            path = base / item["file"]
            encoded[slot] = media.image_payload(path)[0] if kind == "image" else media.file_data_uri(path, {"video": "video/mp4", "audio": "audio/mpeg"}[kind])
        uri = encoded[slot]
        head, _, data = uri.partition(",")
        if form == "mime":
            return head[len("data:"):].split(";", 1)[0]
        return data if form == "b64" else uri

    return resolve


# ---- results --------------------------------------------------------------

VIDEO_EXT = (".mp4", ".webm", ".mov")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")


def classify_failure(result: Any) -> dict | None:
    """Provider-native failure inside a 200 body (H3 task.status, Higgsfield, BFL, Kling, Freepik, WaveSpeed, VEED)."""
    if not isinstance(result, dict):
        return None
    st = result.get("status")
    if st in ("Request Moderated", "Content Moderated"):
        return {"error_type": "content_policy_violation", "message": "The provider declined this request."}
    if st in ("Error", "Task not found"):
        return {"error_type": "provider_failed", "message": str(result.get("details") or st)}
    d = result.get("data")
    if isinstance(d, dict):
        if str(d.get("task_status") or d.get("status") or "").lower() == "failed":
            return {"error_type": "provider_failed", "message": str(d.get("task_status_msg") or d.get("error") or "The provider says the run failed")}
        err = d.get("error")
        if isinstance(err, dict) and err.get("message"):
            return {"error_type": "provider_failed", "message": str(err["message"])}
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


_B64 = re.compile(r"^[A-Za-z0-9+/=\s]{200,}$")
_MAGIC = ((b"\x89PNG", "image/png"), (b"\xff\xd8", "image/jpeg"), (b"GIF8", "image/gif"), (b"\x1aE\xdf\xa3", "video/webm"))


def _walk_path(v: Any, path: list) -> list[tuple[Any, list]]:
    """Every value at ``path`` in ``v``; ``"*"`` stands for any list index."""
    if not path:
        return [(v, [])]
    k, rest = path[0], path[1:]
    if k == "*":
        return [(x, [i, *p]) for i, item in enumerate(v) for x, p in _walk_path(item, rest)] if isinstance(v, list) else []
    if isinstance(v, dict) and isinstance(k, str) and k in v:
        return [(x, [k, *p]) for x, p in _walk_path(v[k], rest)]
    if isinstance(v, list) and isinstance(k, int) and -len(v) <= k < len(v):
        return [(x, [k, *p]) for x, p in _walk_path(v[k], rest)]
    return []


def _media_value(v: Any) -> tuple[str, str] | None:
    if not isinstance(v, str) or not v:
        return None
    if v.startswith(("http://", "https://")):
        return "url", v
    if v.startswith("data:") and ";base64," in v[:100]:
        return "b64", v.split(",", 1)[1]
    if _B64.match(v[:4096]):
        return "b64", v
    return None


def result_media(result: Any, paths_: list[list] | None) -> tuple[str, str, list] | None:
    """The finished media in a native Router result: ("url" | "b64", value, where it was).

    A template names the paths; the first one holding a link or base64 wins. With none
    named, or none of them holds one, any image or video link is taken, then any long
    base64 string."""
    for p in paths_ or []:
        for v, at in _walk_path(result, list(p)):
            hit = _media_value(v)
            if hit:
                return (*hit, at)
    urls = find_assets(result)
    if urls:
        return "url", urls[0], []
    found: list = []

    def walk(v, at):
        if found:
            return
        if isinstance(v, str):
            hit = _media_value(v)
            if hit and hit[0] == "b64":
                found.append((*hit, at))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, [*at, i])
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, [*at, k])

    walk(result, [])
    return found[0] if found else None


def decode_media(b64: str) -> tuple[bytes, str]:
    """Bytes and a content type for base64 media from a result."""
    import base64

    data = base64.b64decode("".join(b64.split()))
    for magic, ctype in _MAGIC:
        if data.startswith(magic):
            return data, ctype
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return data, "image/webp"
    if data[4:8] == b"ftyp":
        return data, "video/mp4"
    return data, "application/octet-stream"


def slim(result: Any) -> Any:
    """A native result with inline media swapped for a note, so it can be kept beside the file."""
    if isinstance(result, str):
        hit = _media_value(result)
        return f"<base64, {len(result) * 3 // 4} bytes>" if hit and hit[0] == "b64" else result
    if isinstance(result, list):
        return [slim(x) for x in result]
    if isinstance(result, dict):
        return {k: slim(x) for k, x in result.items()}
    return result


def result_seed(result: Any) -> int | None:
    if isinstance(result, dict):
        r = result.get("result")
        if isinstance(r, dict) and isinstance(r.get("seed"), int):
            return r["seed"]
        t = result.get("task")
        if isinstance(t, dict) and isinstance(t.get("seed"), int):
            return t["seed"]
    return None
