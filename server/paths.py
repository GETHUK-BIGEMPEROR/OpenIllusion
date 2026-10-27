"""Where OpenIllusion keeps things on disk.

Everything lives under one home folder: ``$OPENILLUSION_HOME``, or ``~/.openillusion``
when unset. Results go to ``<home>/outputs`` unless Settings names another
folder. Tests call ``configure`` to point the same layout at a temp folder.
"""

from __future__ import annotations

import os
from pathlib import Path

_user_root: Path | None = None
_output_root: Path | None = None


def configure(user_dir: str | os.PathLike, output_dir: str | os.PathLike) -> None:
    global _user_root, _output_root
    _user_root = Path(user_dir)
    _output_root = Path(output_dir)


def _default_dirs() -> tuple[Path, Path]:
    home = Path(os.environ.get("OPENILLUSION_HOME") or Path.home() / ".openillusion")
    return home, home / "outputs"


def user_root() -> Path:
    if _user_root is None:
        configure(*_default_dirs())
    return _ensure(_user_root)


def output_root() -> Path:
    if _output_root is None:
        configure(*_default_dirs())
    from . import settings

    custom = settings.load().get("output_folder")
    if custom:
        return _ensure(Path(custom))
    return _ensure(_output_root)


def generations_dir() -> Path:
    return _ensure(user_root() / "generations")


def trash_dir() -> Path:
    return _ensure(user_root() / "trash")


def cache_dir() -> Path:
    return _ensure(user_root() / "cache")


def uploads_dir() -> Path:
    return _ensure(user_root() / "uploads")


def settings_file() -> Path:
    return user_root() / "settings.json"


def db_file() -> Path:
    return user_root() / "index.sqlite"


class HomeInUse(RuntimeError):
    """Another OpenIllusion server holds this home folder. The message is where it says it runs."""


_claim = None
_CLAIM_AT = 1 << 20  # the byte that's locked: past the note, so a second server can still read it


def claim_home(note: str = "") -> None:
    """Hold ``<home>/server.lock`` while this process runs, so one server owns a home folder.

    The run queue lives in one process, mirrored to ``jobs.json``: a second server on the
    same home would resume, and pay for, the same runs. The OS drops the lock when the
    process ends, even on a crash, so a stale lock file never blocks a restart.
    """
    global _claim
    f = open(user_root() / "server.lock", "a+b")
    try:
        f.seek(_CLAIM_AT)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.seek(0)
        held = f.read(200).decode("utf-8", "replace").strip()
        f.close()
        raise HomeInUse(held) from None
    f.seek(0)
    f.truncate()
    f.write(note.encode("utf-8"))
    f.flush()
    _claim = f


def release_home() -> None:
    global _claim
    if _claim is not None:
        _claim.close()
        _claim = None


def package_root() -> Path:
    """The ``server`` package folder (Python code and the built web app in ``static/``)."""
    return Path(__file__).resolve().parent


def repo_root() -> Path:
    return package_root().parent


def templates_dir() -> Path:
    """Shipped local templates: ``templates/local`` at the project root."""
    return repo_root() / "templates" / "local"


def cloud_templates_dir() -> Path:
    """Shipped cloud templates, one per Comfy Router model: ``templates/cloud``."""
    return repo_root() / "templates" / "cloud"


def _ensure(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p
