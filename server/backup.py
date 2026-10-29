"""Whole-library backups: one ``.illusionbackup`` file, restored by merging.

A backup is a zip of the library tier of the home folder (``paths.TIERS``): generations,
the user's templates and covers, settings without secrets, when each template was last run
(``usage.json``), and the trash if asked.
Nothing machine-bound goes in: no key, no queue, no index (restore rebuilds it).

    backup.json                     format, version, counts, a sha256 per file
    library/settings.json  library/usage.json
    library/generations/<id>/...    each folder as it is
    library/templates/...  library/covers/...  library/trash/<id>/...

Restoring merges: what's already here stays as it is, what's missing is added; a template's
last run is the later of the two, its count the higher. Into a
fresh install that's a full restore; run twice, the second adds nothing. A backup is
treated like any file from outside (``archive``): checked before anything is read,
every file's checksum verified, every manifest and template validated before it's
moved in, nothing executed. An older backup's ``library/characters`` and ``library/refmods``
are left out on restore.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import zipfile
from pathlib import Path, PurePosixPath
from typing import Callable

from . import archive, engines, paths, settings, storage, store, usage
from . import generation as sc

FORMAT = "openillusion.backup"
VERSION = 1
EXT = ".illusionbackup"
LIBRARY = [name for name, tier in paths.TIERS.items() if tier == "library"]
GONE = {"characters", "refmods"}  # Character Lab's shelves in older backups: left out on restore
ALLOWED = archive.GENERATION_EXT | {".m4v"}  # template samples keep the type they were dropped as
MARKERS = frozenset({".shelf", ".deleted"})
SINGLE = {"settings.json", "usage.json"}  # one file each, right under library/
STORED = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".m4v", ".mp3", ".m4a", ".aac", ".ogg", ".flac"}
MAX_ENTRIES = 500_000
CHUNK = 1 << 20

Progress = Callable[[int, int], None]


# ---- making one -----------------------------------------------------------------


def _collect(trash: bool, skip_ids: set[str]) -> tuple[list[tuple[str, Path]], list[dict], dict]:
    """Every file to back up as (name in the zip, path), what was left out and why, and counts."""
    root = paths.user_root()
    out: list[tuple[str, Path]] = []
    skipped: list[dict] = []
    counts = {"generations": 0, "templates": 0, "covers": 0, "trash": 0}

    def add_tree(d: Path, arc: str) -> None:
        for f in sorted(d.rglob("*")):
            if not f.is_file() or f.name.endswith(".tmp"):
                continue
            if f.suffix.lower() not in ALLOWED and f.name not in MARKERS:
                skipped.append({"path": f.relative_to(root).as_posix(), "why": "not a library file"})
                continue
            out.append((f"{arc}/{f.relative_to(d).as_posix()}", f))

    for shelf, kind in (("generations", "generations"), ("trash", "trash")):
        if kind == "trash" and not trash:
            continue
        base = root / shelf
        for d in sorted(base.iterdir()) if base.is_dir() else []:
            if not d.is_dir():
                continue
            try:
                m = sc.read(d)
            except Exception:
                skipped.append({"id": d.name, "why": "unreadable"})
                continue
            if d.name in skip_ids or m.status == "running":
                skipped.append({"id": d.name, "why": "running"})
                continue
            add_tree(d, f"library/{shelf}/{d.name}")
            counts[kind] += 1
    for shelf in ("templates", "covers"):
        d = root / shelf
        if d.is_dir():
            add_tree(d, f"library/{shelf}")
    counts["templates"] = sum(1 for a, _ in out if a.startswith("library/templates/") and a.count("/") == 2 and a.endswith(".json"))
    counts["covers"] = sum(1 for a, _ in out if a.startswith("library/covers/"))
    return out, skipped, counts


def create(trash: bool = False, skip_ids: set[str] = frozenset(), dest_dir: Path | None = None,
           progress: Progress | None = None) -> dict:
    """Write ``OpenIllusion-<date>.illusionbackup``. ``skip_ids``: generations a run is still writing."""
    from . import __version__

    files, skipped, counts = _collect(trash, set(skip_ids))
    dest = dest_dir or storage.backups_dir()
    dest.mkdir(parents=True, exist_ok=True)
    stem = f"OpenIllusion-{time.strftime('%Y-%m-%d')}"
    out, n = dest / f"{stem}{EXT}", 2
    while out.exists():
        out, n = dest / f"{stem}-{n}{EXT}", n + 1
    part = out.with_name(out.name + ".partial")  # never looks finished until it is
    total = sum(p.stat().st_size for _, p in files)
    done = 0
    sums: dict[str, dict] = {}
    try:
        with zipfile.ZipFile(part, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as z:
            plain = {k: v for k, v in settings.load().items() if k not in settings.SECRETS}
            data = json.dumps(plain, indent=2).encode()
            used = json.dumps(usage.load(), indent=1).encode()
            for name, b in (("library/settings.json", data), ("library/usage.json", used)):
                z.writestr(name, b)
                sums[name] = {"size": len(b), "sha256": hashlib.sha256(b).hexdigest()}
            for arc, p in files:
                info = zipfile.ZipInfo.from_file(p, arc)
                info.compress_type = zipfile.ZIP_STORED if p.suffix.lower() in STORED else zipfile.ZIP_DEFLATED
                h = hashlib.sha256()
                with open(p, "rb") as src, z.open(info, "w", force_zip64=True) as dst:
                    while chunk := src.read(CHUNK):
                        h.update(chunk)
                        dst.write(chunk)
                        done += len(chunk)
                        if progress:
                            progress(done, total)
                sums[arc] = {"size": info.file_size, "sha256": h.hexdigest()}
            z.writestr("backup.json", json.dumps({
                "format": FORMAT, "version": VERSION, "app": __version__, "created": time.time(),
                "includes": {"trash": trash, "secrets": False}, "counts": counts, "skipped": skipped, "files": sums,
            }, indent=1))
        os.replace(part, out)
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    return {"file": str(out), "name": out.name, "size": out.stat().st_size, "counts": counts, "skipped": skipped}


# ---- reading one ----------------------------------------------------------------


def _open(path: Path) -> tuple[zipfile.ZipFile, dict, list[zipfile.ZipInfo]]:
    """Open a backup and check all of it before anything is read: format, version, every entry."""
    try:
        z = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError):
        raise archive.Refused(f"Not a {EXT} file.") from None
    try:
        man = json.loads(z.read("backup.json"))
    except (KeyError, ValueError):
        z.close()
        raise archive.Refused(f"Not a {EXT} file: it has no readable backup.json.") from None
    if not isinstance(man, dict) or man.get("format") != FORMAT or not isinstance(man.get("version"), int):
        z.close()
        raise archive.Refused(f"Not a {EXT} file.")
    if man["version"] > VERSION:
        z.close()
        raise archive.Refused("This backup was made by a newer OpenIllusion. Update, then restore it.")
    infos = [i for i in archive.files(z, ALLOWED, MAX_ENTRIES, 1 << 50, "This backup", names=MARKERS)
             if i.filename != "backup.json" and not GONE & set(PurePosixPath(i.filename).parts[1:2])]
    sums = man.get("files") if isinstance(man.get("files"), dict) else {}
    for i in infos:
        parts = PurePosixPath(i.filename).parts
        if parts[0] != "library" or len(parts) < 2 or parts[1] not in LIBRARY or (parts[1] in SINGLE) != (len(parts) == 2):
            z.close()
            raise archive.Refused(f"Not part of a library: {i.filename}")
        if parts[1] in ("generations", "trash"):
            try:
                store.folder(parts[2] if len(parts) > 3 else "")
            except ValueError:
                z.close()
                raise archive.Refused(f"Not a generation folder: {i.filename}") from None
        if i.filename not in sums:
            z.close()
            raise archive.Refused(f"No checksum for {i.filename}")
    need = sum(i.file_size for i in infos)
    free = shutil.disk_usage(paths.user_root()).free
    if need > free * 0.9:
        z.close()
        raise archive.Refused(f"Restoring needs {archive.fmt_bytes(need)} free; this disk has {archive.fmt_bytes(free)}.")
    return z, man, infos


def _groups(infos: list[zipfile.ZipInfo]) -> dict[str, dict[str, list[zipfile.ZipInfo]]]:
    """Entries by shelf, then by generation id (or one group for templates, covers, settings)."""
    out: dict[str, dict[str, list[zipfile.ZipInfo]]] = {}
    for i in infos:
        parts = PurePosixPath(i.filename).parts
        key = parts[2] if parts[1] in ("generations", "trash") else ""
        out.setdefault(parts[1], {}).setdefault(key, []).append(i)
    return out


def _here(gid: str) -> bool:
    return (paths.generations_dir() / gid).exists() or (paths.trash_dir() / gid).exists()


def _template_state(z: zipfile.ZipFile, i: zipfile.ZipInfo) -> str:
    dst = paths.user_root() / PurePosixPath(i.filename).relative_to("library").as_posix()
    if not dst.exists():
        return "new"
    return "same" if dst.read_bytes() == z.read(i) else "conflict"


def inspect(path: Path, token: str) -> dict:
    """What restoring this backup would do. Adds nothing yet."""
    z, man, infos = _open(path)
    with z:
        g = _groups(infos)
        gens = list(g.get("generations", {}))
        trash = list(g.get("trash", {}))
        tpls = [i for i in g.get("templates", {}).get("", []) if PurePosixPath(i.filename).parent.as_posix() == "library/templates"]
        states = [(PurePosixPath(i.filename).stem, _template_state(z, i)) for i in tpls]
        return {
            "token": token, "created": man.get("created"), "app": man.get("app"), "size": path.stat().st_size,
            "generations": {"total": len(gens), "new": sum(1 for x in gens if not _here(x))},
            "trash": {"total": len(trash), "new": sum(1 for x in trash if not _here(x))},
            "templates": {"total": len(states), "new": sum(1 for _, s in states if s == "new"),
                          "conflicts": [n for n, s in states if s == "conflict"]},
            "covers": len(g.get("covers", {}).get("", [])),
            "skipped": man.get("skipped") or [],
        }


# ---- restoring one --------------------------------------------------------------


def _extract(z: zipfile.ZipFile, i: zipfile.ZipInfo, dst: Path, want: dict) -> bool:
    """Copy one entry out, checking its checksum on the way. False if it doesn't match."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    h = hashlib.sha256()
    with z.open(i) as src, open(dst, "wb") as out:
        while chunk := src.read(CHUNK):
            h.update(chunk)
            out.write(chunk)
    if h.hexdigest() != (want.get(i.filename) or {}).get("sha256"):
        dst.unlink(missing_ok=True)
        return False
    return True


