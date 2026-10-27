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
import math
import re
import shutil
from pathlib import Path
from typing import Any

from . import adapters, local, paths, prep

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


def _widget_values(info_node: dict, values: Any, controls: dict | None = None) -> tuple[dict, int]:
    """Positional widgets_values → {input: value}. Returns the map and how many values were left over.
    Each number's "control after generate" (fixed, randomize…) goes into ``controls`` when given."""
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
                if controls is not None:
                    controls[prefix + name] = vals[i]
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
                return ("c", wv[0] if wv else None, wv[1] if len(wv) > 1 and wv[1] in CONTROL else None)
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
        controls: dict[str, str] = {}
        if spec is not None:
            inputs, extra = _widget_values(spec, n["wv"], controls)
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
            controls.pop(name, None)
            if r[0] == "c" and len(r) > 2 and r[2]:  # a primitive node's own control
                controls[name] = r[2]
        if spec is not None:  # widgets added to the node after the file was saved
            for name, s in _spec_inputs({"input": {"required": (spec.get("input") or {}).get("required") or {}}}):
                if name not in inputs and _is_widget(s):
                    d = _default(s)
                    if d is not None:
                        inputs[name] = d
        node = {"class_type": t, "inputs": inputs}
        meta = {"title": n["title"]} if n["title"] else {}
        # Kept so a run does what ComfyUI would: re-roll a "randomize" seed, keep a "fixed" one.
        controls = {k: v for k, v in controls.items() if not isinstance(inputs.get(k), list)}
        if controls:
            meta["control_after_generate"] = controls
        if meta:
            node["_meta"] = meta
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
    """Every output node: what ComfyUI runs the graph for."""
    return sorted((nid for nid, n in api.items() if (info.get(n["class_type"]) or {}).get("output_node")), key=_nid_key)


def result_nodes(api: dict, info: dict) -> list[dict]:
    """Output nodes that write an image or a video, where a run's result can come from.
    Save nodes come first (ComfyUI keeps what they write; a Preview only shows it), then graph order."""
    rows = [{"node": nid, "title": _title(api, nid), "class_type": api[nid]["class_type"], "kind": k}
            for nid in _outputs(api, info) if (k := output_kind(api, nid, info)) in ("image", "video")]
    return sorted(rows, key=lambda r: ("Preview" in r["class_type"], _nid_key(r["node"])))


def other_outputs(api: dict, info: dict) -> list[tuple[str, str]]:
    """Output nodes that write something else (audio, 3D, text, model files): (node id, kind)."""
    kinds = [(nid, output_kind(api, nid, info)) for nid in _outputs(api, info)]
    return [(nid, k) for nid, k in kinds if k not in ("image", "video")]


def reachable(api: dict, outs: list[str]) -> dict:
    """Only the nodes the outputs depend on: the rest would never run."""
    keep: set[str] = set()
    stack = list(outs)
    while stack:
        nid = stack.pop()
        if nid in keep or nid not in api:
            continue
        keep.add(nid)
        stack.extend(v[0] for v in api[nid]["inputs"].values() if _is_link(v))
    return {k: v for k, v in api.items() if k in keep}


def _numeric_only(info_node: dict | None) -> bool:
    """A node whose every output is a number or a yes/no, like a math expression."""
    outs = [str(o) for o in (info_node or {}).get("output") or []]
    return bool(outs) and all(set(o.split(",")) <= {"INT", "FLOAT", "BOOLEAN"} for o in outs)


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


