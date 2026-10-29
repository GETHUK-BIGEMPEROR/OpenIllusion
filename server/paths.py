"""Where OpenIllusion keeps things on disk.

Everything lives under one home folder: ``$OPENILLUSION_HOME``, or ``~/.openillusion``
when unset. Results go to ``<home>/outputs`` unless Settings names another
folder. Tests call ``configure`` to point the same layout at a temp folder.

Permanent data is files; SQLite only holds what can be rebuilt (the search index).
``TIERS`` says what each entry of the home folder is, for backups and cleaning.
"""

from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

# library: the user's work, backed up. machine: this install's state, kept but not backed
# up (secrets stay on the machine; the index is rebuilt; runs belong to the GPU or key that
# started them). scratch: working copies, cleaned on their own. ``outputs/`` is not here:
# it's the default export folder, the user's files.
TIERS = {
    "settings.json": "library",
    "usage.json": "library",
    "generations": "library",
    "templates": "library",
    "covers": "library",
    "trash": "library",
    "secrets.json": "machine",
    "index.sqlite": "machine",
    "jobs.json": "machine",
    "proxy-state": "machine",
    "proxy.log": "machine",
    "server.lock": "machine",
    "uploads": "scratch",
    "cache": "scratch",
}

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


def secrets_file() -> Path:
    return user_root() / "secrets.json"


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


def write_atomic(path: Path, text: str, private: bool = False) -> None:
    """Write a file whole or not at all: a crash or power cut mid-write leaves the old one.

    ``private`` makes it readable by its owner only (no effect on Windows, where the
    home folder is already per-user)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if os.name != "nt":  # mkstemp makes it owner-only; only secrets stay that way
            os.chmod(tmp, 0o600 if private else 0o644)
        for attempt in range(5):
            try:
                os.replace(tmp, path)
                break
            except PermissionError:  # Windows: a virus scanner or indexer holds the file for a moment
                if attempt == 4:
                    raise
                time.sleep(0.05 * (attempt + 1))
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _ensure(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p
