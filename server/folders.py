"""Folders on the machine the server runs on, for the app's own folder picker.

A browser can't hand a page a folder's path, so the picker asks here. Only folder names are listed, never files;
hidden ones (a leading dot, or Windows' hidden flag) stay out. It is the server's disk, so in Docker it is the
container's: a folder mounted into it shows at its mount point.
"""

from __future__ import annotations

import os
import stat
import sys
from pathlib import Path

from . import paths

# Names Windows won't take for a folder, and its reserved device names.
_BAD = set('<>:"/\\|?*')
_RESERVED = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}


class FolderError(ValueError):
    pass


def _hidden(p: os.DirEntry) -> bool:
    if p.name.startswith(".") or p.name.startswith("$"):
        return True
    attrs = getattr(p.stat(follow_symlinks=False), "st_file_attributes", 0)
    return bool(attrs & (getattr(stat, "FILE_ATTRIBUTE_HIDDEN", 0) | getattr(stat, "FILE_ATTRIBUTE_SYSTEM", 0)))


def roots() -> list[str]:
    """Where browsing can start: each drive on Windows, / elsewhere."""
    if sys.platform == "win32":
        try:
            return [d for d in os.listdrives() if os.path.isdir(d)]
        except (AttributeError, OSError):
            return [f"{c}:\\" for c in "CDEFGHIJKLMNOPQRSTUVWXYZ" if os.path.isdir(f"{c}:\\")]
    return ["/"]


def places() -> list[dict]:
    """Shortcuts: home, its usual media folders where they exist, and OpenIllusion's own output folder."""
    home = Path.home()
    out = [{"label": "Home", "path": str(home)}]
    for name in ("Desktop", "Documents", "Downloads", "Pictures", "Videos", "Movies"):
        p = home / name
        if p.is_dir():
            out.append({"label": name, "path": str(p)})
    out.append({"label": "Output folder", "path": str(paths.output_root())})
    return out


def _resolve(raw: str | None) -> Path:
    p = Path(os.path.expanduser((raw or "").strip())) if raw and raw.strip() else paths.output_root()
    if not p.is_absolute():
        raise FolderError("Use a full path")
    return p.resolve()


def listing(raw: str | None) -> dict:
    """A folder and the folders in it. A path that's gone opens its nearest parent that's there."""
    p = _resolve(raw)
    missing = False
    while not p.is_dir() and p.parent != p:
        p, missing = p.parent, True
    if not p.is_dir():
        raise FolderError("No such folder")
    dirs, denied = [], False
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    if e.is_dir() and not _hidden(e):
                        dirs.append({"name": e.name, "path": str(Path(e.path))})
                except OSError:
                    continue
    except PermissionError:
        denied = True
    dirs.sort(key=lambda d: d["name"].casefold())
    return {
        "path": str(p),
        "parent": str(p.parent) if p.parent != p else None,
        "dirs": dirs,
        "denied": denied,
        "missing": missing,
        "writable": os.access(p, os.W_OK),
        "sep": os.sep,
        "roots": roots(),
        "places": places(),
    }


def make(parent: str, name: str) -> dict:
    """A new folder in ``parent``; returns the parent's listing with it in."""
    name = (name or "").strip()
    if not name or name in (".", "..") or any(c in _BAD or ord(c) < 32 for c in name) or name.rstrip(". ") != name \
            or name.split(".")[0].upper() in _RESERVED or len(name) > 120:
        raise FolderError("That name can't be a folder name")
    p = _resolve(parent)
    if not p.is_dir():
        raise FolderError("No such folder")
    try:
        (p / name).mkdir()
    except FileExistsError:
        raise FolderError(f"{name} is already there") from None
    except PermissionError:
        raise FolderError("This folder can't be written to") from None
    return {**listing(str(p)), "made": str(p / name)}
