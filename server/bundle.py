"""Generation bundles: export Full / Light / Recipe-only, and import them safely.

Import never executes anything. Bundles are size-, count- and type-limited,
paths are checked, hashes are verified, and the manifest is validated before
anything reaches the library.
"""

from __future__ import annotations

import io
import json
import shutil
import time
import zipfile
from pathlib import Path, PurePosixPath

from . import media, paths, store
from . import generation as sc

MAX_TOTAL = 300 * 1024 * 1024
MAX_ENTRIES = 200
ALLOWED_EXT = {".json", ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".md"}
RECIPE_MAX = 64 * 1024
LINK_PREFIX = "#gen="


class ImportRefused(ValueError):
    pass


# ---- export ----------------------------------------------------------------


def estimate_sizes(generation_id: str) -> dict:
    f = store.folder(generation_id)
    m = sc.read(f)

    def size(rel):
        p = f / rel
        return p.stat().st_size if p.is_file() else 0

    refs = sum(size(i.file) for i in m.inputs if i.file and i.slot.startswith("image:"))
    driving = sum(size(i.file) for i in m.inputs if i.file and i.slot.startswith("video:"))
    result = sum(size(r) for r in ("result/preview.mp4", "result/image.webp", "result/poster.webp"))
    light_refs = sum(min(size(i.file), 160_000) for i in m.inputs if i.file and i.slot.startswith("image:"))
    light_result = min(size("result/preview.mp4"), 2_500_000) + size("result/poster.webp") + min(size("result/image.webp"), 400_000)
    recipe = len(json.dumps(recipe_only(m)).encode())
    return {
        "full": refs + driving + result + 8_000,
        "light": light_refs + light_result + 6_000,
        "recipe": recipe,
        "has_driving": driving > 0,
        "link_ok": len(link(m)) < 64_000,
    }


def recipe_only(m: sc.Manifest) -> dict:
    d = sc.dump(m)
    d["variant"] = "recipe"
    for i in d["inputs"]:
        i["file"] = None
    if d.get("result"):
        d["result"] = {k: v for k, v in d["result"].items() if k not in ("output_file", "file", "poster")}
    d.pop("starred", None)
    return d


def link(m: sc.Manifest | dict) -> str:
    data = m if isinstance(m, dict) else recipe_only(m)
    raw = json.dumps(data, separators=(",", ":")).encode()
    return LINK_PREFIX + media.b64url(raw)


def check_attestation(m: sc.Manifest, attest: dict, strip_driving: bool) -> list[str]:
    problems = []
    if not attest.get("sfw"):
        problems.append("Confirm the generation is safe for work")
    if not attest.get("rights"):
        problems.append("Confirm you have the rights to every asset")
    consents = attest.get("consent") or {}
    for i in m.inputs:
        if strip_driving and i.slot.startswith("video:"):
            continue
        if i.contains_person and not (i.consent or consents.get(i.slot)):
            problems.append(f"Tick consent for {i.slot}: it shows a real person")
    return problems


