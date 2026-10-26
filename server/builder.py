"""Template builder: turn a ComfyUI workflow or a Router model into a template.

Local: the user drops a workflow (UI or API JSON, or a PNG/WebP/MP4 ComfyUI
saved, which carries the API graph). UI graphs are converted to API format
against ``/object_info``, subgraphs flattened. ``analyze`` then lists what a
template could expose: media loaders, prompt boxes and widget values.

Cloud: a model's request schema is split the same way: prompt, media fields
and params.

Either way the browser picks what to expose and ``assemble`` writes the
template file. Nothing here runs a workflow or installs anything.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import shutil
from pathlib import Path
from typing import Any

from . import local, paths

MODEL_EXT = local.MODEL_EXT


class BuildError(ValueError):
    pass


# ---- reading ------------------------------------------------------------------

def _is_api(d: Any) -> bool:
    return isinstance(d, dict) and bool(d) and all(isinstance(v, dict) and "class_type" in v for v in d.values())


def _is_ui(d: Any) -> bool:
    return isinstance(d, dict) and isinstance(d.get("nodes"), list) and "links" in d


def _pick(api: Any, ui: Any) -> tuple[dict | None, dict | None]:
    api = api if _is_api(api) else None
    ui = ui if _is_ui(ui) else None
    return api, ui


def _png_chunks(data: bytes) -> dict[str, str]:
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    return {k: v for k, v in (img.info or {}).items() if isinstance(v, str)}


def _webp_chunks(data: bytes) -> dict[str, str]:
    # ComfyUI writes "prompt:{...}" and "workflow:{...}" into EXIF string tags.
    from PIL import Image

    out: dict[str, str] = {}
    exif = Image.open(io.BytesIO(data)).getexif()
    for v in exif.values():
        if isinstance(v, bytes):
            v = v.decode("utf-8", "ignore")
        if isinstance(v, str) and ":" in v:
            k, _, rest = v.partition(":")
            if k in ("prompt", "workflow"):
                out[k] = rest
    return out


def _video_chunks(data: bytes) -> dict[str, str]:
    import av

    with av.open(io.BytesIO(data)) as c:
        meta = dict(c.metadata or {})
    out = {k: v for k, v in meta.items() if k in ("prompt", "workflow")}
    if not out and meta.get("comment"):  # VHS packs both into one JSON comment
        try:
            j = json.loads(meta["comment"])
            out = {k: json.dumps(j[k]) for k in ("prompt", "workflow") if k in j}
        except (ValueError, TypeError):
            pass
    return out


def read_workflow(name: str, data: bytes) -> tuple[dict | None, dict | None]:
    """(api, ui) graphs found in a file. Either may be None; both None raises."""
    ext = Path(name).suffix.lower()
    api = ui = None
    try:
        if ext == ".json" or data[:1] in (b"{", b"["):
            d = json.loads(data.decode("utf-8-sig"))
            if isinstance(d, dict) and _is_api(d.get("prompt")):
                d = d["prompt"]
            if isinstance(d, dict) and _is_api(d.get("output")):
                d = d["output"]
            api, ui = _pick(d, d)
            if not api and not ui:
                raise BuildError("This JSON isn't a ComfyUI workflow. Save it from ComfyUI with Workflow → Save or Export (API).")
        else:
            if ext == ".png" or data[:8] == b"\x89PNG\r\n\x1a\n":
                chunks = _png_chunks(data)
            elif ext == ".webp" or data[8:12] == b"WEBP":
                chunks = _webp_chunks(data)
            elif ext in (".mp4", ".webm", ".mov", ".m4v"):
                chunks = _video_chunks(data)
            else:
                raise BuildError(f"{ext or 'This file'} can't carry a workflow. Use a .json, or a PNG, WebP or MP4 ComfyUI saved.")
            api, ui = _pick(*(json.loads(chunks[k]) if chunks.get(k) else None for k in ("prompt", "workflow")))
            if not api and not ui:
                raise BuildError("No workflow inside this file. ComfyUI only embeds one when it saved the file itself.")
    except (ValueError, UnicodeDecodeError, OSError) as e:
        if isinstance(e, BuildError):
            raise
        raise BuildError(f"Couldn't read {name}: {e}") from e
    return api, ui


# ---- UI graph → API graph -----------------------------------------------------

CONTROL = {"fixed", "increment", "decrement", "randomize"}
FRONTEND_ONLY = {"Note", "MarkdownNote", "Reroute", "PrimitiveNode", "SetNode", "GetNode", "Label (rgthree)"}
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
DYNAMIC_COMBO = "COMFY_DYNAMICCOMBO_V3"


def _spec_inputs(info_node: dict) -> list[tuple[str, list]]:
    inp = info_node.get("input") or {}
    order = info_node.get("input_order") or {}
    out = []
    for sec in ("required", "optional"):
        specs = inp.get(sec) or {}
        for name in order.get(sec) or list(specs):
            if name in specs:
                out.append((name, specs[name]))
    return out


def _opts(spec: Any) -> dict:
    return spec[1] if isinstance(spec, (list, tuple)) and len(spec) > 1 and isinstance(spec[1], dict) else {}


def _is_widget(spec: Any) -> bool:
    if not isinstance(spec, (list, tuple)) or not spec:
        return False
    t, o = spec[0], _opts(spec)
    if o.get("forceInput"):
        return False
    if isinstance(t, list) or t == DYNAMIC_COMBO or o.get("widgetType"):
        return True
    return isinstance(t, str) and all(x in WIDGET_TYPES for x in t.split(","))


def _widget_values(info_node: dict, values: Any) -> tuple[dict, int]:
    """Positional widgets_values → {input: value}. Returns the map and how many values were left over."""
    if isinstance(values, dict):  # some packs save widgets by name
        return {k: v for k, v in values.items() if not isinstance(v, dict)}, 0
    vals = list(values or [])
    out: dict[str, Any] = {}
    i = 0

    def take():
        nonlocal i
        v = vals[i] if i < len(vals) else None
        i += 1
        return v

    def walk(specs: list[tuple[str, list]], prefix: str = ""):
        nonlocal i
        for name, spec in specs:
            if not _is_widget(spec):
                continue
            if i >= len(vals):
                return
            v = take()
            out[prefix + name] = v
            o = _opts(spec)
            if spec[0] == DYNAMIC_COMBO:
                chosen = next((x for x in o.get("options", []) if isinstance(x, dict) and x.get("key") == v), None)
                if chosen:
                    walk(_spec_inputs({"input": chosen.get("inputs") or {}}), f"{prefix}{name}.")
                continue
            seedish = spec[0] == "INT" and (o.get("control_after_generate") or name in ("seed", "noise_seed"))
            if seedish and i < len(vals) and vals[i] in CONTROL:
                i += 1
            if any(k.endswith("_upload") for k in o):  # the upload button and player keep values of their own
                for _ in range(2):
                    if i < len(vals) and (vals[i] in ("image", "video", "audio", "file", "") or vals[i] is None):
                        i += 1

    walk(_spec_inputs(info_node))
    return out, max(0, len(vals) - i)


def _links(raw: list) -> tuple[dict[int, tuple], dict[int, int]]:
    """Link id → (origin, slot), plus output slot → link id for links into a subgraph's output node."""
    links, to_out = {}, {}
    for l in raw:
        if isinstance(l, dict):
            links[l["id"]] = (l["origin_id"], l["origin_slot"])
            if l.get("target_id") == -20:
                to_out[int(l["target_slot"])] = l["id"]
        elif isinstance(l, list) and len(l) >= 5:
            links[l[0]] = (l[1], l[2])
            if l[3] == -20:
                to_out[int(l[4])] = l[0]
    return links, to_out


