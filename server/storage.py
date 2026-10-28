"""Disk use by bucket, and cleaning the buckets that only hold working copies.

Generations and the trash are the library (see store.py). Uploads are the
files dropped into a form: a run copies what it uses into its generation, so
an upload is only needed while a form still points at it. Exports are the
.illusion files and PNG/MP4s written to the output folder. The cache holds
thumbnails, schemas and builder scratch that the app rebuilds on demand.

Uploads and the cache also clean themselves (``auto_clean``): whatever nobody has
used for a while. Showing an upload on a page or running it restarts its clock
(``touch``), so a draft left open in Create keeps its files.
"""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path

from . import bundle, paths, store

BUCKETS = ("generations", "trash", "uploads", "exports", "backups", "cache")
# An upload this recent may still sit in an open form.
UPLOAD_GRACE = 3600
DAY = 86400
# Scratch that cleans itself, after this long unused: uploads, builder drafts, the rest of the cache.
AUTO_CLEAN = {"uploads": 30 * DAY, "builder": DAY, "cache": 30 * DAY}


def exports_dir() -> Path:
    return paths.output_root() / "generations"


def backups_dir() -> Path:
    return paths.output_root() / "backups"


def _dir(bucket: str) -> Path:
    return {
        "generations": paths.generations_dir,
        "trash": paths.trash_dir,
        "uploads": paths.uploads_dir,
        "exports": exports_dir,
        "backups": backups_dir,
        "cache": paths.cache_dir,
    }[bucket]()


def _count(p: Path) -> int:
    return sum(1 for _ in p.iterdir()) if p.exists() else 0


def usage() -> dict:
    out = {}
    for b in BUCKETS:
        d = _dir(b)
        out[b] = {"bytes": store.dir_size(d), "items": _count(d), "path": str(d)}
    return out


def clean(bucket: str, now: float | None = None) -> dict:
    """Empty one bucket. Returns how many entries and bytes went."""
    if bucket not in ("trash", "uploads", "exports", "backups", "cache"):
        raise ValueError(f"{bucket} can't be cleaned from here")
    now = now or time.time()
    d = _dir(bucket)
    before = store.dir_size(d)
    n = 0
    if bucket == "trash":
        n = store.empty_trash()
    else:
        for f in list(d.iterdir()) if d.is_dir() else []:  # nothing exported or backed up yet
            try:
                if bucket == "uploads" and now - f.stat().st_mtime < UPLOAD_GRACE:
                    continue
                if f.name.endswith(".partial"):  # a backup being written
                    continue
                shutil.rmtree(f) if f.is_dir() else f.unlink()
                n += 1
            except OSError:
                continue
    return {"removed": n, "bytes": before - store.dir_size(d)}


def touch(p: Path) -> None:
    """Mark a scratch file as in use, so ``auto_clean`` leaves it alone."""
    try:
        os.utime(p)
    except OSError:
        pass


def auto_clean(now: float | None = None) -> dict:
    """Remove scratch files nobody has used for a while. Returns how many files and bytes went."""
    now = now or time.time()
    gone = {"files": 0, "bytes": 0}

    def sweep(d: Path, age: float, skip: tuple[str, ...] = ()) -> None:
        if not d.is_dir():
            return
        for f in d.rglob("*"):
            try:
                if f.relative_to(d).parts[0] in skip or not f.is_file():
                    continue
                st = f.stat()
                if now - st.st_mtime > age:
                    f.unlink()
                    gone["files"] += 1
                    gone["bytes"] += st.st_size
            except OSError:
                continue

    sweep(paths.uploads_dir(), AUTO_CLEAN["uploads"], skip=("staging",))  # import staging has its own clock
    sweep(paths.cache_dir() / "builder", AUTO_CLEAN["builder"])
    sweep(paths.cache_dir(), AUTO_CLEAN["cache"], skip=("builder",))
    bundle.cleanup_staging()
    return gone
