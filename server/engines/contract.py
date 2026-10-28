"""The template contract: the Engine record and reading template files into one."""

from __future__ import annotations

import copy
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from .. import paths, prep
from .build import MEDIA, build_local, build_cloud


log = logging.getLogger("openillusion")


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
    tips: list[str] = field(default_factory=list)
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
    keep_sound: str | None = None  # cloud templates: the clip whose own sound every result takes (a fixed "Keep the clip's")

    def __post_init__(self):
        if self.size is None:
            slots = self.inputs or [{"slot": f"image:{n}"} for n in range(1, max(self.max_images, 1) + 1)] + ([{"slot": "video:1"}] if self.needs_video else [])
            self.size = prep.spec_of(None, slots, self.mode)


# ---- template files ------------------------------------------------------------
# A template lists everything a run takes in ``inputs``, in the order the studio shows it:
# photos and clips, the prompt, and settings. Each entry says what it is (``type``), how it
# is presented (label, hint, default, …) and where its value goes (``bind``: node inputs of
# the workflow, or paths into a cloud body). Nothing is written into the request that isn't
# one of these inputs, so the prompt box holds the whole prompt the model reads.

# An ``aspect`` is a choice of shapes (Create shows them as frames); ``size`` is a shape and a step written as pixels.
FIELD_TYPES = {*MEDIA, "text", "string", "int", "number", "bool", "seed", "select", "segmented", "aspect", "size"}
_PARAM_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def upgrade(data: dict) -> dict:
    """A template file in the current format (version 2).

    Version 1 kept media slots, the prompt and settings apart, bindings in their own map,
    and could hide fixed text around the prompt (``instruction`` nodes or ``prompt_wrap``).
    That text is folded into the prompt's default here, so it stays visible
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
    d.pop("examples", None)  # prompt ideas: gone, the default prompt is the one to start from
    if "prompt" in binds and not pr.get("hidden"):
        wrapped = bool(start or end)
        f = {"key": "prompt", "type": "text", "label": "Prompt" if wrapped else pr.get("label") or "Prompt"}
        if pr.get("hint") and not wrapped:
            f["hint"] = pr["hint"]
        f["required"] = True if wrapped else bool(pr.get("required", True))
        f["default"] = f"{start}{defaults.get('prompt') or ''}{end}"
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


def _field(f: Any) -> dict:
    if not isinstance(f, dict) or f.get("type") not in FIELD_TYPES or not isinstance(f.get("key"), str):
        raise ValueError(f"bad input {f!r:.80}")
    key, t = f["key"], f["type"]
    if t in MEDIA:
        if not re.fullmatch(rf"{t}:\d+", key):
            raise ValueError(f"a {t} input's key is {t}:<n>, not {key!r}")
    elif t == "size":
        # A workflow's: [node, input, width|height]. A cloud body's: [path, width|height|text] ("text": "WxH" in one field).
        local = lambda b: len(b) == 3 and b[2] in ("width", "height")
        cloud = lambda b: len(b) == 2 and isinstance(b[0], list) and b[1] in ("width", "height", "text")
        if key != "size" or not f.get("bind") or not all(local(b) or cloud(b) for b in f["bind"]):
            raise ValueError("a size input is keyed size and binds [node, input, width|height] or [path, width|height|text]")
    elif not (key == "prompt" or _PARAM_KEY.match(key)) or re.match(r"^(image|video|audio)$", key):
        raise ValueError(f"bad input key {key!r}")
    out = {**f, "bind": [list(b) for b in f.get("bind") or []]}
    # A photo or clip is named by its place ("Image 1"), the prompt is "Prompt": the prompt says what each one is.
    if t in MEDIA:
        for k in ("hint", "role", "area"):
            out.pop(k, None)
        out["label"] = f"{t.capitalize()} {key.split(':')[1]}"
    elif key == "prompt":
        out.pop("hint", None)
        out["label"] = "Prompt"
    out.setdefault("label", key)
    out.pop("examples", None)  # files made when the prompt had ideas: the default prompt is the one to start from
    return out


def _model_settings(data: dict, fields: list[dict]) -> list[dict]:
    """A cloud template saved before models had settings: the ones its job asks for, at the
    model's defaults. Each file's role is the adapter input whose value its place in the body holds."""
    from .. import adapters

    a = adapters.for_model(data["model"])
    if a is None or not a.settings:
        return []
    def at(body: Any, path: list) -> Any:
        for k in path:
            try:
                body = body[k]
            except (KeyError, IndexError, TypeError):
                return None
        return body
    slots: dict[str, str] = {}
    for f in fields:
        if f["type"] in MEDIA and f["bind"]:
            held = at(data.get("body") or {}, f["bind"][0])
            for r in [i["role"] for i in a.inputs if adapters.fill(i["value"], f["key"]) == held][:1]:
                slots.setdefault(r, f["key"])
    return [_field(adapters.setting_field(s, adapters.setting_default(s), slots)) for s in adapters.settings_for(a, list(slots))]


SHIPPED = "shipped:"


def media_path(base: Path, ref: str) -> Path:
    """A template's sample or cover: relative to the template file, or ``shipped:<path>``, a file
    under the shipped ``templates/`` folder (an edited shipped template keeps using its media)."""
    if ref.startswith(SHIPPED):
        return paths.templates_dir().parent / ref[len(SHIPPED):]
    return base / ref


def shipped_ref(base: Path, rel: str) -> str:
    """How a user file names a shipped template's media: the same on every install, wherever it lives."""
    return SHIPPED + (base / rel).resolve().relative_to(paths.templates_dir().parent.resolve()).as_posix()


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
    # Saved before models had settings: no setting asked and none fixed ("locked" is newer).
    if cloud and "locked" not in data and not any(f["type"] not in MEDIA and f["key"] != "prompt" for f in fields):
        fields += _model_settings(data, fields)
    if len({f["key"] for f in fields}) != len(fields):
        raise ValueError("two inputs share a key")
    media = [f for f in fields if f["type"] in MEDIA]
    clips = {f["key"] for f in media if f["type"] == "video"}
    keep = data.get("keep_sound") if cloud else None
    if keep is not None and keep not in clips or any(f["keep_sound"]["slot"] not in clips for f in fields if f.get("keep_sound")):
        raise ValueError("keep_sound names one of the template's clips")
    images = [f for f in media if f["type"] == "image"]
    video = next((f for f in media if f["type"] == "video"), None)
    text = next((f for f in fields if f["key"] == "prompt"), None)
    out = next((f for f in fields if f["type"] == "size"), None)
    bindings = {}
    for f in fields:
        bindings[f["key"] if f["type"] in (*MEDIA, "size") or f["key"] == "prompt" else f"params.{f['key']}"] = f["bind"]
    slots = [{"slot": f["key"], "label": f["label"], **({"size": f["size"]} if f.get("size") else {})} for f in media]
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
        result=[list(p) for p in result] if cloud else [], keep_sound=keep,
        hints=data.get("hints", {}), source=data.get("source"),
        prompt={k: text[k] for k in ("label", "required") if k in text} if text else None,
        inputs=slots, fields=fields,
        cover=media_path(base, data["cover"]) if base and data.get("cover") else None,
        cover_video=media_path(base, data["cover_video"]) if base and data.get("cover_video") else None,
        size=prep.spec_of(data.get("size"), slots, data.get("mode", "edit"), out),
        default_prompt=str(text.get("default") or "") if text else "",
        default_inputs={f["key"]: media_path(base, f["default"]) for f in media if f.get("default")} if base else {},
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
