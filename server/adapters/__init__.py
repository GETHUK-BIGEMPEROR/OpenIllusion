"""Router adapters: one hand-written JSON file per supported Comfy Router model.

Router's request format differs for every model, and the inputs sent pick the mode
(text to video, first frame, references, edit...). Nothing is guessed from schemas:
an adapter says which inputs a model takes, by role, where each goes in the request
and in what form, which go together, what else changes when one is used, where the
prompt goes, the request it starts from, and where the result comes back. A template
built from one carries its own copy of the request, cut down to the inputs its run
used. README.md, "Adapters", is the full guide.

Adapter file::

    {
      "model": "provider/model", "name": "Shown name", "makes": "photo" | "video",
      "body":   { ...the starting request, the model's own settings... },
      "prompt": ["path", "to", "the", "prompt"],
      "inputs": [
        { "role": "First frame", "type": "image" | "video" | "audio",
          "at": ["path", "into", "body"]  or  [["path", 1], ["path", 2], ...],
          "value": "{{$|uri}}" | { ...object holding tokens... },
          "max": 1, "max_with": {"roles": ["Role"], "max": 1},
          "set": ["frames"], "needs": "Another role",
          "with": [[["path"], value], ...], "drop": [["path"], ...],
          "fit": {"short": [300, null], "aspect": [0.4, 2.5], "mb": 10, "seconds": [3, 10], ...} }
      ],
      "media_mb": 20,
      "result": [["path", "*", "into", "the", "answer"]],
      "models": [{ "model": "provider/model-t2v", "takes": ["Role", ...] }, ...]
    }

- ``at`` ending in ``"+"`` appends the value to a list (made if missing), so an
  input can take up to ``max`` files; a list of paths puts the nth file at the nth.
  ``max`` is the model's own published limit, never a lower one of ours.
- ``max_with``: a lower limit while any of ``roles`` is filled (Kling takes 7
  reference images, 4 alongside a video).
- Tokens: ``{{$|uri}}`` data URI, ``{{$|b64}}`` bare base64, ``{{$|mime}}`` its MIME
  type, ``{{$|url}}`` a link (uploaded to Comfy Cloud at run time). ``$`` becomes the
  input's slot (``image:1``) when a template is put together.
- ``set``: every filled input shares a set with every other; inputs without one go
  with anything. ``needs``: a role that must be filled as well.
- ``with`` / ``drop``: paths set or removed in the request when the input is filled.
- ``models``: a family that splits its modes over several model ids; a run goes to
  the first one that takes every filled role.
- ``fit``: what the model takes in each file (sides, shape, size, length, frame rate);
  runs make every file fit. ``media_mb``: the most a request may carry inline.
  Both are the model's published limits; ``server/fit.py`` has the details.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .. import fit, prep

HERE = Path(__file__).parent
MODEL_ID = re.compile(r"[\w.-]+/[\w.:-]+")
TOKEN = re.compile(r"\{\{\$\|(uri|b64|mime|url)\}\}")
KINDS = ("image", "video", "audio")


class AdapterError(ValueError):
    """An adapter file that doesn't hold together, or inputs it can't take."""


@dataclass(frozen=True)
class Adapter:
    model: str
    name: str
    mode: str  # edit (makes photos) | motion (makes video)
    body: dict
    prompt: list
    inputs: list[dict] = field(default_factory=list)
    result: list[list] = field(default_factory=list)
    models: list[dict] = field(default_factory=list)  # [{model, takes: [role]}] when a family spans ids
    media_mb: float | None = None  # MB of files one request may carry inline, when the model says
    settings: list[dict] = field(default_factory=list)  # what people can choose about the result (see _setting)


def _is_path(p: Any, plus: bool = False) -> bool:
    ok = isinstance(p, list) and p and all(isinstance(k, str) or (isinstance(k, int) and not isinstance(k, bool) and k >= 0) for k in p)
    return bool(ok) and ("+" not in p or (plus and p.index("+") == len(p) - 1))


def _path(p: Any, what: str, plus: bool = False) -> list:
    if not _is_path(p, plus):
        raise AdapterError(f"{what}: a path into the request")
    return p


def _tokens(v: Any) -> int:
    if isinstance(v, str):
        if "{{" in v and not TOKEN.fullmatch(v):
            raise AdapterError(f"{v!r}: tokens are {{{{$|uri}}}}, {{{{$|b64}}}}, {{{{$|mime}}}} or {{{{$|url}}}}, alone in a string")
        return 1 if TOKEN.fullmatch(v) else 0
    if isinstance(v, dict):
        return sum(_tokens(x) for x in v.values())
    if isinstance(v, list):
        return sum(_tokens(x) for x in v)
    return 0


def _input(model: str, i: dict, roles: list) -> dict:
    what = f"{model} {i['role']}"
    if i.get("type") not in KINDS:
        raise AdapterError(f"{what}: type is image, video or audio")
    at = i.get("at")
    many = isinstance(at, list) and bool(at) and all(isinstance(x, list) for x in at)
    if many:
        for x in at:
            _path(x, what)
        if "max" in i and i["max"] != len(at):
            raise AdapterError(f"{what}: with one path per file, max is the number of paths")
        mx = len(at)
    else:
        _path(at, what, plus=True)
        mx = i.get("max", 1)
        if not isinstance(mx, int) or isinstance(mx, bool) or mx < 1 or (mx > 1 and at[-1] != "+"):
            raise AdapterError(f"{what}: max is 1 or more, and above 1 the path ends in +")
    if not _tokens(i.get("value")):
        raise AdapterError(f"{what}: value holds the file as a token")
    s = i.get("set")
    sets = [s] if isinstance(s, str) and s else s
    if sets is not None and not (isinstance(sets, list) and sets and all(isinstance(x, str) and x for x in sets)):
        raise AdapterError(f"{what}: set is a name or a list of names")
    if i.get("needs") is not None and i["needs"] not in roles:
        raise AdapterError(f"{what}: needs names another input's role")
    mw = i.get("max_with")
    if mw is not None:
        n, rs = (mw.get("max"), mw.get("roles")) if isinstance(mw, dict) else (None, None)
        if not (isinstance(n, int) and not isinstance(n, bool) and 1 <= n < mx and isinstance(rs, list) and rs
                and all(r in roles and r != i["role"] for r in rs)):
            raise AdapterError(f"{what}: max_with is {{roles: [other roles], max: fewer than max}}")
    w = i.get("with") or []
    if not isinstance(w, list) or not all(isinstance(x, list) and len(x) == 2 and _is_path(x[0]) for x in w):
        raise AdapterError(f"{what}: with lists [path, value] pairs")
    if "{{" in json.dumps(w):
        raise AdapterError(f"{what}: with holds settings, not file tokens")
    d = i.get("drop") or []
    if not isinstance(d, list) or not all(_is_path(x) for x in d):
        raise AdapterError(f"{what}: drop lists paths")
    try:
        ft = fit.check(i["fit"], what) if i.get("fit") is not None else None
    except ValueError as e:
        raise AdapterError(str(e)) from None
    if ft and i["type"] == "image" and {"seconds", "total", "fps"} & set(ft):
        raise AdapterError(f"{what}: a photo's fit has no seconds, total or fps")
    if ft and i["type"] == "audio" and set(ft) - {"seconds", "total", "mb"}:
        raise AdapterError(f"{what}: a sound's fit is seconds, total and mb")
    return {**i, "max": mx, "set": list(sets or []), "with": w, "drop": d, "fit": ft}


# ---- settings: what people choose about the result ------------------------------------
# The model's own output options (shape, resolution, length, sound…), each with where it goes
# in the request and the values the model's docs list. ``off_with``: roles that decide it
# instead (a first frame sets the shape), so it isn't asked and leaves the request; ``only_with``:
# roles it needs. A ``size`` setting turns a shape and a megapixel step into pixels.

SETTING_TYPES = ("aspect", "select", "segmented", "int", "bool", "size")
_KEY = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


ratio = prep.shape  # "16:9" as (16, 9); None for "auto" and the like


def _setting(model: str, s: Any, roles: list) -> dict:
    what = f"{model} setting {s.get('key') if isinstance(s, dict) else s!r}"
    if not isinstance(s, dict) or not isinstance(s.get("key"), str) or not _KEY.match(s["key"]) or s.get("type") not in SETTING_TYPES:
        raise AdapterError(f"{what}: key is a short lowercase name, type one of {', '.join(SETTING_TYPES)}")
    t = s["type"]
    if (t == "size") != (s["key"] == "size"):
        raise AdapterError(f"{what}: the size setting, and only it, is keyed size")
    for k in ("off_with", "only_with"):
        if not (isinstance(s.get(k, []), list) and all(r in roles for r in s.get(k, []))):
            raise AdapterError(f"{what}: {k} lists roles")
    out = {**s, "label": str(s.get("label") or s["key"].capitalize()),
           "off_with": list(s.get("off_with") or []), "only_with": list(s.get("only_with") or [])}
    if t == "size":
        at = s.get("at")
        if not (isinstance(at, dict) and (set(at) == {"width", "height"} or set(at) == {"text"}) and all(_is_path(p) for p in at.values())):
            raise AdapterError(f"{what}: at is {{width: path, height: path}} or {{text: path}} (\"WxH\")")
        steps = s.get("steps")
        if not (isinstance(steps, list) and steps and all(_num(x) and x > 0 for x in steps)):
            raise AdapterError(f"{what}: steps lists megapixels")
        aspects = s.get("aspects")
        if not (isinstance(aspects, list) and aspects and all(ratio(a) for a in aspects)) or s.get("aspect") not in aspects:
            raise AdapterError(f"{what}: aspects lists shapes (16:9) and aspect is one of them")
        if s.get("default") not in [f"{x:g} MP" for x in steps]:
            raise AdapterError(f"{what}: default is one of the steps, as \"1 MP\"")
        for k in ("sides", "pixels"):
            r = s.get(k)
            if r is not None and not (isinstance(r, list) and len(r) == 2 and all(_num(x) for x in r) and 0 < r[0] < r[1]):
                raise AdapterError(f"{what}: {k} is [least, most]")
        out["multiple"] = int(s.get("multiple") or 16)
        return out
    _path(s.get("at"), what)
    d = s.get("default")
    if t == "bool":
        v = s.get("values")
        if not isinstance(d, bool) or (v is not None and not (isinstance(v, list) and len(v) == 2)):
            raise AdapterError(f"{what}: default is true or false; values, if given, is [off, on]")
    elif t == "int":
        if not (all(isinstance(s.get(k), int) for k in ("min", "max")) and isinstance(d, int) and s["min"] <= d <= s["max"]):
            raise AdapterError(f"{what}: min, max and a default between them")
    else:
        opts = s.get("options")
        if not (isinstance(opts, list) and opts and all(isinstance(x, (str, int, float)) for x in opts)) or d not in opts:
            raise AdapterError(f"{what}: options lists the model's values and default is one of them")
        lb = s.get("labels") or {}
        if not (isinstance(lb, dict) and all(isinstance(v, str) for v in lb.values())):
            raise AdapterError(f"{what}: labels maps a value to what people see")
    return out


def settings_for(a: Adapter, roles: list[str]) -> list[dict]:
    """The settings a run with these roles asks for."""
    rs = set(roles)
    return [s for s in a.settings if not rs & set(s["off_with"]) and (not s["only_with"] or rs & set(s["only_with"]))]


def setting_paths(s: dict) -> list[list]:
    return [list(p) for p in s["at"].values()] if s["type"] == "size" else [list(s["at"])]


def setting_default(s: dict) -> Any:
    return {"aspect": s["aspect"], "size": s["default"]} if s["type"] == "size" else s["default"]


def setting_ok(s: dict, v: Any) -> bool:
    t = s["type"]
    if t == "size":
        return isinstance(v, dict) and v.get("aspect") in s["aspects"] and v.get("size") in [f"{x:g} MP" for x in s["steps"]]
    if t == "bool":
        return isinstance(v, bool)
    if t == "int":
        return isinstance(v, int) and not isinstance(v, bool) and s["min"] <= v <= s["max"]
    return v in s["options"]


def size_dims(s: dict, aspect: Any, step: Any) -> tuple[int, int]:
    """Pixels for a size setting: see ``prep.fit_dims``."""
    return prep.fit_dims(s, aspect, step)


def write_setting(body: dict, s: dict, v: Any) -> None:
    """Put a setting's value into the request where the model reads it."""
    if s["type"] == "size":
        w, h = size_dims(s, v.get("aspect"), v.get("size"))
        if "text" in s["at"]:
            _put(body, list(s["at"]["text"]), f"{w}{s.get('sep', 'x')}{h}")
        else:
            _put(body, list(s["at"]["width"]), w)
            _put(body, list(s["at"]["height"]), h)
    elif v == "":  # "Auto": the model decides, so the field isn't sent
        _remove(body, list(s["at"]))
    else:
        _put(body, list(s["at"]), s["values"][int(v)] if s["type"] == "bool" and s.get("values") else v)


