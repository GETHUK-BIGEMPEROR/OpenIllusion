"""Drafts waiting to be saved, and writing the template file from what the author picked."""

from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import shutil
from pathlib import Path
from typing import Any

from .. import adapters, paths, prep
from .workflow import BuildError
from .analysis import output_kind, result_nodes, _label, _int_widget


# ---- drafts -------------------------------------------------------------------
# An analyzed workflow waits in the cache under a content hash until it's saved.

def _drafts() -> Path:
    d = paths.cache_dir() / "builder"
    d.mkdir(parents=True, exist_ok=True)
    return d


def put_draft(api: dict, source: str) -> str:
    blob = json.dumps(api, sort_keys=True).encode()
    token = hashlib.sha256(blob).hexdigest()[:20]
    (_drafts() / f"{token}.json").write_text(json.dumps({"workflow": api, "source": source}), "utf-8")
    return token


def get_draft(token: str) -> dict:
    if not re.fullmatch(r"[0-9a-f]{20}", token or ""):
        raise BuildError("Unknown draft")
    f = _drafts() / f"{token}.json"
    if not f.exists():
        raise BuildError("This draft expired. Drop the workflow again.")
    return json.loads(f.read_text("utf-8"))


# ---- assembling a template ----------------------------------------------------

TEXT_MAX = {"label": 80, "blurb": 400, "default_prompt": 4000}
PARAM_TYPES = {"int", "number", "bool", "seed", "select", "segmented", "string"}
CASTS = {"int": "int", "seed": "int", "number": "float", "bool": "bool", "string": "str"}


def slugify(s: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:48] or "template"


def _txt(v: Any, limit: int, field: str) -> str:
    if v is None:
        return ""
    if not isinstance(v, str):
        raise BuildError(f"{field} should be text")
    v = v.strip()
    if len(v) > limit:
        raise BuildError(f"Keep {field} under {limit} characters")
    return v


def _param(p: dict, key: str) -> dict:
    t = p.get("type")
    if t not in PARAM_TYPES:
        raise BuildError(f"Unknown control type {t!r}")
    out: dict[str, Any] = {"key": key, "label": _txt(p.get("label"), 40, "a control label") or _label(key), "type": t}
    if t == "select" and len(p.get("options") or []) <= 5:
        out["type"] = "segmented"
    for k in ("min", "max", "step"):
        if isinstance(p.get(k), (int, float)) and not isinstance(p.get(k), bool):
            out[k] = p[k]
    d = p.get("default")
    if t in ("select", "segmented"):
        # The workflow's own values, numbers kept as numbers (a length in seconds goes in as one).
        out["options"] = [o if isinstance(o, (int, float)) and not isinstance(o, bool) else str(o) for o in p.get("options") or []][:60]
        if not out["options"]:
            raise BuildError(f"{out['label']} has no options")
        d = next((o for o in out["options"] if str(o) == str(d)), None if d is None else str(d))
    out["default"] = -1 if t == "seed" else d
    if isinstance(p.get("unit"), str) and p["unit"].strip():
        out["unit"] = _txt(p["unit"], 12, "a unit")
    if p.get("help"):
        out["help"] = _txt(p["help"], 240, "help")
    return out


def media_rows(rows: list[dict]) -> list[dict]:
    out, n = [], {}
    for r in rows:
        kind = r.get("kind")
        if kind not in ("image", "video", "audio"):
            raise BuildError("Media inputs are image, video or audio")
        n[kind] = n.get(kind, 0) + 1
        out.append({**r, "slot": f"{kind}:{n[kind]}"})
    return out


