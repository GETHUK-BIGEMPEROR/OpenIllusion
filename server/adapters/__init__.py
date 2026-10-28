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

from .. import fit

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
    return Adapter(model=model, name=name.strip(), mode="motion" if d["makes"] == "video" else "edit",
                   body=body, prompt=prompt, inputs=inputs, result=[list(p) for p in result],
                   models=[{"model": m["model"], "takes": list(m["takes"])} for m in models],
                   media_mb=float(mmb) if mmb is not None else None)


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


def assemble(a: Adapter, files: list[tuple[int, str]], prompt: str) -> tuple[dict, dict[str, list], str]:
    """The request for a run that uses exactly these files, where each one went, and
    the model id it goes to.

    ``files``: (adapter-input index, slot) in the order they're used. Inputs left out
    aren't in the request at all: the model does what these files make it do."""
    if any(not (isinstance(i, int) and 0 <= i < len(a.inputs)) for i, _ in files):
        raise AdapterError(f"{a.name} has no such input")
    used = [i for i, _ in files]
    check(a, used)
    body = copy.deepcopy(a.body)
    _put(body, a.prompt, prompt)
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
    return body, where, pick_model(a, [a.inputs[i]["role"] for i in used])