def ui_to_api(ui: dict, info: dict) -> tuple[dict, list[str]]:
    """Convert a saved UI workflow into the API graph ComfyUI's queue takes.

    Handles subgraphs (flattened to ``outer:inner`` ids, as ComfyUI's own
    export does), reroutes, primitive nodes, Set/Get pairs, and muted or
    bypassed nodes. Returns the graph and notes about anything it guessed.
    """
    notes: list[str] = []
    defs = {sg["id"]: sg for sg in ((ui.get("definitions") or {}).get("subgraphs") or [])}
    nodes: dict[str, dict] = {}  # key → {type, mode, title, inputs: [(name, src, type)], wv}
    alias: dict[tuple[str, int], Any] = {}  # (subgraph instance, output slot) → inner src
    sets: dict[str, Any] = {}  # SetNode name → src

    def flatten(scope_nodes: list, links: dict[int, tuple], prefix: str, outer_inputs: list, depth: int = 0):
        if depth > 8:
            raise BuildError("Subgraphs nest too deep")

        def src_of(link_id):
            if link_id is None or link_id not in links:
                return None
            origin, slot = links[link_id]
            if origin == -10:  # the subgraph's input node
                return outer_inputs[slot] if slot < len(outer_inputs) else None
            return ("n", f"{prefix}{origin}", int(slot))

        for n in scope_nodes:
            key = f"{prefix}{n['id']}"
            ins = [(i.get("name"), src_of(i.get("link")), i.get("type")) for i in (n.get("inputs") or [])]
            t = n.get("type")
            if t in defs:
                sg = defs[t]
                inner_links, to_out = _links(sg.get("links") or [])
                by_name = {name: s for name, s, _ in ins}
                sg_inputs = sg.get("inputs") or []
                mine = [by_name.get(i.get("name")) for i in sg_inputs]
                # Promoted widgets: the instance keeps one value per widget-typed input, in order.
                wv = n.get("widgets_values")
                widget_idx = [k for k, i in enumerate(sg_inputs) if all(x in WIDGET_TYPES for x in str(i.get("type", "")).split(","))]
                if isinstance(wv, list) and len(wv) == len(widget_idx):
                    for k, v in zip(widget_idx, wv):
                        if mine[k] is None:
                            mine[k] = ("c", v)
                if n.get("mode") in (2, 4):  # muted drops it; bypassed passes inputs through by type
                    nodes[key] = {"type": "Subgraph", "mode": n.get("mode"), "title": n.get("title") or sg.get("name"), "inputs": ins,
                                  "wv": None, "outputs": [o.get("type") for o in sg.get("outputs") or []]}
                    continue
                flatten(sg.get("nodes") or [], inner_links, key + ":", mine, depth + 1)
                for j, o in enumerate(sg.get("outputs") or []):
                    # linkIds can go stale; the link into the output node is the truth.
                    lid = next((x for x in o.get("linkIds") or [] if x in inner_links), None) or to_out.get(j)
                    if lid in inner_links:
                        origin, slot = inner_links[lid]
                        alias[(key, j)] = (mine[slot] if slot < len(mine) else None) if origin == -10 else ("n", f"{key}:{origin}", int(slot))
                continue
            nodes[key] = {"type": t, "mode": n.get("mode", 0), "title": n.get("title"), "inputs": ins,
                          "wv": n.get("widgets_values"), "outputs": [o.get("type") for o in n.get("outputs") or []]}
            if t == "SetNode":
                name = (n.get("widgets_values") or [None])[0]
                sets[str(name)] = ins[0][1] if ins else None

    flatten(ui.get("nodes") or [], _links(ui.get("links") or [])[0], "", [])

    def resolve(src, seen=0):
        """Follow aliases, reroutes and bypasses to a real (node, slot) or a constant."""
        while src is not None and seen < 64:
            seen += 1
            if src[0] == "c":
                return src
            _, key, slot = src
            if (key, slot) in alias:
                src = alias[(key, slot)]
                continue
            n = nodes.get(key)
            if n is None:
                return None
            t = n["type"]
            if n["mode"] == 2:
                return None
            if t == "Reroute":
                src = n["inputs"][0][1] if n["inputs"] else None
                continue
            if t == "PrimitiveNode":
                wv = n["wv"] or []
                return ("c", wv[0] if wv else None)
            if t == "GetNode":
                src = sets.get(str((n["wv"] or [None])[0]))
                continue
            if n["mode"] == 4:  # bypassed: the first input of the output's type passes through
                want = n["outputs"][slot] if slot < len(n["outputs"]) else None
                src = next((s for _, s, ty in n["inputs"] if s is not None and ty == want), None)
                continue
            return src
        return None

    api: dict[str, dict] = {}
    for key, n in nodes.items():
        t = n["type"]
        if t in FRONTEND_ONLY or n["mode"] in (2, 4):
            continue
        spec = info.get(t)
        inputs: dict[str, Any] = {}
        if spec is not None:
            inputs, extra = _widget_values(spec, n["wv"])
            if extra:
                notes.append(f"{n['title'] or t} (#{key}): {extra} widget value{'s' if extra > 1 else ''} didn't map; check its settings.")
        elif isinstance(n["wv"], dict):
            inputs = dict(n["wv"])
        for name, src, _ in n["inputs"]:
            if not name:
                continue
            r = resolve(src)
            if r is None:
                if src is not None and name in inputs and not _is_widget_name(spec, name):
                    inputs.pop(name, None)
                continue
            inputs[name] = r[1] if r[0] == "c" else [r[1], r[2]]
        if spec is not None:  # widgets added to the node after the file was saved
            for name, s in _spec_inputs({"input": {"required": (spec.get("input") or {}).get("required") or {}}}):
                if name not in inputs and _is_widget(s):
                    d = _default(s)
                    if d is not None:
                        inputs[name] = d
        node = {"class_type": t, "inputs": inputs}
        if n["title"]:
            node["_meta"] = {"title": n["title"]}
        api[key] = node
    if not api:
        raise BuildError("No runnable nodes in this workflow.")
    return api, notes


