"""Request bodies: a local workflow or a cloud body filled from the studio's inputs, and media tokens."""

from __future__ import annotations

import copy
import mimetypes
import random
import re
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from .. import media, prep, settings

if TYPE_CHECKING:
    from .contract import Engine


# A media slot inside a cloud body. The form says how the file goes in: a data URI (uri), bare
# base64 (b64), a link (url: uploaded to Comfy Cloud's assets at run time), or just its MIME type
# (mime), for bodies that name it beside the bytes.
TOKEN = re.compile(r"^\{\{(image|video|audio):(\d+)(?:\|(uri|b64|url|mime))?\}\}$")
MEDIA = ("image", "video", "audio")


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


def run_size(e: "Engine") -> dict:
    """The engine's size spec under the current cap setting (see prep.limit)."""
    return prep.limit(e.size, bool(settings.load().get("uncap_size")))


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
        elif key.startswith("refmod:"):  # a RefMod slot: left empty, the loader loads nothing there
            value, cast_ok = ("{{%s}}" % key if key in slots else NO_REFMOD), False
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


REFMOD = re.compile(r"^\{\{refmod:\d+\}\}$")
NO_REFMOD = "(none)"  # what a RefMod loader's empty slot holds


def fill_refmods(wf: dict, names: dict[str, str]) -> dict:
    """Swap ``{{refmod:N}}`` for the name ComfyUI loads that RefMod by (``names`` by slot)."""
    def one(v):
        return names.get(v[2:-2], v) if isinstance(v, str) and REFMOD.match(v) else v
    return {nid: {**n, "inputs": {k: one(v) for k, v in n.get("inputs", {}).items()}} for nid, n in wf.items()}


def _setting_value(f: dict, v: Any) -> Any:
    """A setting as the model reads it: an option in its own type (Create sends "8" for 8), a
    switch as the model's off/on words when it has them, an option as what it sends when it says."""
    if f.get("send") and str(v) in f["send"]:
        return f["send"][str(v)]
    if f.get("type") == "bool" and f.get("values"):
        return f["values"][1] if v in (True, "true", 1) else f["values"][0]
    for o in f.get("options") or []:
        if str(o) == str(v):
            return o
    if f.get("type") == "int" and v not in (None, ""):
        try:
            return int(float(v))
        except (TypeError, ValueError):
            return v
    return v


def build_cloud(e: "Engine", spec: dict) -> dict:
    """A cloud template's body with the studio's fields written in.

    Bindings are paths into the body. Media slots left empty are removed;
    an array field that ends up empty is dropped.
    """
    body = copy.deepcopy(e.body or {})
    p = spec.get("params", {})
    slots = {i["slot"] for i in spec.get("inputs", [])}
    fields = {f["key"]: f for f in e.fields}
    drop: list[list] = []
    for key, targets in e.bindings.items():
        if key == "prompt":
            value: Any = spec.get("prompt", "")
        elif key == "size":  # the model's size: the shape and step picked, as pixels
            w, h = prep.canvas_size(run_size(e), p.get("aspect"), p.get("out_size")) or (None, None)
            if w is None:
                continue
            f = fields["size"]
            for path, side in targets:
                _set(body, path, f"{w}{f.get('sep', 'x')}{h}" if side == "text" else w if side == "width" else h)
            continue
        elif key.startswith("params."):
            name = key[len("params."):]
            if name not in p:
                continue
            value = _setting_value(fields.get(name) or {}, p[name])
            if name == "seed" and (value in (None, "") or int(value) < 0):
                value = random.randint(0, 2**31 - 1)
            if value == "" and (fields.get(name) or {}).get("type") in ("aspect", "select", "segmented"):
                drop.extend(targets)  # "Auto": the model decides, so the field isn't sent
                continue
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
                raise KeyError(f"{slot} goes in as a link, but it wasn't uploaded")
            return item["url"]
        if slot not in encoded:
            path = base / item["file"]
            if kind == "image":
                encoded[slot] = media.image_payload(path, as_is=True)[0]
            else:
                mime = mimetypes.guess_type(path.name)[0] or ""
                encoded[slot] = media.file_data_uri(path, mime if mime.startswith(kind + "/") else {"video": "video/mp4", "audio": "audio/mpeg"}[kind])
        uri = encoded[slot]
        head, _, data = uri.partition(",")
        if form == "mime":
            return head[len("data:"):].split(";", 1)[0]
        return data if form == "b64" else uri

    return resolve