def setting_field(s: dict, v: Any) -> dict:
    """A setting as a template input people change in Create, starting at ``v``."""
    if s["type"] == "size":
        at = s["at"]
        bind = [[list(at["text"]), "text"]] if "text" in at else [[list(at["width"]), "width"], [list(at["height"]), "height"]]
        return {"key": "size", "type": "size", "label": s["label"], "aspect": v["aspect"], "default": v["size"],
                "aspects": list(s["aspects"]), "steps": list(s["steps"]), "multiple": s["multiple"], "bind": bind,
                **{k: s[k] for k in ("sides", "pixels", "sep", "help") if s.get(k)}}
    f = {"key": s["key"], "type": s["type"], "label": s["label"], "default": v, "bind": [list(s["at"])]}
    f.update({k: s[k] for k in ("options", "labels", "values", "min", "max", "step", "unit", "help") if s.get(k) is not None})
    return f


def parse(d: dict) -> Adapter:
    """Check an adapter file and return it."""
    model = d.get("model")
    if not isinstance(model, str) or not MODEL_ID.fullmatch(model):
        raise AdapterError("model: provider/model")
    if d.get("makes") not in ("photo", "video"):
        raise AdapterError(f"{model}: makes is photo or video")
    body = d.get("body")
    if not isinstance(body, dict) or "{{" in json.dumps(body):
        raise AdapterError(f"{model}: body is the starting request, without file tokens")
    prompt = _path(d.get("prompt"), f"{model} prompt")
    raw = d.get("inputs") or []
    roles = [i.get("role") for i in raw]
    if len(set(roles)) != len(roles) or not all(isinstance(r, str) and r for r in roles):
        raise AdapterError(f"{model}: every input has its own role")
    inputs = [_input(model, dict(i), roles) for i in raw]
    result = d.get("result")
    if not isinstance(result, list) or not result or not all(isinstance(p, list) and p and all(isinstance(k, (str, int)) for k in p) for p in result):
        raise AdapterError(f"{model}: result lists paths into the answer")
    models = d.get("models") or []
    if not isinstance(models, list) or not all(
            isinstance(m, dict) and isinstance(m.get("model"), str) and MODEL_ID.fullmatch(m["model"])
            and isinstance(m.get("takes"), list) and all(r in roles for r in m["takes"]) for m in models):
        raise AdapterError(f"{model}: models lists {{model, takes: [roles]}}")
    name = d.get("name") if isinstance(d.get("name"), str) and d["name"].strip() else model.split("/", 1)[1]
    mmb = d.get("media_mb")
    if mmb is not None and not (isinstance(mmb, (int, float)) and not isinstance(mmb, bool) and mmb > 0):
        raise AdapterError(f"{model}: media_mb is a number above 0")
    st = d.get("settings") or []
    if not isinstance(st, list):
        raise AdapterError(f"{model}: settings is a list")
    settings = [_setting(model, x, roles) for x in st]
    if len({x["key"] for x in settings}) != len(settings):
        raise AdapterError(f"{model}: two settings share a key")
    return Adapter(model=model, name=name.strip(), mode="motion" if d["makes"] == "video" else "edit",
                   body=body, prompt=prompt, inputs=inputs, result=[list(p) for p in result],
                   models=[{"model": m["model"], "takes": list(m["takes"])} for m in models],
                   media_mb=float(mmb) if mmb is not None else None, settings=settings)


