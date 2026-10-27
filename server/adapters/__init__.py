"""Router adapters: one hand-written JSON file per supported Comfy Router model.

Router's request format differs for every model, so nothing is guessed from specs.
An adapter says which files a model takes, where each goes in the request and in
what form, where the prompt goes, the request it starts from, and where the result
comes back. The Builder offers only models with an adapter. A template built from
one carries its own copy of the request, cut down to the inputs its run used.

Adapter file::

    {
      "model": "provider/model", "name": "Shown name", "makes": "photo" | "video",
      "body":   { ...the starting request, the model's own settings... },
      "prompt": ["path", "to", "the", "prompt"],
      "inputs": [
        { "role": "First frame", "type": "image", "at": ["path", "into", "body"],
          "value": "{{$|uri}}" | { ...object holding tokens... },
          "max": 1, "set": "frames", "needs": "Another role" }
      ],
      "result": [["path", "*", "into", "the", "answer"]]
    }

- ``at`` ending in ``"+"`` appends the value to a list (made if missing), so an
  input can take up to ``max`` files.
- Tokens: ``{{$|uri}}`` data URI, ``{{$|b64}}`` bare base64, ``{{$|mime}}`` its MIME
  type. ``$`` becomes the input's slot (``image:1``) when a template is put together.
- ``set``: inputs in different sets can't be used together (first + last frame, or
  references). ``needs``: the role that must be filled as well.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HERE = Path(__file__).parent
MODEL_ID = re.compile(r"[\w.-]+/[\w.:-]+")
TOKEN = re.compile(r"\{\{\$\|(uri|b64|mime)\}\}")
KINDS = ("image", "video")


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


def _path(p: Any, what: str, plus: bool = False) -> list:
    ok = isinstance(p, list) and p and all(isinstance(k, str) or (isinstance(k, int) and not isinstance(k, bool) and k >= 0) for k in p)
    if not ok or ("+" in p and not (plus and p.index("+") == len(p) - 1)):
        raise AdapterError(f"{what}: a path into the request")
    return p


def _tokens(v: Any) -> int:
    if isinstance(v, str):
        if "{{" in v and not TOKEN.fullmatch(v):
            raise AdapterError(f"{v!r}: tokens are {{{{$|uri}}}}, {{{{$|b64}}}} or {{{{$|mime}}}}, alone in a string")
        return 1 if TOKEN.fullmatch(v) else 0
    if isinstance(v, dict):
        return sum(_tokens(x) for x in v.values())
    if isinstance(v, list):
        return sum(_tokens(x) for x in v)
    return 0


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
    inputs = d.get("inputs") or []
    roles = [i.get("role") for i in inputs]
    if len(set(roles)) != len(roles) or not all(isinstance(r, str) and r for r in roles):
        raise AdapterError(f"{model}: every input has its own role")
    for i in inputs:
        at = _path(i.get("at"), f"{model} {i['role']}", plus=True)
        if i.get("type") not in KINDS:
            raise AdapterError(f"{model} {i['role']}: type is image or video")
        if not _tokens(i.get("value")):
            raise AdapterError(f"{model} {i['role']}: value holds the file as a token")
        mx = i.get("max", 1)
        if not isinstance(mx, int) or not 1 <= mx <= 9 or (mx > 1 and at[-1] != "+"):
            raise AdapterError(f"{model} {i['role']}: max is 1 to 9, and above 1 the path ends in +")
        if i.get("needs") is not None and i["needs"] not in roles:
            raise AdapterError(f"{model} {i['role']}: needs names another input's role")
    result = d.get("result")
    if not isinstance(result, list) or not result or not all(isinstance(p, list) and p and all(isinstance(k, (str, int)) for k in p) for p in result):
        raise AdapterError(f"{model}: result lists paths into the answer")
    name = d.get("name") if isinstance(d.get("name"), str) and d["name"].strip() else model.split("/", 1)[1]
    return Adapter(model=model, name=name.strip(), mode="motion" if d["makes"] == "video" else "edit",
                   body=body, prompt=prompt, inputs=[dict(i) for i in inputs], result=[list(p) for p in result])


_cache: dict[str, Adapter] | None = None


def all_adapters() -> dict[str, Adapter]:
    """Every adapter in this folder, by model id."""
    global _cache
    if _cache is None:
        out: dict[str, Adapter] = {}
        for f in sorted(HERE.glob("*.json")):
            a = parse(json.loads(f.read_text("utf-8")))
            out[a.model] = a
        _cache = out
    return _cache


def get(model: str) -> Adapter:
    a = all_adapters().get(model or "")
    if a is None:
        raise AdapterError(f"{model or 'That model'} has no adapter. Router templates can use: " + ", ".join(a.name for a in all_adapters().values()))
    return a


def describe(a: Adapter) -> dict:
    """What the Builder shows: the model, what it makes, and every input it takes."""
    return {
        "model": a.model, "name": a.name, "mode": a.mode,
        "inputs": [{"role": i["role"], "type": i["type"], "max": i.get("max", 1),
                    **({"set": i["set"]} if i.get("set") else {}), **({"needs": i["needs"]} if i.get("needs") else {})} for i in a.inputs],
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


def check(a: Adapter, used: list[int]) -> None:
    """Can the model take these inputs together? ``used``: one adapter-input index per file."""
    roles = [a.inputs[i]["role"] for i in used]
    for i, inp in enumerate(a.inputs):
        n = used.count(i)
        if n > inp.get("max", 1):
            raise AdapterError(f"{a.name} takes up to {inp.get('max', 1)} × {inp['role']}")
        if n and inp.get("needs") and inp["needs"] not in roles:
            raise AdapterError(f"{a.name}: {inp['role']} needs a {inp['needs']} as well")
    sets = {a.inputs[i]["set"]: a.inputs[i]["role"] for i in used if a.inputs[i].get("set")}
    if len(sets) > 1:
        x, y = list(sets.values())[:2]
        raise AdapterError(f"{a.name} takes {x} or {y}, not both")


def assemble(a: Adapter, files: list[tuple[int, str]], prompt: str) -> tuple[dict, dict[str, list]]:
    """The request for a run that uses exactly these files, and where each one went.

    ``files``: (adapter-input index, slot) in the order they're used. Inputs left out
    aren't in the request at all: the model does what these files make it do."""
    if any(not (isinstance(i, int) and 0 <= i < len(a.inputs)) for i, _ in files):
        raise AdapterError(f"{a.name} has no such input")
    check(a, [i for i, _ in files])
    body = copy.deepcopy(a.body)
    _put(body, a.prompt, prompt)
    where: dict[str, list] = {}
    for i, slot in files:
        inp = a.inputs[i]
        value = _fill(copy.deepcopy(inp["value"]), slot)
        at = list(inp["at"])
        if at[-1] == "+":
            lst = _container(body, at[:-1], [])
            if not isinstance(lst, list):
                raise AdapterError(f"{'.'.join(map(str, at[:-1]))} isn't a list")
            lst.append(value)
            where[slot] = at[:-1] + [len(lst) - 1]
        else:
            _put(body, at, value)
            where[slot] = at
    return body, where
