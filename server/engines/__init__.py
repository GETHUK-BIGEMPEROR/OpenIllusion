"""Engines: how studio inputs become a request, and back.

There are two kinds. A *cloud* engine is one Comfy Router model; its request
is the model's own JSON body. A *local* engine is a ComfyUI workflow template
(``templates/local/*.json``); its request is the API-format workflow itself,
with the studio's fields written into the inputs its bindings name.

Either way the request is built as a *template*: media slots appear as tokens
such as ``{{image:1}}`` or ``{{video:1|url}}``. The template is what the Raw
tab shows and what a generation stores; ``materialize`` swaps tokens for real data
(a data URI for Router, an uploaded v2 asset for ComfyUI) just before submit.

The package: ``build`` writes request bodies, ``contract`` reads template files into
an ``Engine``, ``covers`` finds covers and samples, ``results`` reads finished runs.
This module keeps the registry (``ENGINES``), lookups, editing and ``compose``.
"""

from __future__ import annotations

import copy
import json
import re
import time
from pathlib import Path
from typing import Any

from .. import fit, media, paths
from .build import TOKEN, MEDIA, _images, _videos, SEED_TOKEN, build_local, reroll, defaults_workflow, fill_media, build_cloud, prune, materialize, tokens_in, file_resolver, run_size
from .contract import Engine, FIELD_TYPES, upgrade, lift_computed, load_template, media_path, shipped_ref, template_dirs, load_templates
from .covers import COVER_SIDE, COVER_LOOP_SECONDS, CACHE_ERA, BEFORE_EXT, user_cover, cover_files, cover_file, cover_before, lead_slot, lead_is_before, defaults_info, _cover_info, set_cover, clear_cover, clip_limits, clip_file, poster_file
from .results import VIDEO_EXT, IMAGE_EXT, classify_failure, find_assets, result_media, decode_media, slim, result_seed

__all__ = [
    "TOKEN", "MEDIA", "SEED_TOKEN", "build_local", "reroll", "defaults_workflow", "fill_media",
    "build_cloud", "prune", "materialize", "tokens_in", "file_resolver", "run_size", "Engine",
    "FIELD_TYPES", "upgrade", "lift_computed", "load_template", "template_dirs",
    "load_templates", "COVER_SIDE", "COVER_LOOP_SECONDS", "CACHE_ERA", "BEFORE_EXT", "user_cover",
    "cover_files", "cover_file", "cover_before", "lead_slot", "defaults_info", "set_cover", "clear_cover", "clip_limits",
    "clip_file", "poster_file", "VIDEO_EXT", "IMAGE_EXT", "classify_failure", "find_assets",
    "result_media", "decode_media", "slim", "result_seed", "edit_template", "delete_template",
    "duplicate_template", "reset_template", "run_changes", "run_differs", "adopt_run", "ENGINES", "reload_templates",
    "router_model", "get", "describe", "varies", "requirements", "default_input",
    "default_poster", "compose",
]


# ---- editing templates ---------------------------------------------------------
# Edits never touch the shipped file: the whole template is written to the user's
# templates folder, which overrides it by id. Resetting deletes that copy.

_TEXT_LIMIT = {"label": 80, "blurb": 400, "text": 4000, "model_name": 40}


def _clean(v: Any, limit: int) -> str:
    if not isinstance(v, str):
        raise ValueError("expected text")
    v = v.strip()
    if len(v) > limit:
        raise ValueError(f"keep it under {limit} characters")
    return v


def _edit_input(f: dict, ch: Any) -> None:
    """The prompt's default. Photos and clips have nothing to edit here: they're named by their place."""
    if not isinstance(ch, dict):
        raise ValueError("expected an object per input")
    if "default" in ch and f["type"] != "text":
        raise ValueError(f"{f.get('label') or f['key']}: only the prompt takes a default")
    if "default" in ch:
        f["default"] = _clean(ch["default"], _TEXT_LIMIT["text"])
    f.pop("examples", None)