_cache: dict[str, Adapter] | None = None


def all_adapters() -> dict[str, Adapter]:
    """Every adapter in this folder, by model id."""
    global _cache
    if _cache is None:
        out: dict[str, Adapter] = {}
        for f in sorted(HERE.glob("*.json")):
            try:
                a = parse(json.loads(f.read_text("utf-8")))
            except (AdapterError, ValueError) as e:
                raise AdapterError(f"{f.name}: {e}") from None
            out[a.model] = a
        _cache = out
    return _cache


def get(model: str) -> Adapter:
    a = all_adapters().get(model or "")
    if a is None:
        raise AdapterError(f"{model or 'That model'} has no adapter. Router templates can use: " + ", ".join(a.name for a in all_adapters().values()))
    return a


def for_model(model: str) -> Adapter | None:
    """The adapter a Router model id belongs to: its own, or the family's that routes to it."""
    for a in all_adapters().values():
        if a.model == model or any(m["model"] == model for m in a.models):
            return a
    return None


def describe(a: Adapter) -> dict:
    """What the Builder shows: the model, what it makes, and every input it takes."""
    return {
        "model": a.model, "name": a.name, "mode": a.mode,
        "inputs": [{"role": i["role"], "type": i["type"], "max": i["max"],
                    **({"max_with": i["max_with"]} if i.get("max_with") else {}),
                    **({"fit": i["fit"]} if i.get("fit") else {}),
                    **({"set": i["set"]} if i["set"] else {}), **({"needs": i["needs"]} if i.get("needs") else {})} for i in a.inputs],
        **({"models": a.models} if a.models else {}),
        "settings": [{k: v for k, v in s.items() if k != "at"} for s in a.settings],
    }