def _common(spec: dict, media: list[dict]) -> dict:
    """The template file without its bindings: details, then one input per media row and the prompt.
    The assemblers add where each input goes (``bind``) and the settings."""
    label = _txt(spec.get("label"), TEXT_MAX["label"], "the name")
    if not label or not label.split(" · ")[0].strip():
        raise BuildError("Give the template a name")
    videos = [m for m in media if m["kind"] == "video"]
    mode = spec.get("mode") if spec.get("mode") in ("edit", "motion") else ("motion" if videos else "edit")
    fields: list[dict[str, Any]] = []
    for m in media:
        f: dict[str, Any] = {"key": m["slot"], "type": m["kind"], "required": bool(m.get("required", True))}
        if m["kind"] == "video":  # limits only when the author sets them; else the workflow's loader decides
            for k, top, what in (("window", 600, "clip length"), ("fps", 240, "frame rate")):
                v = m.get(k)
                if not v:
                    continue
                try:
                    lo, hi = float(v[0]), float(v[1])
                except (TypeError, ValueError, IndexError):
                    raise BuildError(f"The {what} is two numbers, lowest and highest") from None
                if not 0 < lo <= hi <= top:
                    raise BuildError(f"The {what} runs from more than 0 up to {top}")
                f[k] = [lo, hi]
        fields.append(f)
    pr = spec.get("prompt") or None
    if pr:
        f = {"key": "prompt", "type": "text", "required": bool(pr.get("required", True)),
             "default": _txt(pr.get("default"), TEXT_MAX["default_prompt"], "the default prompt")}
        fields.append(f)
    return {
        "format": "openillusion.template",
        "version": 2,
        "mode": mode,
        "label": label,
        "blurb": _txt(spec.get("blurb"), TEXT_MAX["blurb"], "the description"),
        "inputs": fields,
        "built": True,
    }


def _input(data: dict, key: str) -> dict:
    return next(f for f in data["inputs"] if f["key"] == key)


def _kind(v: Any) -> str:
    return "bool" if isinstance(v, bool) else "number" if isinstance(v, (int, float)) else "text" if isinstance(v, str) else "other"


def assemble_local(spec: dict, draft: dict, info: dict) -> dict:
    api = copy.deepcopy(draft["workflow"])
    media = media_rows(spec.get("media") or [])
    data = _common(spec, media)
    for m in media:
        n = api.get(str(m.get("node")))
        if n is None or m.get("input") not in n["inputs"]:
            raise BuildError(f"Node {m.get('node')} isn't in the workflow")
        n["inputs"][m["input"]] = "{{%s}}" % m["slot"]
        _input(data, m["slot"])["bind"] = [[str(m["node"]), m["input"]]]
    pr = spec.get("prompt")
    if pr:
        n = api.get(str(pr.get("node")))
        if n is None or pr.get("input") not in n["inputs"]:
            raise BuildError("Pick the text box the prompt goes into")
        f = _input(data, "prompt")
        n["inputs"][pr["input"]] = f["default"]  # the saved workflow reads the same as the template's default
        f["bind"] = [[str(pr["node"]), pr["input"]]]
    for f in spec.get("fixed") or []:  # settings changed but not shown to the user
        n = api.get(str(f.get("node")))
        if n is None or f.get("input") not in n["inputs"] or isinstance(n["inputs"][f["input"]], list):
            raise BuildError(f"Node {f.get('node')} has no setting {f.get('input')!r}")
        old, v = n["inputs"][f["input"]], f.get("value")
        if _kind(old) != _kind(v):
            raise BuildError(f"{f['input']} expects {_kind(old)}")
        n["inputs"][f["input"]] = v
    keys: set[str] = set()
    for p in spec.get("params") or []:
        n = api.get(str(p.get("node")))
        if n is None or p.get("input") not in n["inputs"]:
            raise BuildError(f"Node {p.get('node')} isn't in the workflow")
        key = re.sub(r"[^a-z0-9_]", "_", (p.get("key") or p["input"]).lower()).strip("_") or "param"
        base, i = key, 2
        while key in keys:
            key, i = f"{base}_{i}", i + 1
        keys.add(key)
        row = _param({**p, "default": p.get("default", n["inputs"][p["input"]])}, key)
        cast = CASTS.get(row["type"])
        if row["type"] in ("select", "segmented"):
            nums = [o for o in row["options"] if not isinstance(o, str)]
            cast = "str" if len(nums) < len(row["options"]) else "int" if all(isinstance(o, int) for o in nums) else "float"
            if isinstance(n["inputs"][p["input"]], float) and cast == "int":
                cast = "float"  # whole seconds into a float input
        data["inputs"].append({**row, "advanced": row["type"] == "seed", "bind": [[str(p["node"]), p["input"]] + ([cast] if cast else [])]})
    sz = spec.get("size")
    if sz:
        data["inputs"].append(_size_input(api, {**sz, "mode": data["mode"]}))
        taken = {(str(sz.get("node")), k) for k in ("width", "height")}
        if any((str(p.get("node")), p.get("input")) in taken for p in spec.get("params") or []):
            raise BuildError("Width and height go with the output size; take them out of the settings")
    # The node whose image or video a run keeps. The graph stays as it is: every output node still runs.
    results = [r["node"] for r in result_nodes(api, info)]
    outs = [str(o) for o in spec.get("outputs") or results[:1]]
    if not outs or any(o not in results for o in outs):
        raise BuildError("Pick the node whose image or video a run keeps")
    # Photo or video is what the result node writes, not something the author picks.
    data["mode"] = "motion" if output_kind(api, outs[0], info) == "video" else "edit"
    data.update(kind="local", provider="local", outputs=outs, workflow=api,
                source=_txt(spec.get("source"), 200, "the source") or "Built in OpenIllusion from a ComfyUI workflow",
                hints={"models": {}, "nodes": {}})
    return data