def _default(spec: list) -> Any:
    o = _opts(spec)
    if "default" in o:
        return o["default"]
    opts = spec[0] if isinstance(spec[0], list) else o.get("options")
    if isinstance(opts, list) and opts:
        return opts[0].get("key") if isinstance(opts[0], dict) else opts[0]
    return None


def _is_widget_name(spec: dict | None, name: str) -> bool:
    if spec is None:
        return False
    return any(n == name and _is_widget(s) for n, s in _spec_inputs(spec))


# ---- analysis -----------------------------------------------------------------

SAVE_HINTS = ("Save", "VideoCombine")
PARAM_GUESS = {
    "seed": "seed", "noise_seed": "seed", "steps": "steps", "cfg": "cfg", "denoise": "denoise",
    "megapixels": "megapixels", "strength_model": "strength", "length": "length", "num_frames": "length",
}
SKIP_INPUTS = {"filename_prefix", "format", "codec", "control_after_generate"}


def _is_link(v: Any) -> bool:
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], int)


def _nid_key(nid: str) -> tuple:
    return tuple(int(p) if p.isdigit() else 0 for p in nid.split(":"))


# What an output node writes, read from the types wired into it. Templates make images and videos.
OUTPUT_TYPES = (("VIDEO", "video"), ("IMAGE", "image"), ("MASK", "image"), ("AUDIO", "audio"),
                ("FILE_3D", "3d"), ("MESH", "3d"), ("SVG", "svg"), ("STRING", "text"), ("*", "text"))