# ---- putting a request together ---------------------------------------------------

def _fill(v: Any, slot: str) -> Any:
    if isinstance(v, str):
        return v.replace("{{$|", "{{%s|" % slot) if TOKEN.fullmatch(v) else v
    if isinstance(v, dict):
        return {k: _fill(x, slot) for k, x in v.items()}
    if isinstance(v, list):
        return [_fill(x, slot) for x in v]
    return v


fill = _fill  # an input's value as a request holds it for ``slot``


def _container(body: Any, path: list, leaf: Any) -> Any:
    """The dict or list ``path`` names, made on the way when missing; ``leaf`` is what the last step makes."""
    cur = body
    for n, k in enumerate(path):
        last = n == len(path) - 1
        make: Any = leaf if last else ([] if isinstance(path[n + 1], int) or path[n + 1] == "+" else {})
        if isinstance(cur, dict) and isinstance(k, str):
            if not isinstance(cur.get(k), (dict, list)):
                cur[k] = make
            cur = cur[k]
        elif isinstance(cur, list) and isinstance(k, int) and k < len(cur):
            cur = cur[k]
        else:
            raise AdapterError(f"{'.'.join(map(str, path))} doesn't fit the request")
    return cur


def _put(body: dict, path: list, value: Any) -> None:
    holder = _container(body, path[:-1], {}) if len(path) > 1 else body
    k = path[-1]
    if isinstance(holder, dict) and isinstance(k, str):
        holder[k] = value
    elif isinstance(holder, list) and isinstance(k, int) and k < len(holder):
        holder[k] = value
    else:
        raise AdapterError(f"{'.'.join(map(str, path))} doesn't fit the request")