def edit_template(engine_id: str, patch: dict) -> Engine:
    e = ENGINES.get(engine_id)
    if e is None or e.data is None or e.path is None:
        raise KeyError(engine_id)
    data = upgrade(copy.deepcopy(e.data))
    if "label" in patch:
        data["label"] = _clean(patch["label"], _TEXT_LIMIT["label"]) or data["label"]
    if "blurb" in patch:
        data["blurb"] = _clean(patch["blurb"], _TEXT_LIMIT["blurb"])
    if "model_name" in patch and e.kind == "local":
        data["model_name"] = _clean(patch["model_name"], _TEXT_LIMIT["model_name"])
    data.pop("tips", None)
    data.pop("tags", None)  # templates had tags once; Explore no longer shows them
    if "inputs" in patch:
        if not isinstance(patch["inputs"], dict):
            raise ValueError("inputs: expected an object keyed by input")
        by_key = {f["key"]: f for f in data["inputs"]}
        for key, ch in patch["inputs"].items():
            if key not in by_key:
                raise ValueError(f"this template has no input {key!r}")
            _edit_input(by_key[key], ch)
    # Media the template ships with stays where it is, named so any install finds it; a user file is rewritten in place.
    dst = _edit_target(e, data)
    paths.write_atomic(dst, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    reload_templates()
    return ENGINES[e.id]


def _edit_target(e: Engine, data: dict) -> Path:
    """Where an edit of this template is written: its own file when it's yours, else a copy in your
    templates folder that overrides it by id. That copy names the shipped media so any install finds it."""
    if e.origin == "user":
        return e.path
    for k in ("cover", "cover_video"):
        if data.get(k):
            data[k] = shipped_ref(e.path.parent, data[k])
    for f in data["inputs"]:
        if f.get("type") in MEDIA and f.get("default"):
            f["default"] = shipped_ref(e.path.parent, f["default"])
    return paths.user_root() / "templates" / (re.sub(r"[^A-Za-z0-9._-]+", "__", e.id) + ".json")


# ---- a run as a template's starting point --------------------------------------
# "Use as cover" can also keep what the run used: its prompt, settings and files become what
# Create opens with, and they're written into the workflow (or request body) itself, so the
# workflow you download makes what the cover shows.

def _sha256(p: Path | None) -> str | None:
    if p is None or not p.is_file():
        return None
    import hashlib

    h = hashlib.sha256()
    with p.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _keepable(f: dict, v: Any) -> Any:
    """A run's value for a setting in the form the template keeps as its default; None when it can't be one."""
    t = f.get("type")
    if v is None or t == "seed":
        return None
    if f.get("options"):
        return next((o for o in f["options"] if str(o) == str(v)), None)
    if t == "bool":
        return v if isinstance(v, bool) else None
    if t in ("int", "number"):
        try:
            n = int(float(v)) if t == "int" else float(v)
        except (TypeError, ValueError):
            return None
        return n if f.get("min", n) <= n <= f.get("max", n) else None
    return v if isinstance(v, str) else None


def run_changes(e: Engine, m: Any, folder: Path) -> list[tuple[str, str, Any]]:
    """What a run used that the template doesn't open with: (what, input key, value), where what is
    "default" (the prompt or a setting), "aspect" (the output shape) or "file" (a photo or clip)."""
    out: list[tuple[str, str, Any]] = []
    for f in e.fields:
        k, t = f["key"], f.get("type")
        if t in MEDIA:
            item = next((i for i in m.inputs if i.slot == k and i.file), None)
            src = folder / item.file if item else None
            if src and src.is_file() and (item.sha256 or _sha256(src)) != _sha256(e.default_inputs.get(k)):
                out.append(("file", k, src))
        elif t == "text":
            if k == "prompt" and m.prompt.strip() and m.prompt != e.default_prompt:
                out.append(("default", k, m.prompt))
        elif t == "size":
            canvas = (e.size or {}).get("canvas") or {}
            steps = {o["label"] for o in [*e.size.get("options", []), *e.size.get("more", [])] if o.get("px")} if e.size else set()
            steps |= {f"{x:g} MP" for x in canvas.get("steps") or []}
            aspect, step = m.params.get("aspect"), m.params.get("out_size")
            if aspect in (canvas.get("aspects") or []) and aspect != f.get("aspect", canvas.get("aspect")):
                out.append(("aspect", k, aspect))
            if step in steps and step != f.get("default", canvas.get("size")):
                out.append(("default", k, step))
        elif k in m.params:
            v = _keepable(f, m.params[k])
            if v is not None and v != f.get("default"):
                out.append(("default", k, v))
    return out


def run_differs(e: Engine, m: Any, folder: Path) -> list[str]:
    """The inputs a run changed, by the names Create shows them under, in the template's order."""
    labels = {f["key"]: f.get("label") or f["key"] for f in e.fields}
    return list(dict.fromkeys(labels[k] for _, k, _ in run_changes(e, m, folder)))


def _bake(e: Engine, data: dict) -> None:
    """Write a template's defaults where its inputs are bound in ``data``'s workflow or request body.
    Seeds keep whatever the file says; media slots keep their tokens."""
    params = {f["key"]: f["default"] for f in e.params if f.get("default") is not None and f.get("type") != "seed"}
    size = next((f for f in e.fields if f.get("type") == "size"), None)
    if size:
        params.setdefault("aspect", size.get("aspect"))
        params.setdefault("out_size", size.get("default"))
    spec = {"inputs": [{"slot": i["slot"]} for i in e.inputs], "prompt": e.default_prompt, "params": params}
    keys = [k for k in e.bindings if k in ("prompt", "size") or (k.startswith("params.") and k[len("params."):] in params)]
    if e.kind == "local" and data.get("workflow"):
        wf, own = build_local(e, spec), data["workflow"]
        for k in keys:
            for t in e.bindings[k]:
                n, inp = str(t[0]), t[1]
                if n in own and inp in wf.get(n, {}).get("inputs", {}):
                    own[n]["inputs"][inp] = wf[n]["inputs"][inp]
    elif e.kind == "cloud" and data.get("body"):
        from .build import _set

        body = build_cloud(e, spec)
        for k in keys:
            for t in e.bindings[k]:
                path = list(t[0] if k == "size" else t)
                try:
                    if k == "prompt":  # as written: the model's names for the files are put in per run
                        v = e.default_prompt
                    else:
                        v = body
                        for p in path:
                            v = v[p]
                    _set(data["body"], path, v)
                except (KeyError, IndexError, TypeError):
                    continue  # left out of the request ("Auto"): the file keeps what it has


def adopt_run(engine_id: str, m: Any, folder: Path) -> Engine:
    """Make a run the template's starting point (see ``run_changes``). Files are copied in beside the
    template; a sample of yours the template no longer opens with is removed."""
    import shutil

    e = ENGINES.get(engine_id)
    if e is None or e.data is None or e.path is None:
        raise KeyError(engine_id)
    changes = run_changes(e, m, folder)
    if not changes:
        return e
    data = lift_computed(upgrade(copy.deepcopy(e.data)))
    data.pop("tips", None)
    data.pop("tags", None)
    dst = _edit_target(e, data)
    media_dir = dst.parent / "media" / dst.stem
    by_key = {f["key"]: f for f in data["inputs"]}
    dropped: list[Path] = []
    for what, k, v in changes:
        f = by_key[k]
        if what == "file":
            media_dir.mkdir(parents=True, exist_ok=True)
            name = f"{re.sub(r'[^A-Za-z0-9._-]+', '-', k)}-{m.id[:8]}{v.suffix.lower()}"
            shutil.copyfile(v, media_dir / name)
            if f.get("default"):
                dropped.append(media_path(dst.parent, f["default"]).resolve())
            f["default"] = f"media/{dst.stem}/{name}"
        elif what == "aspect":
            f["aspect"] = v
        else:
            f["default"] = v
    _bake(load_template(copy.deepcopy(data), dst.parent), data)
    paths.write_atomic(dst, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    kept = {media_path(dst.parent, f["default"]).resolve() for f in data["inputs"] if f.get("type") in MEDIA and f.get("default")}
    kept |= {media_path(dst.parent, data[k]).resolve() for k in ("cover", "cover_video") if data.get(k)}
    for old in dropped:
        if old.parent == media_dir.resolve() and old not in kept:
            old.unlink(missing_ok=True)
    reload_templates()
    return ENGINES[e.id]


def delete_template(engine_id: str) -> None:
    """Remove a template made in the builder, with its media and custom cover."""
    e = ENGINES.get(engine_id)
    if e is None or not e.built or e.origin != "user" or e.edited or e.path is None:
        raise KeyError(engine_id)
    import shutil

    media_dir = e.path.parent / "media" / e.path.stem
    if media_dir.is_dir() and media_dir.parent == e.path.parent / "media":
        shutil.rmtree(media_dir, ignore_errors=True)
    for ext in (".webp", ".mp4", *BEFORE_EXT):
        user_cover(e.id, ext).unlink(missing_ok=True)
    e.path.unlink(missing_ok=True)
    reload_templates()


def publish_template(engine_id: str) -> Engine:
    """Put a draft on Explore: the template file loses its draft mark."""
    e = ENGINES.get(engine_id)
    if e is None or not e.draft or e.origin != "user" or e.path is None:
        raise KeyError(engine_id)
    data = json.loads(e.path.read_text("utf-8"))
    data.pop("draft", None)
    paths.write_atomic(e.path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    reload_templates()
    return ENGINES[engine_id]


def duplicate_template(engine_id: str) -> Engine:
    """Copy a template into the user's folder as a new one they own: editable, deletable,
    with its samples and cover copied alongside so it never depends on the original."""
    e = ENGINES.get(engine_id)
    if e is None or e.data is None or e.path is None:
        raise KeyError(engine_id)
    import shutil

    data = upgrade(copy.deepcopy(e.data))
    prefix = "cloud/" if e.kind == "cloud" else "local/"
    base = re.sub(r"-copy(-\d+)?$", "", e.id.split("/", 1)[-1])
    n, tid = 1, f"{prefix}{base}-copy"
    while tid in ENGINES:
        n += 1
        tid = f"{prefix}{base}-copy-{n}"
    stem = re.sub(r"[^A-Za-z0-9._-]+", "__", tid)
    root = paths.user_root() / "templates"
    media_dir = root / "media" / stem
    media_dir.mkdir(parents=True, exist_ok=True)

    def take(rel: str) -> str:
        src = media_path(e.path.parent, rel).resolve()
        if not src.is_file():
            return rel
        shutil.copyfile(src, media_dir / src.name)
        return f"media/{stem}/{src.name}"

    data["id"], data["built"], data["added"] = tid, True, time.time()
    data["label"] = (e.label + " (copy)")[:_TEXT_LIMIT["label"]]
    for k in ("cover", "cover_video"):
        if data.get(k):
            data[k] = take(data[k])
    for f in data.get("inputs") or []:
        if f.get("type") in MEDIA and f.get("default"):
            f["default"] = take(f["default"])
    paths.write_atomic(root / f"{stem}.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    for src, dst in ((user_cover(e.id, x), user_cover(tid, x)) for x in (".webp", ".mp4", *BEFORE_EXT)):
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
    reload_templates()
    return ENGINES[tid]


def reset_template(engine_id: str) -> Engine:
    e = ENGINES.get(engine_id)
    if e is None or not e.edited or e.path is None:
        raise KeyError(engine_id)
    import shutil

    # The edited copy's own media goes with it: nothing else points there.
    media_dir = e.path.parent / "media" / e.path.stem
    if media_dir.is_dir() and media_dir.parent == e.path.parent / "media":
        shutil.rmtree(media_dir, ignore_errors=True)
    e.path.unlink(missing_ok=True)
    reload_templates()
    return ENGINES[engine_id]


# Templates live in templates/local/*.json (shipped) and the user's templates
# folder. Each one is added after it has been run end to end; any other Router
# model is still reachable through ``get`` with a form built from its schema.
ENGINES: dict[str, Engine] = {}


def reload_templates() -> None:
    for k in [k for k, e in ENGINES.items() if e.data is not None]:
        ENGINES.pop(k)
    ENGINES.update(load_templates())


reload_templates()


def router_model(engine_id: str) -> str:
    """The Router model a cloud engine id sends to: a template's model, else the id itself."""
    e = ENGINES.get(engine_id)
    return e.model if e is not None and e.model else engine_id


def get(engine_id: str) -> Engine:
    if engine_id in ENGINES:
        return ENGINES[engine_id]
    raise KeyError(f"No template {engine_id!r}")


def describe(e: Engine) -> dict:
    defaults = defaults_info(e)
    samples = {i["slot"]: i for i in defaults["inputs"]}
    # Every input in order, as the studio draws it. A photo or clip carries its sample as an asset, not a path,
    # and what the model takes in it: its fit, and a clip's length and frame rates.
    def limits(f: dict) -> dict:
        ft = fit.of(e, f["key"])
        if f["type"] != "video":
            return {"fit": ft} if ft else {}
        window, rate = clip_limits(e, f["key"])
        return {**({"fit": ft} if ft else {}), **({"window": list(window)} if window else {}), "fps": list(rate)}
    fields = [{k: v for k, v in f.items() if not (f["type"] in MEDIA and k == "default")} | ({"sample": samples.get(f["key"]), **limits(f)} if f["type"] in MEDIA else {})
              for f in e.fields]
    return {
        "id": e.id, "mode": e.mode, "label": e.label, "provider": e.provider, "blurb": e.blurb,
        "max_images": e.max_images, "min_images": e.min_images, "needs_video": e.needs_video,
        "video_window": e.video_window, "fps_window": e.fps_window, "url_only": e.url_only,
        "params": e.params, "curated": e.curated, "kind": e.kind, "source": e.source, "prompt": e.prompt,
        "varies": varies(e), "inputs": e.inputs, "fields": fields, "requires": requirements(e),
        "origin": e.origin, "edited": e.edited, "size": run_size(e), "built": e.built, "draft": e.draft, "model": e.model,
        "defaults": defaults, "mentions": mentions_of(e), "hidden": e.id in hidden_templates(), "before": lead_is_before(e), "model_name": model_name(e), "workflow_model": e.model_name if e.kind == "local" else None,
        **_cover_info(e), "cover_custom": user_cover(e.id).is_file(), "added": added(e),
    }


def added(e: Engine) -> float | None:
    """When a template joined this app, for Explore's Newest: a shipped one the day it shipped, one of
    yours when you made, copied or added it. An older file of yours without a stamp: its file's time."""
    stamp = (e.data or {}).get("added")
    if isinstance(stamp, (int, float)):
        return float(stamp)
    if e.origin != "user" or not e.built:
        return None
    try:
        return e.path.stat().st_mtime if e.path else None
    except OSError:
        return None


def model_name(e: Engine) -> str:
    """The model under a template's name: a Router model's own name; a workflow's as its author named it
    (only they know it), else "ComfyUI workflow"."""
    from .. import adapters

    a = adapters.for_model(e.model or "") if e.kind == "cloud" else None
    m = a.name if a else e.model_name
    return m or ("ComfyUI workflow" if e.kind == "local" else e.provider or "")


def mentions_of(e: Engine) -> dict:
    """How a cloud template's prompt names its files (its model's adapter); local workflows name their own."""
    if e.kind != "cloud":
        return {}
    from .. import adapters

    a = adapters.for_model(e.model or "")
    return a.mentions if a else dict(adapters.MENTIONS)


def hidden_templates() -> set[str]:
    from .. import settings

    v = settings.load().get("hidden_templates")
    return {x for x in v if isinstance(x, str)} if isinstance(v, list) else set()


def hide_template(engine_id: str, hidden: bool) -> None:
    """Take a shipped template off Explore, or put it back. Its file stays: an update would bring it back."""
    if engine_id not in ENGINES:
        raise KeyError(engine_id)
    from .. import settings

    now = hidden_templates()
    now = now | {engine_id} if hidden else now - {engine_id}
    settings.save({"hidden_templates": sorted(now)})


def varies(e: Engine) -> bool:
    """Whether two runs with the same inputs can come out different: the workflow re-rolls a seed
    after each generate (ComfyUI's "randomize"), or the template has a seed setting. Variants need it."""
    if any(p.get("type") == "seed" for p in e.params):
        return True
    return any(m != "fixed" for n in (e.workflow or {}).values()
               for m in ((n.get("_meta") or {}).get("control_after_generate") or {}).values())


def sound_from(e: Engine, params: dict) -> str | None:
    """The clip whose own sound a run's result takes: fixed by the template (cloud), or the
    keep_sound option picked (a setting left out of ``params`` is at its default)."""
    if e.keep_sound:
        return e.keep_sound
    for f in e.fields:
        ks = f.get("keep_sound")
        if ks and str(params.get(f["key"], f.get("default"))) == str(ks["option"]):
            return ks["slot"]
    return None


def requirements(e: Engine) -> dict:
    """What a local template needs in ComfyUI: model files by folder, and node types."""
    if e.kind != "local" or not e.workflow:
        return {"models": [], "nodes": []}
    hinted = e.hints.get("models", {})
    models = sorted(
        {(v, hinted.get(v, {}).get("folder", "")) for n in e.workflow.values() for v in n.get("inputs", {}).values()
         if isinstance(v, str) and v.endswith((".safetensors", ".ckpt", ".pt", ".pth", ".gguf"))}
    )
    return {
        "models": [{"name": m, "folder": f, "url": hinted.get(m, {}).get("url")} for m, f in models],
        "nodes": sorted({n["class_type"] for n in e.workflow.values()}),
    }


def default_input(engine_id: str, slot: str) -> Path:
    """The sample file a template opens a slot with."""
    e = ENGINES.get(engine_id)
    p = e.default_inputs.get(slot) if e else None
    if p is None or not p.is_file():
        raise FileNotFoundError(f"{engine_id} has no sample for {slot}")
    return p


def default_poster(engine_id: str, slot: str) -> Path:
    """A still of a sample clip, made once and kept in the cache."""
    src = default_input(engine_id, slot)
    dst = paths.cache_dir() / "samples" / f"{re.sub(r'[^A-Za-z0-9._-]+', '__', engine_id + '|' + slot)}-{src.stat().st_mtime_ns}.webp"
    if not dst.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        media.poster(src, dst)
    return dst


def compose(spec: dict) -> dict:
    """Studio state → request template plus warnings. Never rewrites the prompt."""
    e = get(spec["engine"])
    warnings: list[dict] = []
    imgs, vids = _images(spec["inputs"]), _videos(spec["inputs"])
    if len(imgs) > e.max_images:
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} takes at most {e.max_images} images"})
    given = {i.get("slot") for i in spec["inputs"]}
    if e.fields:
        # Which input is missing, by its place: "Add Image 1".
        for f in e.fields:
            if f["type"] in MEDIA and f.get("required", True) and f["key"] not in given:
                warnings.append({"field": "video" if f["type"] == "video" else "inputs", "level": "error", "text": f"Add {f['label']}"})
    elif len(imgs) < e.min_images:
        n = e.min_images
        warnings.append({"field": "inputs", "level": "error", "text": f"{e.label} needs at least {n} image{'' if n == 1 else 's'}"})
    for v in vids:  # longer than the model takes is cut at the run (staging.fitted); shorter can't run
        window, _ = clip_limits(e, v["slot"])
        d = v.get("trimmed_duration") or v.get("duration")
        if window and d and d < window[0] - 0.05:
            f = next((f for f in e.fields if f["key"] == v["slot"]), None)
            what = f["label"] if f else "The clip"
            warnings.append({"field": "video", "level": "error", "text": f"{what} is {d:.1f} s; it needs at least {window[0]:g} s"})
    if e.url_only:
        for i in spec["inputs"]:
            if not i.get("url"):
                warnings.append({"field": i["slot"], "level": "error", "text": f"{e.label} takes public URLs only. Add a link for {i['slot']}."})
    prompt_required = bool(e.prompt and e.prompt.get("required", True))
    if not spec.get("prompt", "").strip() and prompt_required:
        warnings.append({"field": "prompt", "level": "error", "text": "Write a prompt"})
    if spec.get("raw"):
        template = spec["raw"]
    else:
        template = e.build(spec)
    return {"template": template, "warnings": warnings}
