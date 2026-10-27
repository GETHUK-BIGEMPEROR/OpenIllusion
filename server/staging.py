"""Staging a run: a spec's inputs cropped, sized and copied into a new generation folder.

``prepare_generation`` writes the running manifest the job manager then fills in;
``recipe_manifest`` and ``workflow_file`` are what a finished generation carries.
"""

from __future__ import annotations

import json
import random
import shutil
from pathlib import Path

from PIL import Image

from . import engines, media, paths, prep, settings, storage, store
from . import generation as sc


def resolve_asset(ref: str) -> Path:
    """An input's source: an upload id, ``gen:<id>/<relative path>``, or a template's sample ``tpl:<engine>|<slot>``."""
    if ref.startswith("tpl:"):
        engine_id, _, slot = ref[len("tpl:"):].rpartition("|")
        return engines.default_input(engine_id, slot)
    if ref.startswith("gen:"):
        sid, _, rel = ref[len("gen:"):].partition("/")
        base = store.folder(sid).resolve()
    else:
        base, rel = paths.uploads_dir().resolve(), ref
    p = (base / rel).resolve()
    if base not in p.parents and p != base:
        raise ValueError("asset path escapes its folder")
    if not p.is_file():
        raise FileNotFoundError(f"An input file isn't here anymore ({ref}). Drop it again.")
    if base == paths.uploads_dir().resolve():
        storage.touch(p)
    return p


def _clip_size(src: Path) -> tuple[int, int]:
    info = media.probe(src)
    return int(info["width"] or 0), int(info["height"] or 0)


def input_plans(spec: dict) -> dict[str, prep.Plan]:
    """How each photo and clip of a spec will be cropped and sized, from file headers alone."""
    e = engines.get(spec["engine"])
    shapes = []
    for i in spec.get("inputs", []):
        if not i.get("asset"):
            continue
        if i["slot"].startswith("image:"):
            w, h = media.image_size(resolve_asset(i["asset"]))
        elif i["slot"].startswith("video:"):
            w, h = _clip_size(resolve_asset(i["asset"]))
        else:
            continue
        if w and h:
            shapes.append({"slot": i["slot"], "width": w, "height": h, "crop": i.get("crop"), "size": i.get("size")})
    return prep.plans(engines.run_size(e), shapes)