def _remove(body: dict, path: list) -> None:
    cur: Any = body
    for k in path[:-1]:
        if isinstance(cur, dict) and isinstance(k, str) and k in cur:
            cur = cur[k]
        elif isinstance(cur, list) and isinstance(k, int) and k < len(cur):
            cur = cur[k]
        else:
            return
    if isinstance(cur, dict):
        cur.pop(path[-1], None)


def check(a: Adapter, used: list[int]) -> None:
    """Can the model take these inputs together? ``used``: one adapter-input index per file."""
    roles = [a.inputs[i]["role"] for i in used]
    for i, inp in enumerate(a.inputs):
        n = used.count(i)
        mw = inp.get("max_with")
        if mw and n > mw["max"] and (also := [r for r in mw["roles"] if r in roles]):
            raise AdapterError(f"{a.name} takes up to {mw['max']} × {inp['role']} with a {also[0]}")
        if n > inp["max"]:
            raise AdapterError(f"{a.name} takes up to {inp['max']} × {inp['role']}")
        if n and inp.get("needs") and inp["needs"] not in roles:
            raise AdapterError(f"{a.name}: {inp['role']} needs a {inp['needs']} as well")
    filled = [a.inputs[i] for i in dict.fromkeys(used)]
    for x in filled:
        for y in filled:
            if x["set"] and y["set"] and not set(x["set"]) & set(y["set"]):
                raise AdapterError(f"{a.name} takes {x['role']} or {y['role']}, not both")
    pick_model(a, roles)