def restore(path: Path, stage: Path, progress: Progress | None = None) -> dict:
    """Merge a backup into this library. Generations already here, and your own templates and
    covers, are left as they are. Settings you've changed stay yours."""
    z, man, infos = _open(path)
    sums = man.get("files") or {}
    res = {"generations": 0, "trash": 0, "templates": 0, "covers": 0, "settings": [], "damaged": [], "kept": []}
    total, done = sum(i.file_size for i in infos), 0

    def tick(i: zipfile.ZipInfo) -> None:
        nonlocal done
        done += i.file_size
        if progress:
            progress(done, total)

    with z:
        g = _groups(infos)
        # Generations and trash: each folder unpacked whole, checked, then moved in with one rename.
        for shelf, home in (("generations", paths.generations_dir()), ("trash", paths.trash_dir())):
            for gid, entries in g.get(shelf, {}).items():
                if _here(gid):
                    for i in entries:
                        tick(i)
                    continue
                tmp = stage / shelf / gid
                ok = True
                for i in entries:
                    rel = PurePosixPath(i.filename).relative_to(f"library/{shelf}/{gid}")
                    ok = ok and _extract(z, i, tmp / rel, sums)
                    tick(i)
                try:
                    if not ok:
                        raise ValueError("a file doesn't match its checksum")
                    m = sc.read(tmp)
                    if m.id != gid:
                        raise ValueError("the folder and its manifest disagree")
                except Exception as e:
                    res["damaged"].append({"id": gid, "why": str(e)[:200]})
                    shutil.rmtree(tmp, ignore_errors=True)
                    continue
                os.replace(tmp, home / gid)
                res[shelf] += 1
        # Templates and covers: added when missing; a file you have stays yours.
        for shelf in ("templates", "covers"):
            entries = g.get(shelf, {}).get("", [])
            # Media before the template files that point at it.
            for i in sorted(entries, key=lambda i: PurePosixPath(i.filename).suffix == ".json"):
                rel = PurePosixPath(i.filename).relative_to("library")
                dst = paths.user_root() / rel.as_posix()
                is_template = shelf == "templates" and rel.parent.as_posix() == "templates"
                tick(i)
                if dst.exists():
                    if is_template and dst.read_bytes() != z.read(i):
                        res["kept"].append(rel.stem)
                    continue
                tmp = stage / rel.as_posix()
                if not _extract(z, i, tmp, sums):
                    res["damaged"].append({"path": rel.as_posix(), "why": "a file doesn't match its checksum"})
                    continue
                if is_template:
                    try:
                        engines.load_template(json.loads(tmp.read_text("utf-8")), base=dst.parent)
                    except Exception as e:
                        res["damaged"].append({"path": rel.as_posix(), "why": str(e)[:200]})
                        tmp.unlink(missing_ok=True)
                        continue
                    res["templates"] += 1
                elif shelf == "covers":
                    res["covers"] += 1
                dst.parent.mkdir(parents=True, exist_ok=True)
                os.replace(tmp, dst)
        # Template use: the later last run and the higher count of the two.
        for i in g.get("usage.json", {}).get("", []):
            tick(i)
            b = z.read(i)
            if (sums.get(i.filename) or {}).get("sha256") != hashlib.sha256(b).hexdigest():
                continue
            try:
                usage.merge(json.loads(b))
            except ValueError:
                continue
        # Settings: a value still at its default here takes the backup's; one you've changed stays.
        for i in g.get("settings.json", {}).get("", []):
            tick(i)
            try:
                data = json.loads(z.read(i))
            except ValueError:
                continue
            if (sums.get(i.filename) or {}).get("sha256") != hashlib.sha256(z.read(i)).hexdigest() or not isinstance(data, dict):
                continue
            mine = settings.load()
            take = {k: v for k, v in data.items() if k in settings.DEFAULTS and k not in settings.SECRETS
                    and mine.get(k) == settings.DEFAULTS[k] and v != settings.DEFAULTS[k]
                    and not (k == "output_folder" and not Path(str(v)).is_dir())}
            if take:
                settings.save(take)
                res["settings"] = sorted(take)
    shutil.rmtree(stage, ignore_errors=True)
    store.reindex()
    engines.reload_templates()
    return res