def export(generation_id: str, variant: str, strip_driving: bool, attest: dict, dest_dir: Path | None = None,
           embed_recipe: bool = True) -> Path:
    """Write ``<title>.illusion`` (Full or Light) or ``.illusion.json`` (Recipe-only)."""
    f = store.folder(generation_id)
    m = sc.read(f)
    for i in m.inputs:
        lic = (attest.get("licenses") or {}).get(i.slot)
        if lic in sc.LICENSES:
            i.license = lic
    problems = check_attestation(m, attest, strip_driving or variant != "full")
    if problems:
        raise ValueError("; ".join(problems))
    for i in m.inputs:
        if (attest.get("consent") or {}).get(i.slot):
            i.consent = True
    m.attest = sc.Attest(sfw=True, rights=True)
    store.save(m)

    dest_dir = dest_dir or (paths.output_root() / "generations")
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = _safe_name(m.title) or m.id

    if variant == "recipe":
        out = dest_dir / f"{stem}.illusion.json"
        out.write_text(json.dumps(recipe_only(m), indent=2, ensure_ascii=False), "utf-8")
        return out

    out = dest_dir / f"{stem}.illusion"
    d = sc.dump(m)
    d["variant"] = variant
    light = variant == "light"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for item in d["inputs"]:
            if not item.get("file"):
                continue
            src = f / item["file"]
            if item["slot"].startswith("video:") and (light or strip_driving):
                item["file"] = None
                continue
            if not src.exists():
                item["file"] = None
                continue
            if light and item["slot"].startswith("image:"):
                buf = io.BytesIO()
                img = media.strip_exif(media.fit(media.open_image(src), max_side=768))
                img.save(buf, "WEBP", quality=86)
                rel = str(PurePosixPath(item["file"]).with_suffix(".webp"))
                data = buf.getvalue()
                z.writestr(rel, data)
                item["file"] = rel
                item["sha256"] = _sha(data)
            else:
                z.write(src, item["file"])
        if d.get("result"):
            d["result"].pop("output_file", None)
            for key in ("file", "poster"):
                rel = d["result"].get(key)
                if rel and (f / rel).exists():
                    if rel.endswith(".mp4") and (light or embed_recipe):
                        tmp = f / "result" / "_export.mp4"
                        src = f / rel
                        if light:
                            media.preview(src, tmp, max_height=480, max_bytes=2_500_000)
                            src = tmp
                        if embed_recipe:
                            tagged = f / "result" / "_tagged.mp4"
                            media.write_mp4_recipe(src, tagged, recipe_only(m))
                            src = tagged
                        z.write(src, rel)
                        for t in ("_export.mp4", "_tagged.mp4"):
                            (f / "result" / t).unlink(missing_ok=True)
                    else:
                        z.write(f / rel, rel)
        if (f / "comfy" / "workflow.json").exists():
            z.write(f / "comfy" / "workflow.json", "comfy/workflow.json")
        if (f / "driving" / "poster.webp").exists() and not (light or strip_driving):
            z.write(f / "driving" / "poster.webp", "driving/poster.webp")
        z.writestr("LICENSES.md", sc.licenses_md(sc.parse(d)[0]))
        z.writestr("generation.json", json.dumps(d, indent=2, ensure_ascii=False))
    return out