def pick_model(a: Adapter, roles: list[str]) -> str:
    """The model id a run with these roles goes to: the first of ``models`` that takes them all."""
    if not a.models:
        return a.model
    want = set(roles)
    for m in a.models:
        if want <= set(m["takes"]):
            return m["model"]
    raise AdapterError(f"{a.name} can't take " + " and ".join(dict.fromkeys(roles)) + " together")


def assemble(a: Adapter, files: list[tuple[int, str]], prompt: str, values: dict | None = None) -> tuple[dict, dict[str, list], str]:
    """The request for a run that uses exactly these files, where each one went, and
    the model id it goes to.

    ``files``: (adapter-input index, slot) in the order they're used. Inputs left out
    aren't in the request at all: the model does what these files make it do. ``values``:
    the settings picked, by key; the rest go in at their defaults, and settings these
    inputs decide instead leave the request."""
    if any(not (isinstance(i, int) and 0 <= i < len(a.inputs)) for i, _ in files):
        raise AdapterError(f"{a.name} has no such input")
    used = [i for i, _ in files]
    check(a, used)
    body = copy.deepcopy(a.body)
    _put(body, a.prompt, prompt)
    # Settings first: what an input does to the request (with, drop) has the last word.
    roles = [a.inputs[i]["role"] for i in used]
    on = settings_for(a, roles)
    for s in a.settings:
        if s not in on:
            for path in setting_paths(s):
                _remove(body, path)
    for s in on:
        v = (values or {}).get(s["key"], setting_default(s))
        if not setting_ok(s, v):
            raise AdapterError(f"{a.name}: {s['label']} can't be {v!r}")
        write_setting(body, s, v)
    where: dict[str, list] = {}
    nth: dict[int, int] = {}
    for i, slot in files:
        inp = a.inputs[i]
        value = _fill(copy.deepcopy(inp["value"]), slot)
        at = inp["at"]
        if isinstance(at[0], list):  # one path per file
            at, nth[i] = list(at[nth.get(i, 0)]), nth.get(i, 0) + 1
        else:
            at = list(at)
        if at[-1] == "+":
            lst = _container(body, at[:-1], [])
            if not isinstance(lst, list):
                raise AdapterError(f"{'.'.join(map(str, at[:-1]))} isn't a list")
            lst.append(value)
            where[slot] = at[:-1] + [len(lst) - 1]
        else:
            _put(body, at, value)
            where[slot] = at
    for i in dict.fromkeys(used):
        for path in a.inputs[i]["drop"]:
            _remove(body, list(path))
        for path, value in a.inputs[i]["with"]:
            _put(body, list(path), copy.deepcopy(value))
    return body, where, pick_model(a, roles)