OUTPUT_NOUN = {"audio": "audio", "3d": "a 3D model", "svg": "an SVG", "text": "text", "other": "files that aren't images or videos"}


def output_kind(api: dict, nid: str, info: dict) -> str:
    n = api[nid]
    ct = n["class_type"]
    if any(h in ct for h in ("Video", "WEBM")):
        return "video"
    specs = dict(_spec_inputs(info.get(ct) or {}))
    wired = [specs.get(k) for k, v in n["inputs"].items() if _is_link(v)]
    types = {t for s in wired if isinstance(s, (list, tuple)) and s and isinstance(s[0], str) for t in s[0].split(",")}
    for t, kind in OUTPUT_TYPES:
        if any(x == t or (t != "*" and x.startswith(t)) for x in types):
            return kind
    return "other"


def _outputs(api: dict, info: dict) -> list[str]:
    return [nid for nid, n in api.items() if (info.get(n["class_type"]) or {}).get("output_node")]


def output_nodes(api: dict, info: dict) -> list[str]:
    """The nodes whose image or video a run keeps: Save nodes, else Preview nodes."""
    outs = [nid for nid in _outputs(api, info) if output_kind(api, nid, info) in ("image", "video")]
    saves = [nid for nid in outs if any(h in api[nid]["class_type"] for h in SAVE_HINTS)]
    return sorted(saves or [nid for nid in outs if "Preview" in api[nid]["class_type"]], key=_nid_key)


