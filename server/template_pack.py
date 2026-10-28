"""One template as a ``.illusion`` file: the template, its samples and its cover, to give to anyone.

    illusion.json      format, version, app, the template's id and title, a sha256 per file
    template.json      the template; its samples and cover named ``media/<file>``
    media/<file>       the samples, and the cover it ships with
    cover/<name>       the cover you set: cover.webp, cover.mp4, cover.before.webp or .mp4

A generation's ``.illusion`` holds a ``generation.json`` instead; ``is_pack`` tells them apart.
Adding one treats it like any file from outside (``archive``): paths, types and size are checked
before anything is read, every checksum verified, every media name in the template must be a
file in the package, and the template must load before anything moves in. Nothing is executed.
It lands in your templates folder as yours (deletable), under a new id when its id is taken.
"""

from __future__ import annotations

import copy
import hashlib
import io
import json
import re
import shutil
import time
import zipfile
from pathlib import Path, PurePosixPath

from . import archive, engines, media, paths

FORMAT = "openillusion.template-package"
VERSION = 1
EXT = ".illusion"
MEDIA_EXT = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".m4v", *media.AUDIO_EXT}
MAX_ENTRIES = 64
MAX_TOTAL = 300 * 1024 * 1024
COVERS = ("cover.webp", "cover.mp4", "cover.before.webp", "cover.before.mp4")


class Refused(archive.Refused):
    pass


def _stem(tid: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "__", tid)


def _refs(data: dict) -> list[tuple[dict, str]]:
    """Every place a template names a file: (the dict holding it, its key)."""
    out = [(data, k) for k in ("cover", "cover_video") if data.get(k)]
    out += [(f, "default") for f in data.get("inputs") or [] if f.get("type") in engines.MEDIA and f.get("default")]
    return out


# ---- making one -------------------------------------------------------------------


