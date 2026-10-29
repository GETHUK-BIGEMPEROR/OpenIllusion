"""Zips nobody vouched for: ``.illusion`` bundles and ``.illusionbackup`` files.

Nothing in one is executed. Every entry is checked before anything is read: its path
stays inside the folder it's extracted to, its type is one a library holds, and the
count and total size stay under the caller's caps.
"""

from __future__ import annotations

import zipfile
from pathlib import PurePosixPath

from . import media

# What a generation folder holds. Scripts, binaries and anything else are refused.
# .safetensors: a RefMod a run used (runs from before RefMods moved to their own branch). Tensors only; nothing in it runs.
GENERATION_EXT = {".json", ".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".md", ".safetensors", *media.AUDIO_EXT}


# Entries are written undated: an export says nothing about when it was made.
UNDATED = (1980, 1, 1, 0, 0, 0)


def put(z: zipfile.ZipFile, name: str, data: bytes, stored: bool = False) -> None:
    """Add ``data`` as ``name``, undated; ``stored`` for media that's already compressed."""
    i = zipfile.ZipInfo(name, UNDATED)
    i.compress_type = zipfile.ZIP_STORED if stored else zipfile.ZIP_DEFLATED
    i.external_attr = 0o644 << 16
    z.writestr(i, data)


class Refused(ValueError):
    """The archive breaks a rule. The message says which, in words for the user."""


def check_path(name: str) -> PurePosixPath:
    """An entry's path, refused if it could land outside the folder it's extracted to."""
    p = PurePosixPath(name)
    if not name or name.startswith(("/", "\\")) or ".." in p.parts or ":" in name or "\\" in name:
        raise Refused(f"Unsafe path: {name}")
    return p


def files(z: zipfile.ZipFile, allowed: set[str], max_entries: int, max_total: int, what: str,
          names: frozenset[str] = frozenset()) -> list[zipfile.ZipInfo]:
    """The archive's files, checked: count, paths, types (by suffix, or exact ``names`` such as
    ``.shelf``) and total size once unpacked. ``what`` names the archive in messages."""
    infos = [i for i in z.infolist() if not i.is_dir()]
    if len(infos) > max_entries:
        raise Refused(f"{what} has {len(infos)} files; the limit is {max_entries}.")
    total = 0
    for i in infos:
        p = check_path(i.filename)
        if p.suffix.lower() not in allowed and p.name not in names:
            raise Refused(f"File type not allowed in {what.lower()}: {i.filename}")
        total += i.file_size
        if total > max_total:
            raise Refused(f"{what} unpacks to more than {fmt_bytes(max_total)}.")
    return infos


def fmt_bytes(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"