def other_outputs(api: dict, info: dict) -> list[tuple[str, str]]:
    """Output nodes that write something else (audio, 3D, text, model files): (node id, kind)."""
    kinds = [(nid, output_kind(api, nid, info)) for nid in _outputs(api, info)]
    return sorted([(nid, k) for nid, k in kinds if k not in ("image", "video")], key=lambda x: _nid_key(x[0]))


def reachable(api: dict, outs: list[str]) -> dict:
    """Only the nodes the outputs depend on; everything else would never run."""
    keep: set[str] = set()
    stack = list(outs)
    while stack:
        nid = stack.pop()
        if nid in keep or nid not in api:
            continue
        keep.add(nid)
        stack.extend(v[0] for v in api[nid]["inputs"].values() if _is_link(v))
    return {k: v for k, v in api.items() if k in keep}


def _consumers(api: dict) -> dict[str, list[tuple[str, str]]]:
    out: dict[str, list] = {}
    for nid, n in api.items():
        for name, v in n["inputs"].items():
            if _is_link(v):
                out.setdefault(v[0], []).append((nid, name))
    return out


def _polarity(api: dict, nid: str, cons: dict) -> str | None:
    """Does this text node end up as positive or negative conditioning?"""
    seen, frontier = {nid}, [nid]
    for _ in range(8):
        nxt = []
        for n in frontier:
            for c, name in cons.get(n, []):
                if name == "negative" or name.startswith("negative"):
                    return "negative"
                if name in ("positive", "conditioning") or name.startswith("positive"):
                    return "positive"
                if c not in seen:
                    seen.add(c)
                    nxt.append(c)
        frontier = nxt
    return None


def _title(api: dict, nid: str) -> str:
    n = api[nid]
    return (n.get("_meta") or {}).get("title") or n["class_type"]


def _label(name: str) -> str:
    s = name.rsplit(".", 1)[-1].replace("_", " ").strip()
    return s[:1].upper() + s[1:]


