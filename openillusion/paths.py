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


def package_root() -> Path:
    """The ``openillusion`` package folder (templates, built web app)."""
    return Path(__file__).resolve().parent


def repo_root() -> Path:
    return package_root().parent


def _ensure(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p