FILE_EXT = {"image": (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"), "video": (".mp4", ".webm", ".mov", ".mkv", ".avi", ".gif")}


def _file_kind(v: Any) -> str | None:
    """A setting that holds a photo or clip file name, so it could take one."""
    if not isinstance(v, str):
        return None
    low = v.lower()
    return next((k for k, ext in FILE_EXT.items() if low.endswith(ext)), None)


def _int_widget(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def analyze(api: dict, info: dict, notes: list[str] | None = None) -> dict:
    """What a template could expose, read from the graph and ComfyUI's node definitions.

    Nothing here is applied. Each pick (``suggested`` rows, ``prompt``, ``outputs``, ``size``,
    ``mode``) is a suggestion the builder shows; a template keeps only what its author confirms,
    and a run writes only what the template declares."""
    results = result_nodes(api, info)
    others = other_outputs(api, info)
    if not results:
        if others:
            what = sorted({OUTPUT_NOUN.get(k, OUTPUT_NOUN["other"]) for _, k in others})
            raise BuildError(f"This workflow saves {' and '.join(what)}, not an image or video. Templates make images and videos for now, so it can't become one.")
        raise BuildError("This workflow has no Save node, so a run would produce nothing. Add a Save Image or Save Video node in ComfyUI.")
    notes = list(notes or [])
    for nid, k in others:
        notes.append(f"{_title(api, nid)} (#{nid}) also saves {OUTPUT_NOUN.get(k, OUTPUT_NOUN['other'])}. It still runs; the template keeps the image or video.")
    api = reachable(api, _outputs(api, info))  # what ComfyUI would run
    cons = _consumers(api)
    media, texts, params, sizes = [], [], [], []
    for nid in sorted(api, key=_nid_key):
        n = api[nid]
        spec = info.get(n["class_type"]) or {}
        specs = dict(_spec_inputs(spec))
        ins = n["inputs"]
        if all(_int_widget(ins.get(k)) and _is_widget(specs.get(k)) for k in ("width", "height")):
            sizes.append({"node": nid, "title": _title(api, nid), "class_type": n["class_type"], "width": ins["width"], "height": ins["height"]})
        for name, v in ins.items():
            if _is_link(v) or name in SKIP_INPUTS:
                continue
            s = specs.get(name) or specs.get(name.split(".", 1)[0])
            o = _opts(s)
            up = next((k[: -len("_upload")] for k in o if k.endswith("_upload") and o[k]), None)
            base = {"node": nid, "input": name, "title": _title(api, nid), "class_type": n["class_type"]}
            if up in ("image", "video", "audio") and name in specs:  # ComfyUI marks it as a file input
                media.append({**base, "kind": up, "found": "loader", "suggested": True, "value": v if isinstance(v, str) else None})
                continue
            if isinstance(v, str) and v.lower().endswith(MODEL_EXT):
                continue  # model files are requirements, not settings
            fk = _file_kind(v)
            if fk:  # a file name in a plain setting: it can take an input when the author says so
                media.append({**base, "kind": fk, "found": "setting", "suggested": False, "value": v})
                continue
            row = {**base, "value": v}
            t = s[0] if isinstance(s, (list, tuple)) and s else None
            if isinstance(v, str) and t == "STRING" and (o.get("multiline") or o.get("dynamicPrompts")):
                if _numeric_only(info.get(n["class_type"])):
                    continue  # a formula: the text becomes a number, not a prompt
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

    # One slot per input, numbered by kind in graph order.
    count: dict[str, int] = {}
    for m in media:
        count[m["kind"]] = count.get(m["kind"], 0) + 1
        m["slot"] = f"{m['kind']}:{count[m['kind']]}"
    # The prompt: the one text that ends up as positive conditioning. With several, the author picks.
    cands = [t for t in texts if t["polarity"] == "positive"] or [t for t in texts if t["polarity"] is None]
    prompt = cands[0] if len(cands) == 1 else None
    if prompt is None and len(cands) > 1:
        notes.append("Several text boxes could be the prompt. Pick the one people write in.")
    # A seed per graph is enough to suggest; the rest stay as saved unless the author shows them.
    seeds = [p for p in params if p["type"] == "seed"]
    for p in seeds[1:]:
        p["suggested"] = False
    # An output size is suggested only for a workflow that takes no file and has one place to set it.
    loaders = [m for m in media if m["found"] == "loader"]
    size = sizes[0] if len(sizes) == 1 and not loaders else None
    # A loader's saved file gets replaced by the user's upload, so a missing one isn't a problem.
    check = local.check(api, info)
    slots = {(m["node"], m["input"]) for m in media}
    check["bad_values"] = [b for b in check["bad_values"] if (b["node_id"], b["input"]) not in slots]
    check["ok"] = not check["missing_nodes"] and not check["missing_models"] and not check["bad_values"]
    return {
        "workflow": api,
        "outputs": [results[0]["node"]],
        "results": results,
        "media": media,
        "texts": texts,
        "prompt": {"node": prompt["node"], "input": prompt["input"]} if prompt else None,
        "params": params,
        "sizes": sizes,
        "size": {"node": size["node"]} if size else None,
        # What a declared output size can offer: the shapes, and the steps for photos and for clips.
        "canvas": {"aspects": list(prep.ASPECTS), "steps": {m: [o["label"] for o in prep.spec_of(None, [], m)["options"] if o["px"]] for m in prep.STEPS}},
        "mode": "motion" if results[0]["kind"] == "video" else "edit",
        "check": check,
        "notes": notes or [],
        "nodes": len(api),
    }


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
    input it has is required, so it always asks the model for the same job."""
    try:
        a = adapters.get(str(spec.get("model") or ""))
    except adapters.AdapterError as e:
        raise BuildError(str(e)) from None
    media = _media_rows([{**m, "required": True} for m in spec.get("media") or []])
    for m in media:
        i = m.get("input")
        if not isinstance(i, int) or not 0 <= i < len(a.inputs) or a.inputs[i]["type"] != m["kind"]:
            raise BuildError(f"{a.name} has no such {m['kind']} input")
    pr = spec.get("prompt") or {}
    data = _common({**spec, "mode": a.mode, "prompt": {**pr, "required": True}}, media)
    prompt = _input(data, "prompt")
    if not prompt["default"]:
        raise BuildError("Write the prompt the first run uses")
    try:
        body, where, model = adapters.assemble(a, [(m["input"], m["slot"]) for m in media], prompt["default"])
    except adapters.AdapterError as e:
        raise BuildError(str(e)) from None
    for m in media:
        _input(data, m["slot"])["bind"] = [where[m["slot"]]]
    prompt["bind"] = [list(a.prompt)]
    data.update(kind="cloud", model=model, provider=model.split("/", 1)[0], body=body, result=a.result,
                source=f"Comfy Router · {a.name}")
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
    prompt = {**at(text), **{k: text[k] for k in keep if k in text}, "default": e.default_prompt,
              "examples": [x.get("text", "") if isinstance(x, dict) else str(x) for x in text.get("examples") or []]} if text else None
    params = [{**at(f), "key": f["key"], "label": f.get("label") or _label(f["key"]), "default": f.get("default"), "help": f.get("help")}
              for f in e.fields if f["type"] not in ("image", "video", "audio", "size") and f["key"] != "prompt"]
    out = next((f for f in e.fields if f["type"] == "size"), None)
    size = {"node": str(out["bind"][0][0]), **{k: out[k] for k in ("label", "aspect", "default") if k in out}} if out else None
    name, _, rest = e.label.partition(" · ")
    return {"base": e.id, "label": f"{name} (copy)" + (f" · {rest}" if rest else ""), "blurb": e.blurb, "tags": list(e.tags),
            "mode": e.mode, "media": media, "prompt": prompt, "params": params, "size": size, "outputs": list(e.outputs)}


def inherit(data: dict, base: dict, base_label: str) -> None:
    """A template built from another keeps what the builder doesn't show: the multiple its inputs are
    trimmed to, its model hints and its prompt ideas."""
    if (base.get("size") or {}).get("multiple"):
        data["size"] = {"multiple": base["size"]["multiple"]}
    if base.get("hints"):
        data["hints"] = copy.deepcopy(base["hints"])
    old = {f.get("key"): f for f in base.get("inputs") or []}
    for f in data["inputs"]:
        o = old.get(f["key"])
        if not o or o.get("type") != f["type"]:
            continue
        if f["key"] == "prompt" and o.get("examples") and not f.get("examples"):
            f["examples"] = copy.deepcopy(o["examples"])
    data["source"] = f"Built in OpenIllusion from {base_label}"


def save(data: dict, samples: dict[str, Path], replace: str | None = None, taken: set[str] = frozenset()) -> str:
    """Write a built template to the user's templates folder. Returns its id.

    A new template has no cover: it's a draft until a run of it is published as one.
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
    (root / f"{kind}__{slug}.json").write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", "utf-8")
    return tid
