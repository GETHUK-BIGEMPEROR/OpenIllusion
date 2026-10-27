"""Reading a dropped workflow: API or UI JSON, or the graph a PNG, WebP or MP4 carries,
and converting a UI graph to API format against ``/object_info``."""

from __future__ import annotations

import io
import json
from pathlib import Path
from typing import Any

from .. import local


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
