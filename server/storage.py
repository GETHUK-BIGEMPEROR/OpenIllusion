"""Disk use by bucket, and cleaning the buckets that only hold working copies.

Generations and the trash are the library (see store.py). Uploads are the
files dropped into a form: a run copies what it uses into its generation, so
an upload is only needed while a form still points at it. Exports are the
.illusion files and PNG/MP4s written to the output folder. The cache holds
thumbnails, schemas and builder scratch that the app rebuilds on demand.
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path

from . import paths, store

BUCKETS = ("generations", "trash", "uploads", "exports", "cache")
# An upload this recent may still sit in an open form.
UPLOAD_GRACE = 3600


def exports_dir() -> Path:
    return paths.output_root() / "generations"


def _dir(bucket: str) -> Path:
    return {
        "generations": paths.generations_dir,
        "trash": paths.trash_dir,
        "uploads": paths.uploads_dir,
        "exports": exports_dir,
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
    if bucket not in ("trash", "uploads", "exports", "cache"):
        raise ValueError(f"{bucket} can't be cleaned from here")
    now = now or time.time()
    d = _dir(bucket)
    before = store.dir_size(d)
    n = 0
    if bucket == "trash":
        n = store.empty_trash()
    else:
        for f in list(d.iterdir()):
            try:
                if bucket == "uploads" and now - f.stat().st_mtime < UPLOAD_GRACE:
                    continue
                shutil.rmtree(f) if f.is_dir() else f.unlink()
                n += 1
            except OSError:
                continue
    return {"removed": n, "bytes": before - store.dir_size(d)}