def analyze(api: dict, info: dict, notes: list[str] | None = None) -> dict:
    """What a template could expose, with a suggested pick for each."""
    outs = output_nodes(api, info)
    others = other_outputs(api, info)
    if not outs:
        if others:
            what = sorted({OUTPUT_NOUN.get(k, OUTPUT_NOUN["other"]) for _, k in others})
            raise BuildError(f"This workflow saves {' and '.join(what)}, not an image or video. Templates make images and videos for now, so it can't become one.")
        raise BuildError("This workflow has no Save node, so a run would produce nothing. Add a Save Image or Save Video node in ComfyUI.")
    notes = list(notes or [])
    for nid, k in others:
        notes.append(f"Left out {_title(api, nid)} (#{nid}): it saves {OUTPUT_NOUN.get(k, OUTPUT_NOUN['other'])}, and templates keep the image or video.")
    api = reachable(api, outs)
    cons = _consumers(api)
    media, texts, params = [], [], []
    for nid in sorted(api, key=_nid_key):
        n = api[nid]
        spec = info.get(n["class_type"]) or {}
        specs = dict(_spec_inputs(spec))
        for name, v in n["inputs"].items():
            if _is_link(v) or name in SKIP_INPUTS:
                continue
            s = specs.get(name) or specs.get(name.split(".", 1)[0])
            o = _opts(s)
            up = next((k[: -len("_upload")] for k in o if k.endswith("_upload") and o[k]), None)
            if up in ("image", "video", "audio") and name in specs:
                media.append({"node": nid, "input": name, "kind": up, "title": _title(api, nid), "class_type": n["class_type"],
                              "value": v if isinstance(v, str) else None})
                continue
            if isinstance(v, str) and v.lower().endswith(MODEL_EXT):
                continue  # model files are requirements, not settings
            row = {"node": nid, "input": name, "title": _title(api, nid), "class_type": n["class_type"], "value": v}
            t = s[0] if isinstance(s, (list, tuple)) and s else None
            if isinstance(v, str) and t == "STRING" and (o.get("multiline") or o.get("dynamicPrompts")):
                texts.append({**row, "polarity": "negative" if "negative" in name else _polarity(api, nid, cons)})
                continue
            if isinstance(t, list) or t == "COMBO" or t == DYNAMIC_COMBO:
                options = t if isinstance(t, list) else o.get("options") or []
                options = [x.get("key") if isinstance(x, dict) else x for x in options]
                if not options or len(options) > 60 or not all(isinstance(x, (str, int, float)) for x in options):
                    continue
                row.update(type="select", options=options)
            elif t == "BOOLEAN" or isinstance(v, bool):
                row.update(type="bool")
            elif t in ("INT", "FLOAT") or isinstance(v, (int, float)):
                guess = PARAM_GUESS.get(name)
                row.update(type="seed" if guess == "seed" else ("int" if t == "INT" else "number"),
                           min=o.get("min"), max=o.get("max"), step=o.get("step") or (1 if t == "INT" else 0.01))
            elif t == "STRING" and isinstance(v, str):
                row.update(type="string")
            else:
                continue
            row["help"] = (o.get("tooltip") or "").split(". ")[0][:160] or None
            row["suggested"] = name in PARAM_GUESS
            params.append(row)

    # One slot per loader, numbered by kind in graph order.
    count: dict[str, int] = {}
    for m in media:
        count[m["kind"]] = count.get(m["kind"], 0) + 1
        m["slot"] = f"{m['kind']}:{count[m['kind']]}"
    pos = [t for t in texts if t["polarity"] == "positive"] or [t for t in texts if t["polarity"] != "negative"]
    prompt = max(pos, key=lambda t: len(t["value"] or ""), default=None)
    # A seed per graph is enough; the rest stay as saved.
    seeds = [p for p in params if p["type"] == "seed"]
    for p in seeds[1:]:
        p["suggested"] = False
    # A loader's saved file gets replaced by the user's upload, so a missing one isn't a problem.
    check = local.check(api, info)
    slots = {(m["node"], m["input"]) for m in media}
    check["bad_values"] = [b for b in check["bad_values"] if (b["node_id"], b["input"]) not in slots]
    check["ok"] = not check["missing_nodes"] and not check["missing_models"] and not check["bad_values"]
    has_video = any(m["kind"] == "video" for m in media) or any(
        "Video" in api[o]["class_type"] or "WEBM" in api[o]["class_type"] or "Animated" in api[o]["class_type"] for o in outs)
    return {
        "workflow": api,
        "outputs": outs,
        "media": media,
        "texts": texts,
        "prompt": {"node": prompt["node"], "input": prompt["input"]} if prompt else None,
        "params": params,
        "mode": "motion" if has_video else "edit",
        "check": check,
        "notes": notes or [],
        "nodes": len(api),
    }


# ---- cloud: Router schema -----------------------------------------------------

def _first_type(s: dict) -> dict:
    if s.get("anyOf"):
        return next((x for x in s["anyOf"] if x.get("type") and x.get("type") != "null"), s)
    return s


def _media_kind(key: str, s: dict) -> str | None:
    k = key.lower()
    items = _first_type(s.get("items") or {}) if s.get("type") == "array" else {}
    fmt = s.get("format") or items.get("format") or ""
    for kind in ("image", "video", "audio"):
        if kind in k or (kind == "image" and k in ("input_image", "reference", "references", "frames")):
            if s.get("type") in ("string", "array") or fmt:
                return kind
    if fmt in ("uri", "binary") or "url" in k:
        return "image" if "image" in (s.get("description") or "").lower() else None
    return None


