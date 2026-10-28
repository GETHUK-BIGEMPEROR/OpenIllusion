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
from pathlib import Path
from typing import Any

from .. import fit, media, paths
from .build import TOKEN, MEDIA, _images, _videos, SEED_TOKEN, build_local, reroll, defaults_workflow, fill_media, build_cloud, prune, materialize, tokens_in, file_resolver, run_size
from .contract import Engine, FIELD_TYPES, upgrade, lift_computed, load_template, media_path, shipped_ref, template_dirs, load_templates
from .covers import COVER_SIDE, COVER_LOOP_SECONDS, CACHE_ERA, user_cover, cover_files, cover_file, defaults_info, _cover_info, set_cover, clear_cover, clip_limits, clip_file, poster_file
from .results import VIDEO_EXT, IMAGE_EXT, classify_failure, find_assets, result_media, decode_media, slim, result_seed

__all__ = [
    "TOKEN", "MEDIA", "SEED_TOKEN", "build_local", "reroll", "defaults_workflow", "fill_media",
    "build_cloud", "prune", "materialize", "tokens_in", "file_resolver", "run_size", "Engine",
    "FIELD_TYPES", "upgrade", "lift_computed", "load_template", "template_dirs",
    "load_templates", "COVER_SIDE", "COVER_LOOP_SECONDS", "CACHE_ERA", "user_cover",
    "cover_files", "cover_file", "defaults_info", "set_cover", "clear_cover", "clip_limits",
    "clip_file", "poster_file", "VIDEO_EXT", "IMAGE_EXT", "classify_failure", "find_assets",
    "result_media", "decode_media", "slim", "result_seed", "edit_template", "delete_template",
    "duplicate_template", "reset_template", "ENGINES", "reload_templates",
    "router_model", "get", "describe", "varies", "is_draft", "requirements", "default_input",
    "default_poster", "compose",
]


# ---- editing templates ---------------------------------------------------------
# Edits never touch the shipped file: the whole template is written to the user's
# templates folder, which overrides it by id. Resetting deletes that copy.

_TEXT_LIMIT = {"label": 80, "blurb": 400, "item": 240, "text": 4000, "examples": 12}


def _clean(v: Any, limit: int) -> str:
    if not isinstance(v, str):
        raise ValueError("expected text")
    v = v.strip()
    if len(v) > limit:
        raise ValueError(f"keep it under {limit} characters")
    return v


def _clean_list(v: Any, n: int = 20) -> list[str]:
    if not isinstance(v, list) or len(v) > n:
        raise ValueError(f"expected a list of up to {n} items")
    return [x for x in (_clean(i, _TEXT_LIMIT["item"]) for i in v) if x]


def _edit_input(f: dict, ch: Any) -> None:
    """The prompt's default and ideas. Photos and clips have nothing to edit here: they're named by their place."""
    if not isinstance(ch, dict):
        raise ValueError("expected an object per input")
    if ("default" in ch or "examples" in ch) and f["type"] != "text":
        raise ValueError(f"{f.get('label') or f['key']}: only the prompt takes a default and ideas")
    if "default" in ch:
        f["default"] = _clean(ch["default"], _TEXT_LIMIT["text"])
    if "examples" in ch:
        if not isinstance(ch["examples"], list) or len(ch["examples"]) > _TEXT_LIMIT["examples"]:
            raise ValueError(f"up to {_TEXT_LIMIT['examples']} ideas")
        rows = []
        for x in ch["examples"]:
            x = x if isinstance(x, dict) else {"text": x}
            text = _clean(x.get("text", ""), _TEXT_LIMIT["text"])
            if text:
                rows.append({"label": _clean(x.get("label") or "", _TEXT_LIMIT["item"]) or text[:60], "text": text})
        f["examples"] = rows


def edit_template(engine_id: str, patch: dict) -> Engine:
    e = ENGINES.get(engine_id)
    if e is None or e.data is None or e.path is None:
        raise KeyError(engine_id)
    data = upgrade(copy.deepcopy(e.data))
    if "label" in patch:
        data["label"] = _clean(patch["label"], _TEXT_LIMIT["label"]) or data["label"]
    if "blurb" in patch:
        data["blurb"] = _clean(patch["blurb"], _TEXT_LIMIT["blurb"])
    if "tags" in patch:
        data["tags"] = _clean_list(patch["tags"])
    data.pop("tips", None)
    if "inputs" in patch:
        if not isinstance(patch["inputs"], dict):
            raise ValueError("inputs: expected an object keyed by input")
        by_key = {f["key"]: f for f in data["inputs"]}
        for key, ch in patch["inputs"].items():
            if key not in by_key:
                raise ValueError(f"this template has no input {key!r}")
            _edit_input(by_key[key], ch)
    # Media the template ships with stays where it is, named so any install finds it; a user file is rewritten in place.
    if e.origin != "user":
        for k in ("cover", "cover_video"):
            if data.get(k):
                data[k] = shipped_ref(e.path.parent, data[k])
        for f in data["inputs"]:
            if f.get("type") in MEDIA and f.get("default"):
                f["default"] = shipped_ref(e.path.parent, f["default"])
    dst = e.path if e.origin == "user" else paths.user_root() / "templates" / (re.sub(r"[^A-Za-z0-9._-]+", "__", e.id) + ".json")
    paths.write_atomic(dst, json.dumps(data, indent=2, ensure_ascii=False) + "\n")
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
    for ext in (".webp", ".mp4"):
        user_cover(e.id, ext).unlink(missing_ok=True)
    e.path.unlink(missing_ok=True)
    reload_templates()


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

    data["id"], data["built"] = tid, True
    data["label"] = (e.label.split(" · ")[0] + " (copy)" + (" · " + e.label.split(" · ", 1)[1] if " · " in e.label else ""))[:_TEXT_LIMIT["label"]]
    for k in ("cover", "cover_video"):
        if data.get(k):
            data[k] = take(data[k])
    for f in data.get("inputs") or []:
        if f.get("type") in MEDIA and f.get("default"):
            f["default"] = take(f["default"])
    paths.write_atomic(root / f"{stem}.json", json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    poster, loop = user_cover(e.id), user_cover(e.id, ".mp4")
    for src, dst in ((poster, user_cover(tid)), (loop, user_cover(tid, ".mp4"))):
        if src.is_file():
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(src, dst)
    reload_templates()
    return ENGINES[tid]


def reset_template(engine_id: str) -> Engine:
    e = ENGINES.get(engine_id)
    if e is None or not e.edited or e.path is None:
        raise KeyError(engine_id)
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
        "examples": e.examples, "tags": e.tags, "varies": varies(e), "inputs": e.inputs, "fields": fields, "requires": requirements(e),
        "origin": e.origin, "edited": e.edited, "size": run_size(e), "built": e.built, "model": e.model,
        "defaults": defaults,
        **_cover_info(e), "cover_custom": user_cover(e.id).is_file(), "draft": is_draft(e),
    }


def varies(e: Engine) -> bool:
    """Whether two runs with the same inputs can come out different: the workflow re-rolls a seed
    after each generate (ComfyUI's "randomize"), or the template has a seed setting. Variants need it."""
    if any(p.get("type") == "seed" for p in e.params):
        return True
    return any(m != "fixed" for n in (e.workflow or {}).values()
               for m in ((n.get("_meta") or {}).get("control_after_generate") or {}).values())


def is_draft(e: Engine) -> bool:
    """A built template stays a draft until one of its own results becomes its cover."""
    return e.built and cover_files(e)[0] is None


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
