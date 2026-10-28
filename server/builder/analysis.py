"""What a template could expose from a workflow: media loaders, prompt boxes,
settings, result nodes and an output size."""

from __future__ import annotations

from typing import Any

from .. import local, prep
from .workflow import MODEL_EXT, BuildError, DYNAMIC_COMBO, _spec_inputs, _opts, _is_widget


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