def export(engine_id: str) -> tuple[bytes, str]:
    """The template as ``.illusion`` bytes, and a file name for it."""
    from . import __version__

    e = engines.ENGINES.get(engine_id)
    if e is None or e.data is None or e.path is None:
        raise KeyError(engine_id)
    data = engines.upgrade(copy.deepcopy(e.data))
    data.pop("tags", None)
    for f in data.get("inputs") or []:
        f.pop("examples", None)
    files: dict[str, bytes] = {}
    taken: dict[Path, str] = {}
    for holder, key in _refs(data):
        src = engines.media_path(e.path.parent, holder[key]).resolve()
        if not src.is_file() or src.suffix.lower() not in MEDIA_EXT:
            holder.pop(key)  # a sample that's gone: the template still loads, people bring their own
            continue
        if src not in taken:
            name, n = src.name, 2
            while f"media/{name}" in files:
                name, n = f"{src.stem}-{n}{src.suffix}", n + 1
            taken[src] = f"media/{name}"
            files[taken[src]] = src.read_bytes()
        holder[key] = taken[src]
    for name in COVERS:
        f = engines.user_cover(e.id, name[len("cover"):])
        if f.is_file():
            files[f"cover/{name}"] = f.read_bytes()
    files["template.json"] = (json.dumps(data, indent=2, ensure_ascii=False) + "\n").encode()
    head = {
        "format": FORMAT, "version": VERSION, "app": __version__, "created": time.time(),
        "id": e.id, "label": e.label, "kind": e.kind,
        "files": {k: {"size": len(v), "sha256": hashlib.sha256(v).hexdigest()} for k, v in files.items()},
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("illusion.json", json.dumps(head, indent=1, ensure_ascii=False))
        for k, v in files.items():
            z.writestr(k, v, zipfile.ZIP_STORED if k.startswith(("media/", "cover/")) else zipfile.ZIP_DEFLATED)
    title = re.sub(r"[^A-Za-z0-9 _-]+", " ", e.label.split(" · ")[0]).strip() or e.id.split("/")[-1]
    return buf.getvalue(), f"{'-'.join(title.lower().split())[:60]}{EXT}"


# ---- adding one -------------------------------------------------------------------


def is_pack(data: bytes) -> bool:
    """A zip whose ``illusion.json`` says it's a template, not a generation."""
    if data[:2] != b"PK":
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            return json.loads(z.read("illusion.json")).get("format") == FORMAT
    except (zipfile.BadZipFile, KeyError, ValueError, AttributeError):
        return False


def install(data: bytes) -> engines.Engine:
    """Add a template package to your templates. Refused with a reason when any of it is off."""
    if len(data) > MAX_TOTAL:
        raise Refused("This template is over 300 MB.")
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise Refused("Not a valid .illusion file.") from None
    with z:
        infos = archive.files(z, MEDIA_EXT | {".json"}, MAX_ENTRIES, MAX_TOTAL, "This template")
        try:
            head = json.loads(z.read("illusion.json"))
        except (KeyError, ValueError):
            raise Refused("Not a template .illusion: it has no readable illusion.json.") from None
        if not isinstance(head, dict) or head.get("format") != FORMAT or not isinstance(head.get("version"), int):
            raise Refused("Not a template .illusion.")
        if head["version"] > VERSION:
            raise Refused("This template was made by a newer OpenIllusion. Update, then add it.")
        sums = head.get("files") if isinstance(head.get("files"), dict) else {}
        files: dict[str, bytes] = {}
        for i in infos:
            if i.filename == "illusion.json":
                continue
            p = PurePosixPath(i.filename)
            ok = i.filename == "template.json" or (len(p.parts) == 2 and (
                (p.parts[0] == "media" and p.suffix.lower() in MEDIA_EXT) or (p.parts[0] == "cover" and p.name in COVERS)))
            if not ok:
                raise Refused(f"Not part of a template: {i.filename}")
            b = z.read(i)
            if hashlib.sha256(b).hexdigest() != (sums.get(i.filename) or {}).get("sha256"):
                raise Refused(f"{i.filename} doesn't match its checksum: the file is damaged.")
            files[i.filename] = b
    if "template.json" not in files:
        raise Refused("This .illusion has no template.json.")
    try:
        tpl = json.loads(files.pop("template.json"))
    except ValueError:
        raise Refused("template.json isn't valid JSON.") from None
    if not isinstance(tpl, dict) or not isinstance(tpl.get("id"), str):
        raise Refused("template.json isn't a template.")
    # Every file the template names must be one in the package: nothing reaches outside it.
    for holder, key in _refs(tpl):
        if not isinstance(holder[key], str) or holder[key] not in files:
            raise Refused(f"The template names a file it doesn't include: {holder[key]}")

    prefix = "cloud/" if tpl.get("kind") == "cloud" else "local/"
    base = re.sub(r"-\d+$", "", tpl["id"].split("/", 1)[-1]) or "template"
    tid, n = prefix + base, 2
    while tid in engines.ENGINES:
        tid, n = f"{prefix}{base}-{n}", n + 1
    stem = _stem(tid)
    root = paths.user_root() / "templates"
    tpl["id"], tpl["built"] = tid, True
    for holder, key in _refs(tpl):
        holder[key] = f"media/{stem}/{PurePosixPath(holder[key]).name}"

    stage = root / ".adding" / stem
    shutil.rmtree(stage, ignore_errors=True)
    try:
        for name, b in files.items():
            p = PurePosixPath(name)
            dst = stage / "media" / stem / p.name if p.parts[0] == "media" else stage / name
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(b)
        (stage / "media" / stem).mkdir(parents=True, exist_ok=True)
        # It must load, its media laid out as it will live, before anything moves in.
        try:
            engines.load_template(copy.deepcopy(tpl), base=stage)
        except (ValueError, KeyError, TypeError) as ex:
            raise Refused(f"The template doesn't load: {str(ex)[:200]}") from None
        media_dir = root / "media" / stem
        media_dir.parent.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(media_dir, ignore_errors=True)
        shutil.move(str(stage / "media" / stem), str(media_dir))
        for name in COVERS:
            if (stage / "cover" / name).is_file():
                dst = engines.user_cover(tid, name[len("cover"):])
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(stage / "cover" / name), str(dst))
        paths.write_atomic(root / f"{stem}.json", json.dumps(tpl, indent=2, ensure_ascii=False) + "\n")
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        try:
            (root / ".adding").rmdir()
        except OSError:
            pass
    engines.reload_templates()
    return engines.ENGINES[tid]