def analyze_schema(schema: dict) -> dict:
    """Router request schema → prompt, media fields and params, like ``analyze``."""
    props = (schema or {}).get("properties") or {}
    required = set((schema or {}).get("required") or [])
    media, params = [], []
    prompt = None
    for key, raw in props.items():
        s = _first_type(raw)
        help_ = (raw.get("description") or s.get("description") or "").split(". ")[0][:160] or None
        if key in ("prompt", "text", "instruction") and s.get("type") == "string" and prompt is None:
            prompt = {"field": key, "required": key in required}
            continue
        kind = _media_kind(key, s)
        if kind:
            many = s.get("type") == "array"
            media.append({"field": key, "kind": kind, "many": many, "max": int(s.get("maxItems") or (4 if many else 1)) if many else 1,
                          "required": key in required, "title": _label(key), "help": help_})
            continue
        default = raw.get("default", s.get("default"))
        row = {"field": key, "title": _label(key), "help": help_, "required": key in required, "value": default}
        if isinstance(s.get("enum"), list):
            row.update(type="select", options=[x for x in s["enum"] if isinstance(x, (str, int, float))])
        elif s.get("type") == "boolean":
            row.update(type="bool")
        elif s.get("type") in ("integer", "number"):
            row.update(type="seed" if key == "seed" else ("int" if s["type"] == "integer" else "number"),
                       min=s.get("minimum"), max=s.get("maximum"), step=1 if s["type"] == "integer" else None)
        elif s.get("type") == "string":
            row.update(type="string")
        else:
            continue
        row["suggested"] = key in ("seed", "aspect_ratio", "resolution", "duration", "negative_prompt") or key in required
        params.append(row)
    n: dict[str, int] = {}
    for m in media:
        n[m["kind"]] = n.get(m["kind"], 0) + 1
    out_mod = set((schema or {}).get("x-output-modalities") or [])
    return {"media": media, "prompt": prompt, "params": params,
            "mode": "motion" if n.get("video") or "video" in out_mod else "edit"}


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

TEXT_MAX = {"label": 80, "blurb": 400, "hint": 160, "default_prompt": 4000}
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
    if t in ("select", "segmented"):
        out["options"] = [str(o) for o in p.get("options") or []][:60]
        if not out["options"]:
            raise BuildError(f"{out['label']} has no options")
    d = p.get("default")
    out["default"] = -1 if t == "seed" else (str(d) if t in ("select", "segmented") and d is not None else d)
    if p.get("help"):
        out["help"] = _txt(p["help"], 240, "help")
    return out


def _media_rows(rows: list[dict]) -> list[dict]:
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
    if not label:
        raise BuildError("Give the template a name")
    videos = [m for m in media if m["kind"] == "video"]
    if len(videos) > 1:
        raise BuildError("Templates take one video for now")
    mode = spec.get("mode") if spec.get("mode") in ("edit", "motion") else ("motion" if videos else "edit")
    fields: list[dict[str, Any]] = []
    for m in media:
        f: dict[str, Any] = {"key": m["slot"], "type": m["kind"], "label": _txt(m.get("label"), 40, "an input label") or _label(m["kind"]),
                             "required": bool(m.get("required", True))}
        if m.get("hint"):
            f["hint"] = _txt(m["hint"], TEXT_MAX["hint"], "a hint")
        if m["kind"] == "video":
            f.update(window=[1, 20], max_height=720)
        fields.append(f)
    pr = spec.get("prompt") or None
    if pr:
        f = {"key": "prompt", "type": "text", "label": _txt(pr.get("label"), 40, "the prompt label") or "Prompt",
             "required": bool(pr.get("required", True)), "default": _txt(pr.get("default"), TEXT_MAX["default_prompt"], "the default prompt")}
        if pr.get("hint"):
            f["hint"] = _txt(pr["hint"], TEXT_MAX["hint"], "the prompt hint")
        examples = [e for e in (_txt(x, TEXT_MAX["default_prompt"], "an example") for x in (pr.get("examples") or [])[:12]) if e]
        if examples:
            f["examples"] = examples
        fields.append(f)
    return {
        "format": "openillusion.template",
        "version": 2,
        "mode": mode,
        "label": label,
        "blurb": _txt(spec.get("blurb"), TEXT_MAX["blurb"], "the description"),
        "tags": [t for t in (_txt(x, 24, "a tag").lower() for x in (spec.get("tags") or [])[:8]) if t],
        "inputs": fields,
        "built": True,
    }


def _input(data: dict, key: str) -> dict:
    return next(f for f in data["inputs"] if f["key"] == key)


def _kind(v: Any) -> str:
    return "bool" if isinstance(v, bool) else "number" if isinstance(v, (int, float)) else "text" if isinstance(v, str) else "other"