def _size_input(api: dict, sz: dict) -> dict:
    """A declared output size: the node it sets width and height on, the shape and step it opens at.
    Without either, they're read from the node: the nearest shape and step to what it holds now."""
    nid = str(sz.get("node"))
    n = api.get(nid)
    if n is None or not all(_int_widget(n["inputs"].get(k)) for k in ("width", "height")):
        raise BuildError("The output size goes to a node with a width and a height")
    w, h = n["inputs"]["width"], n["inputs"]["height"]
    steps = [s["label"] for s in prep.spec_of(None, [], sz.get("mode") or "edit")["options"] if s["px"]]
    aspect = sz.get("aspect") if sz.get("aspect") in prep.ASPECTS else min(
        prep.ASPECTS, key=lambda a: abs(math.log((w / h) / (float(a.split(":")[0]) / float(a.split(":")[1])))))
    default = sz.get("default") if sz.get("default") in steps else min(steps, key=lambda s: abs(math.log(w * h / 1e6 / float(s.split()[0]))))
    return {"key": "size", "type": "size", "label": _txt(sz.get("label"), 40, "the size label") or "Output size",
            "aspect": aspect, "default": default, "bind": [[nid, "width", "width"], [nid, "height", "height"]]}


def assemble_cloud(spec: dict) -> dict:
    """A Router template from the model's adapter, frozen to the files this run uses.

    ``spec.media`` rows name the adapter input each file goes to (``input``), in the
    order the Builder shows them. Inputs left empty aren't in the template: every
    input it has is required, so it always asks the model for the same job.
    ``spec.settings``: ``{key, value, locked}`` for the model's settings this job asks
    for (shape, resolution, length, sound…). Each goes into the request at its value;
    one not locked also becomes an input people change in Create, after the prompt."""
    try:
        a = adapters.get(str(spec.get("model") or ""))
    except adapters.AdapterError as e:
        raise BuildError(str(e)) from None
    media = media_rows([{**m, "required": True} for m in spec.get("media") or []])
    for m in media:
        i = m.get("input")
        if not isinstance(i, int) or not 0 <= i < len(a.inputs) or a.inputs[i]["type"] != m["kind"]:
            raise BuildError(f"{a.name} has no such {m['kind']} input")
    pr = spec.get("prompt") or {}
    data = _common({**spec, "mode": a.mode, "prompt": {**pr, "required": True}}, media)
    prompt = _input(data, "prompt")
    if not prompt["default"]:
        raise BuildError("Write the prompt the first run uses")
    chosen = {x["key"]: x for x in spec.get("settings") or [] if isinstance(x, dict) and isinstance(x.get("key"), str)}
    on = adapters.settings_for(a, [a.inputs[m["input"]]["role"] for m in media])
    values = {s["key"]: chosen.get(s["key"], {}).get("value", adapters.setting_default(s)) for s in on}
    for s in on:
        if not adapters.setting_ok(s, values[s["key"]]):
            raise BuildError(f"{s['label']}: pick one of {a.name}'s options")
    try:
        body, where, model = adapters.assemble(a, [(m["input"], m["slot"]) for m in media], prompt["default"], values)
    except adapters.AdapterError as e:
        raise BuildError(str(e)) from None
    for m in media:
        _input(data, m["slot"])["bind"] = [where[m["slot"]]]
    prompt["bind"] = [list(a.prompt)]
    slots = {a.inputs[m["input"]]["role"]: m["slot"] for m in reversed(media)}  # a role's first file
    data["inputs"] += [adapters.setting_field(s, values[s["key"]], slots) for s in on if not chosen.get(s["key"], {}).get("locked")]
    for s in on:  # fixed at "keep the clip's sound": every run's result takes it
        ks = s.get("keep_sound")
        if ks and chosen.get(s["key"], {}).get("locked") and values[s["key"]] == ks["option"]:
            data["keep_sound"] = slots[ks["role"]]
    data.update(kind="cloud", model=model, provider=model.split("/", 1)[0], body=body, result=a.result,
                source=f"Comfy Router · {a.name}",
                locked=[s["key"] for s in on if chosen.get(s["key"], {}).get("locked")])  # fixed in the body, not asked
    return data