def _sha(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


def _safe_name(s: str) -> str:
    keep = "".join(c if c.isalnum() or c in " -_" else " " for c in s)
    return "-".join(keep.lower().split())[:60]


# ---- import ----------------------------------------------------------------


def staging_dir() -> Path:
    d = paths.uploads_dir() / "staging"
    d.mkdir(exist_ok=True)
    return d


def inspect(data: bytes, filename: str = "") -> dict:
    """Read a dropped file. Stages it and returns a review; adds nothing yet."""
    name = filename.lower()
    if data[:2] == b"PK":
        return _inspect_zip(data, filename)
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        recipe = media.read_png_recipe(data)
        if not recipe:
            raise ImportRefused("This PNG carries no OpenIllusion recipe.")
        return _review(recipe, source={"kind": "png", "name": filename}, files={}, poster=("poster.png", data))
    if data[4:8] == b"ftyp":
        tmp = staging_dir() / f"probe-{time.time_ns()}.mp4"
        tmp.write_bytes(data)
        try:
            recipe = media.read_mp4_recipe(tmp)
            if not recipe:
                raise ImportRefused("This video carries no OpenIllusion recipe.")
            poster_buf = io.BytesIO()
            try:
                media.fit(media.frame_at(tmp, 0.5), max_side=960).convert("RGB").save(poster_buf, "WEBP", quality=85)
            except Exception:
                poster_buf = None
            # The video itself is the result of the recipe.
            return _review(
                recipe, source={"kind": "mp4", "name": filename}, files={"result/preview.mp4": data},
                poster=("result/poster.webp", poster_buf.getvalue()) if poster_buf else None,
            )
        finally:
            tmp.unlink(missing_ok=True)
    text = data.decode("utf-8", errors="replace").strip()
    if LINK_PREFIX in text:
        frag = text.split(LINK_PREFIX, 1)[1].split()[0]
        try:
            recipe = json.loads(media.b64url_decode(frag))
        except ValueError:
            raise ImportRefused("The link's generation data is damaged.") from None
        return _review(recipe, source={"kind": "link", "name": "link"}, files={})
    if text.startswith("{") or name.endswith(".json"):
        if len(data) > 5 * 1024 * 1024:
            raise ImportRefused("Manifest JSON over 5 MB.")
        try:
            recipe = json.loads(text)
        except ValueError:
            raise ImportRefused("Not valid JSON.") from None
        return _review(recipe, source={"kind": "json", "name": filename}, files={})
    raise ImportRefused("Drop a .illusion, a OpenIllusion PNG or MP4, a generation link or generation JSON.")


def _inspect_zip(data: bytes, filename: str) -> dict:
    if len(data) > MAX_TOTAL:
        raise ImportRefused("Bundle over 300 MB.")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ImportRefused("Not a valid .illusion (zip) file.") from None
    infos = [i for i in z.infolist() if not i.is_dir()]
    if len(infos) > MAX_ENTRIES:
        raise ImportRefused(f"Bundle has {len(infos)} files; the limit is {MAX_ENTRIES}.")
    total = 0
    files: dict[str, bytes] = {}
    for info in infos:
        n = info.filename
        p = PurePosixPath(n)
        if n.startswith(("/", "\\")) or ".." in p.parts or ":" in n or "\\" in n:
            raise ImportRefused(f"Unsafe path in bundle: {n}")
        if p.suffix.lower() not in ALLOWED_EXT:
            raise ImportRefused(f"File type not allowed in a generation: {n}")
        total += info.file_size
        if total > MAX_TOTAL:
            raise ImportRefused("Bundle expands past 300 MB.")
        files[n] = z.read(info)
    if "generation.json" not in files:
        raise ImportRefused("Bundle has no generation.json.")
    try:
        recipe = json.loads(files.pop("generation.json"))
    except ValueError:
        raise ImportRefused("generation.json is not valid JSON.") from None
    poster = None
    if "result/poster.webp" in files:
        poster = ("result/poster.webp", files["result/poster.webp"])
    return _review(recipe, source={"kind": "generation", "name": filename}, files=files, poster=poster)


def _review(recipe: dict, source: dict, files: dict[str, bytes], poster: tuple[str, bytes] | None = None) -> dict:
    from . import engines

    checks: list[dict] = []
    try:
        m, unknown = sc.parse(recipe)
    except sc.ManifestError as e:
        raise ImportRefused(f"Manifest doesn't match the generation.v1 schema: {e}") from None
    checks.append({
        "level": "pass", "text": "Manifest matches generation.v1 schema",
        "detail": f"{len(unknown)} unknown field{'s' if len(unknown) != 1 else ''} kept and ignored" if unknown else "No unknown fields",
    })
    size = sum(len(b) for b in files.values())
    checks.append({"level": "pass", "text": "Size and file types within limits",
                   "detail": f"{_fmt_bytes(size)} · no paths outside the bundle" if files else "Recipe only, no media"})

    bad_hash = []
    for i in m.inputs:
        if i.file and i.file in files and i.sha256 and _sha(files[i.file]) != i.sha256:
            bad_hash.append(i.slot)
    if bad_hash:
        checks.append({"level": "warn", "text": "Some files don't match their hashes", "detail": ", ".join(bad_hash) + " will be dropped"})
        for i in m.inputs:
            if i.slot in bad_hash:
                files.pop(i.file, None)
                i.file = None
    elif any(i.file for i in m.inputs):
        checks.append({"level": "pass", "text": "File hashes verified", "detail": "Every included input matches its sha256"})

    e = engines.get(m.engine.model)
    if m.engine.model in engines.ENGINES:
        checks.append({"level": "pass", "text": "Template installed" if e.kind == "local" else "Model available on Router", "detail": m.engine.model})
    else:
        checks.append({"level": "warn", "text": "Not one of your templates", "detail": f"{m.engine.model} · runs through the schema form if Router lists it"})

    missing_video = [i for i in m.inputs if i.slot.startswith("video:") and not (i.file and i.file in files)]
    if missing_video or (e.needs_video and not any(i.slot.startswith("video:") for i in m.inputs)):
        lo, hi = e.video_window or (2, 15)
        checks.append({"level": "warn", "text": "No driving video in this generation", "detail": f"You'll be asked for your own clip, {lo:g}–{hi:g} s"})
    missing_refs = [i for i in m.inputs if i.slot.startswith("image:") and not (i.file and i.file in files)]
    if missing_refs:
        checks.append({"level": "info", "text": "Reference images are thumbnails" if any(i.thumb for i in missing_refs) else "Reference images not included",
                       "detail": "Swap in full-size images to match exactly"})

    wf = files.get("comfy/workflow.json")
    if wf:
        try:
            doc = json.loads(wf)
        except ValueError:
            doc = {}
        if isinstance(doc.get("nodes"), list):  # UI format
            types = {n.get("type") for n in doc["nodes"] if isinstance(n, dict)}
        else:  # API format
            types = {n.get("class_type") for n in doc.values() if isinstance(n, dict)}
        types.discard(None)
        known = _known_nodes()
        foreign = sorted(t for t in types if known is not None and t not in known)
        if known is None:
            checks.append({"level": "info", "text": f"ComfyUI workflow · {len(types)} node types",
                           "detail": "Checked against your ComfyUI before it runs"})
        elif foreign:
            checks.append({"level": "warn", "text": "Workflow needs custom nodes your ComfyUI doesn't have",
                           "detail": ", ".join(foreign) + " · listed only, never installed"})
        else:
            checks.append({"level": "pass", "text": "Your ComfyUI has every node this workflow uses", "detail": "Shown, never executed on import"})

    token = f"{time.time_ns()}"
    stage = staging_dir() / token
    stage.mkdir(parents=True)
    for rel, b in files.items():
        p = stage / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(b)
    if poster and poster[0] not in files:
        (stage / poster[0]).parent.mkdir(parents=True, exist_ok=True)
        (stage / poster[0]).write_bytes(poster[1])
    d = sc.dump(m)
    d.update({k: recipe[k] for k in unknown})
    if source["kind"] == "mp4":
        d["result"] = d.get("result") or {}
        d["result"].update({"file": "result/preview.mp4", "kind": "video"})
        if poster:
            d["result"]["poster"] = poster[0]
    elif source["kind"] == "png" and poster:
        d["result"] = d.get("result") or {}
        d["result"].update({"file": poster[0], "poster": poster[0], "kind": "image"})
    (stage / "generation.json").write_text(json.dumps(d, indent=2, ensure_ascii=False), "utf-8")

    return {
        "token": token,
        "manifest": d,
        "checks": checks,
        "source": source,
        "size": size,
        "poster": f"/api/import/{token}/file/{poster[0]}" if poster else None,
        "has_driving": not missing_video and any(i.slot.startswith("video:") for i in m.inputs),
        "exists": store.folder(m.id).exists(),
    }


def commit(token: str) -> sc.Manifest:
    if not token.isdigit():
        raise ValueError("bad token")
    stage = staging_dir() / token
    if not (stage / "generation.json").exists():
        raise FileNotFoundError("This import has expired. Drop the file again.")
    m, _ = sc.parse((stage / "generation.json").read_text("utf-8"))
    if store.folder(m.id).exists():
        # Already in the library: keep both, the import becomes a fork.
        m.lineage.forked_from = m.id
        m.id = sc.new_id()
    dst = store.folder(m.id)
    shutil.move(str(stage), str(dst))
    m.created = time.time()
    if m.status == "running":
        m.status = "done" if (m.result and m.result.file) else "draft"
    if m.engine.kind == "local" and not (dst / "comfy" / "workflow.json").exists():
        from .jobs import workflow_file

        (dst / "comfy").mkdir(exist_ok=True)
        (dst / "comfy" / "workflow.json").write_text(json.dumps(workflow_file(m), indent=2), "utf-8")
    store.save(m, shelf="imported")
    return m


def cleanup_staging(max_age: float = 6 * 3600) -> None:
    now = time.time_ns()
    for d in staging_dir().iterdir():
        try:
            if d.is_dir() and (now - int(d.name)) / 1e9 > max_age:
                shutil.rmtree(d, ignore_errors=True)
        except ValueError:
            continue


def _known_nodes() -> set[str] | None:
    """Node types of the user's ComfyUI, if OpenIllusion has asked it recently."""
    from . import local

    hits = sorted(local._info_cache.values(), key=lambda h: h[0])
    return set(hits[-1][1]) if hits else None


def _fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n} B"
