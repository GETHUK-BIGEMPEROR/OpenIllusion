"""Staging a run: a spec's inputs cropped, sized and copied into a new generation folder.

``prepare_generation`` writes the running manifest the job manager then fills in;
``recipe_manifest`` and ``workflow_file`` are what a finished generation carries.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass, field
from pathlib import Path

from PIL import Image

from . import engines, fit, media, paths, prep, settings, storage, store
from . import generation as sc


def resolve_asset(ref: str) -> Path:
    """An input's source: an upload id, ``gen:<id>/<relative path>`` or a template's sample ``tpl:<engine>|<slot>``."""
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


@dataclass
class Fitted:
    """What a run does to each input: the crop and size of every photo and clip, the seconds of
    every clip and sound it sends, the most bytes each file may be, and what to tell the user."""
    plans: dict[str, prep.Plan] = field(default_factory=dict)
    spans: dict[str, tuple[float, float]] = field(default_factory=dict)
    bytes: dict[str, int | None] = field(default_factory=dict)
    notes: list[dict] = field(default_factory=list)  # compose warnings: info for what changes, error for what can't run

    @property
    def errors(self) -> list[dict]:
        return [n for n in self.notes if n["level"] == "error"]


def fitted(spec: dict, template: dict | None = None) -> Fitted:
    """Every input of a spec fitted to its template (the size steps the studio offers) and to the
    model (``fit``: sides, shape, length, frame rate, file size), from file headers alone.
    The studio shows it; staging does exactly this."""
    e = engines.get(spec["engine"])
    out = Fitted()
    fields = {f["key"]: f for f in e.fields if f["type"] in ("image", "video", "audio")}
    srcs = {f: fit.source(e, x) for f, x in fields.items()}
    shapes, probes = [], {}
    for i in spec.get("inputs", []):
        slot = i["slot"]
        if not i.get("asset"):
            continue
        src = resolve_asset(i["asset"])
        if slot.startswith("image:"):
            w, h = media.image_size(src)
        elif slot.startswith("video:"):
            probes[slot] = media.probe(src)
            w, h = int(probes[slot]["width"] or 0), int(probes[slot]["height"] or 0)
        else:
            probes[slot] = media.audio_info(src)
            continue
        if w and h:
            shapes.append({"slot": slot, "width": w, "height": h, "crop": i.get("crop"), "size": i.get("size")})
    out.plans = prep.plans(engines.run_size(e), shapes)
    name = lambda slot: (fields.get(slot) or {}).get("label") or slot
    a = fit.adapters.for_model(e.model) if e.kind != "local" and e.model else None
    who = a.name if a else "the template"

    def note(slot: str, what: list[str], level: str = "info") -> None:
        if what:
            out.notes.append({"field": "video" if slot.startswith("video:") and level == "error" else slot, "level": level,
                              "text": f"{name(slot)} {', '.join(what)}" if level == "error" else f"{name(slot)}: {', '.join(what)} to fit {who}"})

    for slot, p in list(out.plans.items()):
        ft = (srcs.get(slot) or ({}, ""))[0]
        out.plans[slot], changed = fit.plan(p, ft, even=slot.startswith("video:"))
        note(slot, changed)

    # Clips and sounds: where each starts and ends, cut to the most the model takes, and to what a total leaves.
    used: dict[str, float] = {}
    for i in spec.get("inputs", []):
        slot = i["slot"]
        if not slot.startswith(("video:", "audio:")) or not (i.get("asset") or i.get("duration")):
            continue
        ft, group = srcs.get(slot) or ({}, slot)
        dur = float((probes.get(slot) or {}).get("duration") or i.get("duration") or 0)
        if not dur and slot.startswith("audio:") and i.get("asset"):
            note(slot, ["can't be read as sound. Try an MP3 or WAV"], "error")
            continue
        window = engines.clip_limits(e, slot)[0] if slot.startswith("video:") else (fit.lo(ft, "seconds"), fit.hi(ft, "seconds"))
        left = ft["total"] - used.get(group, 0.0) if ft.get("total") else None
        if left is not None and left <= 0.05:
            note(slot, [f"has no time left: the ones before it use all {ft['total']:g} s"], "error")
            continue
        a, b, cut, bad = fit.span(dur, i.get("trim"), window, left)
        out.spans[slot] = (a, b)
        used[group] = used.get(group, 0.0) + (b - a)
        if bad:
            note(slot, [bad], "error")
        elif cut:
            note(slot, [cut])
        if slot.startswith("video:"):
            rate, (f_lo, f_hi) = float((probes.get(slot) or {}).get("fps") or 0), engines.clip_limits(e, slot)[1]
            if rate and not f_lo - 0.01 <= rate <= f_hi + 0.01 and ft.get("fps"):
                note(slot, [f"plays at {min(max(rate, f_lo), f_hi):g} fps"])

    # File sizes: each one's own limit, and an even share of what one request may carry inline.
    tpl = template if template is not None else (spec.get("raw") or engines.compose(spec)["template"])
    forms: dict[str, set] = {}
    for kind, n, form in engines.tokens_in(tpl):
        forms.setdefault(f"{kind}:{n}", set()).add(form)
    filled = [i["slot"] for i in spec.get("inputs", []) if i.get("asset")]
    inline = [s for s in filled if forms.get(s, set()) - {"url"}] if e.kind != "local" else []
    share = fit.media_budget(e) // max(1, len(inline))
    clips = sum(1 for s in filled if s.startswith("video:"))
    for slot in filled:
        mb = (srcs.get(slot) or ({}, ""))[0].get("mb")
        own = int(mb * fit.MB * 0.97) if mb else None
        if slot.startswith("video:") and own is None:
            own = int(media.REQUEST_MEDIA_BUDGET * 0.8 / max(clips, 1))  # no published limit: what Router's cap leaves each clip
        out.bytes[slot] = min([v for v in (own, share if slot in inline else None) if v], default=None)
    return out


def input_plans(spec: dict) -> dict[str, prep.Plan]:
    """How each photo and clip of a spec will be cropped and sized, from file headers alone."""
    return fitted(spec).plans


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
    template = spec.get("raw") or engines.compose(spec)["template"]
    fx = fitted(spec, template)
    if fx.errors:
        raise ValueError(fx.errors[0]["text"])
    plans = fx.plans
    size = engines.run_size(e)
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
            # Under the model's file size, and its share of what the request carries inline.
            dst = media.save_image(img, folder / f"refs/ref-{img_n:02d}", fx.bytes.get(slot))
            item.file, (item.width, item.height) = f"refs/{dst.name}", media.image_size(dst)
            item.thumb = media.thumbnail_data_uri(img)
        elif slot.startswith("video:") and src:
            (folder / "driving").mkdir(exist_ok=True)
            start, end = fx.spans.get(slot) or (0.0, 0.0)
            _, (lo, hi) = engines.clip_limits(e, slot)
            rel = engines.clip_file(slot)
            info = media.transcode(src, folder / rel, start=start, end=end or None,
                                   max_bytes=fx.bytes.get(slot), min_fps=lo, max_fps=hi, plan=plans.get(slot))
            if slot in plans:
                item.prep = {**plans[slot].to_dict(), "size": chosen(raw)}
            media.poster(folder / rel, folder / engines.poster_file(rel))
            item.file, item.width, item.height, item.duration = rel, info["width"], info["height"], info["duration"]
            item.trim = [start, end]
            item.role = "motion"
        elif slot.startswith("audio:") and src:
            # Cut to what the model takes and written as an MP3, whatever it came in as.
            (folder / "refs").mkdir(exist_ok=True)
            start, end = fx.spans.get(slot) or (0.0, 0.0)
            rel = f"refs/{slot.replace(':', '-')}.mp3"
            info = media.transcode_audio(src, folder / rel, start=start, end=end or None, max_bytes=fx.bytes.get(slot))
            item.file, item.duration, item.trim = rel, info["duration"], [start, end]
        if item.file:
            item.sha256 = sc.sha256_file(folder / item.file)
        items.append(item)

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
    return engines.get(spec["engine"]).label.strip() or "Untitled run"


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