def preset(e) -> dict:
    """How a template built from ``e`` starts: its inputs, prompt and controls as ``e`` has them,
    keyed by the node and input they write to, so the builder can match them to the workflow."""
    def at(f: dict) -> dict:
        b = (f.get("bind") or [[None, None]])[0]
        return {"node": str(b[0]), "input": b[1]}

    keep = ("label", "hint", "required")
    media = [{**at(f), "slot": f["key"], **{k: f[k] for k in (*keep, "window", "fps") if k in f}} for f in e.fields if f["type"] in ("image", "video", "audio")]
    text = next((f for f in e.fields if f["key"] == "prompt"), None)
    prompt = {**at(text), **{k: text[k] for k in keep if k in text}, "default": e.default_prompt} if text else None
    # A control the workflow doesn't read (Sound, put on after the run) has no node to match: the copy goes without it.
    params = [{**at(f), "key": f["key"], "label": f.get("label") or _label(f["key"]), "default": f.get("default"), "help": f.get("help"),
               **{k: f[k] for k in ("type", "options", "unit", "min", "max", "step") if k in f}}
              for f in e.fields if f["type"] not in ("image", "video", "audio", "size") and f["key"] != "prompt" and f.get("bind")]
    out = next((f for f in e.fields if f["type"] == "size"), None)
    size = {"node": str(out["bind"][0][0]), **{k: out[k] for k in ("label", "aspect", "default") if k in out}} if out else None
    name, _, rest = e.label.partition(" · ")
    return {"base": e.id, "label": f"{name} (copy)" + (f" · {rest}" if rest else ""), "blurb": e.blurb,
            "mode": e.mode, "media": media, "prompt": prompt, "params": params, "size": size, "outputs": list(e.outputs)}


