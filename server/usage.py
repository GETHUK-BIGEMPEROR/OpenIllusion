"""When each template was last run and how many times, for Explore's Recently used and Most used.

Kept apart from the runs, so deleting a result doesn't forget that its template was used. One run of
several variants counts once. With no file yet (a new install, or after a backup restore), the count
starts from the runs in the library.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from . import paths, store

_lock = threading.RLock()


def _file() -> Path:
    return paths.user_root() / "usage.json"


def _seed() -> dict[str, dict]:
    with store._lock:
        rows = store.db().execute(
            "SELECT model, COUNT(DISTINCT COALESCE(parent, id)), MAX(created) FROM generations GROUP BY model"
        ).fetchall()
    return {m: {"n": n, "at": at} for m, n, at in rows if m}


def load() -> dict[str, dict]:
    """``{template id: {"n": runs, "at": last run's start}}``."""
    try:
        data = json.loads(_file().read_text("utf-8"))
        if isinstance(data, dict):
            return data
    except FileNotFoundError:
        pass
    except (OSError, ValueError):
        return _seed()
    with _lock:
        if not _file().exists():
            paths.write_atomic(_file(), json.dumps(_seed(), indent=1))
    return load()


def note(template_id: str, at: float | None = None) -> None:
    """A run of ``template_id`` just started."""
    with _lock:
        d = load()
        u = d.get(template_id) or {"n": 0, "at": 0}
        d[template_id] = {"n": int(u.get("n") or 0) + 1, "at": max(float(u.get("at") or 0), at or time.time())}
        paths.write_atomic(_file(), json.dumps(d, indent=1))