def prepare_generation(spec: dict, parent: str | None = None, variant_no: int | None = None) -> sc.Manifest:
    """Copy inputs into a new generation folder and write a running manifest."""
    sid = sc.new_id()
    folder = store.folder(sid)
    (folder / "refs").mkdir(parents=True, exist_ok=True)
    strip = settings.load().get("strip_exif", True)
    e = engines.get(spec["engine"])
    if (e.kind == "local" or e.data is not None) and any(p.get("type") == "seed" for p in e.params):
        seed = spec.setdefault("params", {}).get("seed")
        if seed in (None, "") or int(seed) < 0:
            spec["params"]["seed"] = random.randint(0, 2**31 - 1)
        if spec.get("raw"):
            spec["raw"] = json.loads(json.dumps(spec["raw"]).replace(json.dumps(engines.SEED_TOKEN), str(spec["params"]["seed"])))

    # Crop and size every image once, here, so each engine gets what the studio showed.
    pictures: dict[str, Image.Image] = {}
    for raw in spec["inputs"]:
        if raw["slot"].startswith("image:") and raw.get("asset"):
            img = media.open_image(resolve_asset(raw["asset"]))
            pictures[raw["slot"]] = media.strip_exif(img) if strip else img
    shapes = [{"slot": r["slot"], "width": pictures[r["slot"]].width, "height": pictures[r["slot"]].height, "crop": r.get("crop"), "size": r.get("size")}
              for r in spec["inputs"] if r["slot"] in pictures]
    for r in spec["inputs"]:
        if r["slot"].startswith("video:") and r.get("asset"):
            w, h = _clip_size(resolve_asset(r["asset"]))
            if w and h:
                shapes.append({"slot": r["slot"], "width": w, "height": h, "crop": r.get("crop"), "size": r.get("size")})
    size = engines.run_size(e)
    plans = prep.plans(size, shapes)
    chosen = lambda r: prep.choice_of(size, r["slot"], r.get("size"))

    items: list[sc.InputItem] = []
    img_n = 0
    for raw in spec["inputs"]:
        slot = raw["slot"]
        item = sc.InputItem(
            slot=slot, role=raw.get("role", "character"), license=raw.get("license", "unknown"),
            contains_person=bool(raw.get("contains_person")), consent=bool(raw.get("consent")),
            url=raw.get("url") or None, label=raw.get("label"),
        )
        src = resolve_asset(raw["asset"]) if raw.get("asset") else None
        if slot.startswith("image:") and src:
            img_n += 1
            img = pictures[slot]
            if slot in plans:
                img = prep.apply(img, plans[slot])
                item.prep = {**plans[slot].to_dict(), "size": chosen(raw)}
            ext = ".png" if img.mode == "RGBA" else ".jpg"
            rel = f"refs/ref-{img_n:02d}{ext}"
            if ext == ".png":
                img.save(folder / rel, "PNG")
            else:
                img.convert("RGB").save(folder / rel, "JPEG", quality=95)
            item.file, item.width, item.height = rel, img.width, img.height
            item.thumb = media.thumbnail_data_uri(img)
        elif slot.startswith("video:") and src:
            (folder / "driving").mkdir(exist_ok=True)
            trim = raw.get("trim") or [0, 0]
            clips = sum(1 for r in spec["inputs"] if r["slot"].startswith("video:") and r.get("asset"))
            budget = int(media.REQUEST_MEDIA_BUDGET * 0.8 / max(clips, 1))
            _, (lo, hi) = engines.clip_limits(e, slot)
            rel = engines.clip_file(slot)
            info = media.transcode(src, folder / rel, start=float(trim[0] or 0), end=float(trim[1] or 0) or None,
                                   max_bytes=budget, min_fps=lo, max_fps=hi, plan=plans.get(slot))
            if slot in plans:
                item.prep = {**plans[slot].to_dict(), "size": chosen(raw)}
            media.poster(folder / rel, folder / engines.poster_file(rel))
            item.file, item.width, item.height, item.duration = rel, info["width"], info["height"], info["duration"]
            item.trim = [float(trim[0] or 0), float(trim[1] or 0)]
            item.role = "motion"
        elif slot.startswith("audio:") and src:
            (folder / "refs").mkdir(exist_ok=True)
            rel = f"refs/{slot.replace(':', '-')}{src.suffix.lower() or '.mp3'}"
            shutil.copyfile(src, folder / rel)
            item.file = rel
        if item.file:
            item.sha256 = sc.sha256_file(folder / item.file)
        items.append(item)

    template = spec.get("raw") or engines.compose(spec)["template"]
    title = (spec.get("title") or "").strip() or _auto_title(spec)
    if variant_no:
        title = f"{title} · v{variant_no}"
    lineage = sc.Lineage(
        forked_from=spec.get("forked_from"), parent=parent,
        chain=list(spec.get("chain") or []),
    )
    m = sc.Manifest(
        id=sid, title=title, mode=e.mode if e.curated else spec.get("mode", e.mode),
        engine=sc.Engine(kind="local" if e.kind == "local" else "router", model=e.id, provider=e.provider, schema_version=spec.get("schema_version")),
        inputs=items, prompt=spec.get("prompt", ""),
        params=spec.get("params") or {}, request_template=template, status="running",
        tags=spec.get("tags") or [], lineage=lineage,
    )
    store.save(m, shelf="mine")
    _write_workflow(folder, m)
    # Record the other side of a chain (Edit → Motion).
    for ref in m.lineage.chain:
        kind, _, other = ref.partition(":")
        try:
            o = store.get(other)
            if sid not in o.lineage.sent_to:
                o.lineage.sent_to.append(sid)
                store.save(o)
        except Exception:
            pass
    return m


def _write_workflow(folder: Path, m: sc.Manifest) -> None:
    """Local generations carry the workflow that ran, openable in stock ComfyUI."""
    if m.engine.kind != "local":
        return
    (folder / "comfy").mkdir(exist_ok=True)
    (folder / "comfy" / "workflow.json").write_text(json.dumps(workflow_file(m), indent=2), "utf-8")


def workflow_file(m: sc.Manifest) -> dict:
    """The API-format workflow with media tokens swapped for the input filenames.

    ComfyUI loads API-format JSON by drag and drop; the user copies the generation's
    refs into ComfyUI's input folder (or re-picks them) before queueing.
    """
    by_slot = {i.slot: i for i in m.inputs}

    def name(kind, n, form):
        item = by_slot.get(f"{kind}:{n}")
        return Path(item.file).name if item and item.file else f"{kind}_{n}"

    return engines.materialize(m.request_template, name)


def recipe_manifest(m: sc.Manifest, res: sc.Result | None = None) -> dict:
    """The Recipe-only manifest that rides inside output files."""
    d = sc.dump(m)
    d["variant"] = "recipe"
    if res is not None:
        r = res.model_dump(mode="json")
        r.pop("output_file", None)
        d["result"] = r
    for i in d["inputs"]:
        i["file"] = None
    d.pop("starred", None)
    return d


def _auto_title(spec: dict) -> str:
    """A run is named after its template; the prompt shows beside it."""
    return engines.get(spec["engine"]).label.split(" · ")[0].strip() or "Untitled run"


def poster_url(m: sc.Manifest) -> str | None:
    if m.result and m.result.poster:
        return f"/api/generations/{m.id}/file/{m.result.poster}"
    for i in m.inputs:
        if i.slot.startswith("video:") and i.file:
            return f"/api/generations/{m.id}/file/{engines.poster_file(i.file)}"
    for i in m.inputs:
        if i.file:
            return f"/api/generations/{m.id}/file/{i.file}"
    return None