def cloud_preset(e) -> dict:
    """How a Router template built from cloud template ``e`` starts: the model's inputs its files fill,
    its prompt, and each setting at its value (one the template doesn't ask for is locked there).
    Read off ``e``'s request: each file's place holds one adapter input's value, and a locked
    setting's place holds what that setting writes."""
    a = adapters.for_model(e.model or "")
    if a is None:
        raise BuildError(f"{e.model} has no adapter here, so the Builder can't open it")

    def at(body, path):
        for k in path:
            try:
                body = body[k]
            except (KeyError, IndexError, TypeError):
                return None
        return body
    body = e.body or {}
    media = []
    for f in e.fields:
        if f["type"] in ("image", "video", "audio") and f.get("bind"):
            held = at(body, f["bind"][0])
            i = next((n for n, x in enumerate(a.inputs) if x["type"] == f["type"] and adapters.fill(x["value"], f["key"]) == held), None)
            if i is None:
                raise BuildError(f"{f.get('label') or f['key']} fills none of {a.name}'s inputs")
            media.append({"slot": f["key"], "kind": f["type"], "input": i})
    files = [(m["input"], m["slot"]) for m in media]
    asked = {f["key"]: f for f in e.fields}
    on = adapters.settings_for(a, [a.inputs[m["input"]]["role"] for m in media])

    def shown(s):
        f = asked.get("size" if s["type"] == "size" else s["key"])
        if not f:
            return None
        return {"aspect": f.get("aspect"), "size": f.get("default")} if s["type"] == "size" else f.get("default")
    values = {s["key"]: shown(s) if shown(s) is not None else adapters.setting_default(s) for s in on}
    locked = [s for s in on if shown(s) is None]
    for s in locked:
        want = [at(body, p) for p in adapters.setting_paths(s)]
        for v in _choices(s):
            try:
                out, _, _ = adapters.assemble(a, files, "", {**values, s["key"]: v})
            except adapters.AdapterError:
                continue
            if [at(out, p) for p in adapters.setting_paths(s)] == want:
                values[s["key"]] = v
                break
    name, _, rest = e.label.partition(" · ")
    return {"kind": "cloud", "base": e.id, "model": a.model, "label": f"{name} (copy)" + (f" · {rest}" if rest else ""),
            "blurb": e.blurb, "mode": e.mode, "media": media,
            "prompt": {"default": e.default_prompt},
            "settings": {s["key"]: {"value": values[s["key"]], "locked": s in locked} for s in on}}


def _choices(s: dict) -> list:
    """Every value a setting can take, to find the one a request holds."""
    if s["type"] == "size":
        return [{"aspect": x, "size": f"{y:g} MP"} for x in s.get("aspects") or [] for y in s.get("steps") or []]
    if s["type"] == "bool":
        return [False, True]
    if s["type"] == "int":
        return list(range(s["min"], s["max"] + 1, s.get("step") or 1))[:2000]
    return list(s.get("options") or [s.get("default")])


def inherit(data: dict, base: dict, base_label: str) -> None:
    """A template built from another keeps what the builder doesn't show: the multiple its inputs are
    trimmed to and its model hints."""
    if (base.get("size") or {}).get("multiple"):
        data["size"] = {"multiple": base["size"]["multiple"]}
    if base.get("hints"):
        data["hints"] = copy.deepcopy(base["hints"])
    data["source"] = f"Built in OpenIllusion from {base_label}"


def save(data: dict, samples: dict[str, Path], replace: str | None = None, taken: set[str] = frozenset()) -> str:
    """Write a built template to the user's templates folder. Returns its id.

    A new template is on Explore at once, with no cover until one of its results is made its cover.
    Rebuilding a template keeps the cover it has."""
    kind = data["kind"]
    root = paths.user_root() / "templates"
    root.mkdir(parents=True, exist_ok=True)
    if replace:
        tid = replace
        slug = tid.split("/", 1)[1]
        old = root / f"{kind}__{slug}.json"
        if old.is_file():
            prev = json.loads(old.read_text("utf-8"))
            data.update({k: prev[k] for k in ("cover", "cover_video") if prev.get(k)})
    else:
        base = slugify(data["label"])
        slug, i = base, 2
        while (root / f"{kind}__{slug}.json").exists() or f"{kind}/{slug}" in taken:
            slug, i = f"{base}-{i}", i + 1
        tid = f"{kind}/{slug}"
    data["id"] = tid
    media_dir = root / "media" / f"{kind}__{slug}"
    if samples:
        media_dir.mkdir(parents=True, exist_ok=True)
    for slot, src in samples.items():
        dst = media_dir / f"sample-{slot.replace(':', '-')}{src.suffix.lower()}"
        shutil.copyfile(src, dst)
        _input(data, slot)["default"] = dst.relative_to(root).as_posix()
    paths.write_atomic(root / f"{kind}__{slug}.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    return tid