def assemble_local(spec: dict, draft: dict, info: dict) -> dict:
    api = copy.deepcopy(draft["workflow"])
    media = _media_rows(spec.get("media") or [])
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
            cast = "int" if all(isinstance(o, int) for o in p.get("options") or []) else "str"
        data["inputs"].append({**row, "advanced": row["type"] == "seed", "bind": [[str(p["node"]), p["input"]] + ([cast] if cast else [])]})
    outs = [str(o) for o in (spec.get("outputs") or output_nodes(api, info))]
    if not outs:
        raise BuildError("Pick at least one output node")
    api = reachable(api, outs)
    data.update(kind="local", provider="local", outputs=outs, workflow=api,
                source=_txt(spec.get("source"), 200, "the source") or "Built in OpenIllusion from a ComfyUI workflow",
                hints={"models": {}, "nodes": {}})
    return data


def _set_path(body: dict, path: list, value: Any) -> None:
    cur: Any = body
    for k in path[:-1]:
        cur = cur.setdefault(k, {}) if isinstance(cur, dict) else cur[k]
    cur[path[-1]] = value


def assemble_cloud(spec: dict) -> dict:
    model = spec.get("model") or ""
    if not re.fullmatch(r"[\w.-]+/[\w.:-]+", model):
        raise BuildError("Pick a model")
    media = _media_rows(spec.get("media") or [])  # one row per slot; array fields repeat
    data = _common(spec, media)
    body: dict[str, Any] = {}
    for k, v in (spec.get("fixed") or {}).items():
        if not isinstance(k, str):
            continue
        body[k] = v
    index: dict[str, int] = {}
    for m in media:
        field = m.get("field")
        if not isinstance(field, str) or not field:
            raise BuildError("Media field missing")
        if m.get("many"):
            i = index.get(field, 0)
            index[field] = i + 1
            body.setdefault(field, [])
            body[field].append("{{%s}}" % m["slot"])
            _input(data, m["slot"])["bind"] = [[field, i]]
        else:
            body[field] = "{{%s}}" % m["slot"]
            _input(data, m["slot"])["bind"] = [[field]]
    pr = spec.get("prompt")
    if pr:
        field = pr.get("field") or "prompt"
        f = _input(data, "prompt")
        body[field] = f["default"]
        f["bind"] = [[field]]
    for p in spec.get("params") or []:
        field = p.get("field")
        if not isinstance(field, str):
            continue
        row = _param(p, re.sub(r"[^a-z0-9_]", "_", field.lower()))
        data["inputs"].append({**row, "advanced": row["type"] == "seed", "bind": [[field]]})
    data.update(kind="cloud", model=model, provider=model.split("/", 1)[0], body=body,
                source=f"Comfy Router · {model}")
    return data


def save(data: dict, samples: dict[str, Path], cover: Path | None, replace: str | None = None, taken: set[str] = frozenset()) -> str:
    """Write a built template to the user's templates folder. Returns its id."""
    kind = data["kind"]
    root = paths.user_root() / "templates"
    root.mkdir(parents=True, exist_ok=True)
    if replace:
        tid = replace
        slug = tid.split("/", 1)[1]
    else:
        base = slugify(data["label"])
        slug, i = base, 2
        while (root / f"{kind}__{slug}.json").exists() or f"{kind}/{slug}" in taken:
            slug, i = f"{base}-{i}", i + 1
        tid = f"{kind}/{slug}"
    data["id"] = tid
    media_dir = root / "media" / f"{kind}__{slug}"
    if samples or cover:
        media_dir.mkdir(parents=True, exist_ok=True)
    for slot, src in samples.items():
        dst = media_dir / f"sample-{slot.replace(':', '-')}{src.suffix.lower()}"
        shutil.copyfile(src, dst)
        _input(data, slot)["default"] = dst.relative_to(root).as_posix()
    if cover:
        dst = media_dir / f"cover{cover.suffix.lower()}"
        shutil.copyfile(cover, dst)
        data["cover"] = dst.relative_to(root).as_posix()
    (root / f"{kind}__{slug}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    return tid
