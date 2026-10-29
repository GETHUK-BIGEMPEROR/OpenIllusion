"""The generation library: one folder per generation plus a SQLite/FTS5 index.

The folders are the source of truth; the index can always be rebuilt from
them with ``reindex``. Deleted generations sit in the trash for seven days.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import threading
import time
from pathlib import Path

from . import paths, generation as sc

TRASH_DAYS = 7
SHELVES = ("mine", "imported")
# The index is rebuilt from the folders whenever its layout changes: bump this with SCHEMA.
INDEX_VERSION = 2

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None
_conn_path: Path | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  title TEXT, mode TEXT, model TEXT, provider TEXT,
  status TEXT, outcome TEXT, shelf TEXT,
  created REAL, updated REAL,
  tags TEXT, has_driving INTEGER, ref_count INTEGER,
  poster TEXT, preview TEXT, result_kind TEXT,
  starred INTEGER, parent TEXT, variant TEXT,
  prompt TEXT, width INTEGER, height INTEGER, elapsed REAL, seed INTEGER, error TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS generations_fts USING fts5(id UNINDEXED, title, prompt, tags, notes);
"""


def db() -> sqlite3.Connection:
    global _conn, _conn_path
    with _lock:
        f = paths.db_file()
        if _conn is None or _conn_path != f:
            _conn = sqlite3.connect(str(f), check_same_thread=False)
            _conn.row_factory = sqlite3.Row
            stale = _conn.execute("PRAGMA user_version").fetchone()[0] != INDEX_VERSION
            if stale:
                _conn.executescript("DROP TABLE IF EXISTS generations; DROP TABLE IF EXISTS generations_fts;")
            _conn.executescript(SCHEMA)
            _conn.execute(f"PRAGMA user_version = {INDEX_VERSION}")
            _conn.commit()
            _conn_path = f
            if stale:
                reindex()
        return _conn


def folder(generation_id: str) -> Path:
    if not generation_id or any(c in generation_id for c in "/\\.:"):
        raise ValueError("bad generation id")
    return paths.generations_dir() / generation_id


def shelf_of(generation_id: str) -> str:
    f = folder(generation_id) / ".shelf"
    return f.read_text("utf-8").strip() if f.exists() else "mine"


def set_shelf(generation_id: str, shelf: str) -> None:
    paths.write_atomic(folder(generation_id) / ".shelf", shelf)


def index(m: sc.Manifest, shelf: str | None = None) -> None:
    shelf = shelf or shelf_of(m.id)
    has_driving = any(i.slot.startswith("video:") and (i.file or i.url) for i in m.inputs)
    refs = sum(1 for i in m.inputs if i.slot.startswith("image:"))
    res = m.result
    w, h = _dims(generation_id=m.id, rel=(res.poster or res.file) if res else None)
    if not w:
        lead = next((i for i in m.inputs if i.slot == "image:1"), None)
        w, h = (lead.width, lead.height) if lead else (None, None)
    row = (
        m.id, m.title, m.mode, m.engine.model, (res.provider if res else None) or m.engine.provider,
        m.status, m.outcome, shelf, m.created, time.time(),
        json.dumps(m.tags), int(has_driving), refs,
        res.poster if res else None, res.file if res else None, res.kind if res else None,
        int(m.starred), m.lineage.parent, m.variant,
        m.prompt, w, h, res.elapsed if res else None, res.seed if res else None,
        _reason(m),
    )
    with _lock:
        c = db()
        c.execute(f"INSERT OR REPLACE INTO generations VALUES ({','.join('?' * len(row))})", row)
        c.execute("DELETE FROM generations_fts WHERE id = ?", (m.id,))
        c.execute(
            "INSERT INTO generations_fts (id, title, prompt, tags, notes) VALUES (?,?,?,?,?)",
            (m.id, m.title, m.prompt, " ".join(m.tags), m.notes),
        )
        c.commit()


def _reason(m: sc.Manifest) -> str | None:
    """Why a run failed, in one line, for cards and lists."""
    if m.status not in ("failed", "moderated") or not (m.result and m.result.error):
        return None
    e = m.result.error
    if e.get("error_type") == "out_of_memory" or "out of memory" in str(e.get("message", "")).lower():
        return "Your GPU ran out of memory. Try a smaller size or one variant at a time."
    text = str(e.get("detail") or e.get("message") or e.get("error_type") or "")
    return " ".join(text.split())[:240] or None


def _dims(generation_id: str, rel: str | None) -> tuple[int | None, int | None]:
    """Pixel size of a result image (header only), so walls lay out before media loads."""
    return _dims_at(folder(generation_id), rel)


def save(m: sc.Manifest, shelf: str | None = None) -> sc.Manifest:
    f = folder(m.id)
    sc.write(f, m)
    if shelf:
        set_shelf(m.id, shelf)
    index(m, shelf)
    return m


def mine(generation_id: str) -> str | None:
    """The generation here that ``generation_id`` names: itself, or the one shared under it (``sc.share_id``)."""
    if folder(generation_id).exists():
        return generation_id
    with _lock:
        ids = [r[0] for r in db().execute("SELECT id FROM generations")]
    return next((i for i in ids if sc.share_id(i) == generation_id), None)


def get(generation_id: str) -> sc.Manifest:
    return sc.read(folder(generation_id))


def update(generation_id: str, **changes) -> sc.Manifest:
    with _lock:
        m = get(generation_id)
        data = sc.dump(m)
        data.update(changes)
        m2, _ = sc.parse(data)
        return save(m2)


def _fts_query(q: str) -> str:
    # Quote each term so user punctuation never becomes FTS syntax.
    terms = [t.replace('"', "") for t in q.split() if t.strip('"')]
    return " ".join(f'"{t}"*' for t in terms)


def query(
    shelf: str | None = None,
    q: str | None = None,
    mode: str | None = None,
    model: str | None = None,
    outcome: str | None = None,
    tag: str | None = None,
    has_driving: bool | None = None,
    limit: int = 200,
) -> list[dict]:
    where, args = [], []
    if shelf:
        where.append("s.shelf = ?"), args.append(shelf)
    if mode:
        where.append("s.mode = ?"), args.append(mode)
    if model:
        where.append("s.model = ?"), args.append(model)
    if outcome:
        if outcome == "none":
            where.append("s.outcome IS NULL")
        else:
            where.append("s.outcome = ?"), args.append(outcome)
    if tag:
        where.append("s.tags LIKE ?"), args.append(f'%"{tag}"%')
    if has_driving is not None:
        where.append("s.has_driving = ?"), args.append(int(has_driving))
    join = ""
    if q and _fts_query(q):
        join = "JOIN generations_fts f ON f.id = s.id AND generations_fts MATCH ?"
        args.insert(0, _fts_query(q))
    sql = f"SELECT s.* FROM generations s {join}"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY s.created DESC LIMIT ?"
    args.append(limit)
    with _lock:
        rows = db().execute(sql, args).fetchall()
    return [_row(r) for r in rows]


def _row(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["tags"] = json.loads(d.get("tags") or "[]")
    d["has_driving"] = bool(d["has_driving"])
    d["starred"] = bool(d["starred"])
    return d


def variants(parent: str) -> list[dict]:
    with _lock:
        rows = db().execute("SELECT * FROM generations WHERE parent = ? ORDER BY title", (parent,)).fetchall()
    return [_row(r) for r in rows]


def typical(model: str, n: int = 12) -> float | None:
    """How long a run of this template usually takes: the median of its last ``n`` finished runs, once there are two."""
    with _lock:
        rows = db().execute(
            "SELECT elapsed FROM generations WHERE model = ? AND status = 'done' AND elapsed > 0 ORDER BY created DESC LIMIT ?", (model, n)
        ).fetchall()
    xs = sorted(r[0] for r in rows)
    if len(xs) < 2:
        return None
    mid = len(xs) // 2
    return round(xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2, 1)


def facets() -> dict:
    with _lock:
        c = db()
        models = [r[0] for r in c.execute("SELECT DISTINCT model FROM generations ORDER BY model")]
        counts = {r[0]: r[1] for r in c.execute("SELECT shelf, COUNT(*) FROM generations GROUP BY shelf")}
        tags: set[str] = set()
        for (t,) in c.execute("SELECT tags FROM generations"):
            tags.update(json.loads(t or "[]"))
    return {"models": models, "shelves": counts, "tags": sorted(tags)}


def delete(generation_id: str) -> None:
    src = folder(generation_id)
    if not src.exists():
        return
    dst = paths.trash_dir() / f"{generation_id}"
    if dst.exists():
        shutil.rmtree(dst)
    shutil.move(str(src), str(dst))
    (dst / ".deleted").write_text(str(time.time()), "utf-8")
    with _lock:
        c = db()
        c.execute("DELETE FROM generations WHERE id = ?", (generation_id,))
        c.execute("DELETE FROM generations_fts WHERE id = ?", (generation_id,))
        c.commit()


def delete_many(ids: list[str]) -> list[str]:
    """Move several generations to the trash; returns the ids that moved."""
    moved = []
    for gid in ids:
        try:
            if folder(gid).exists():
                delete(gid)
                moved.append(gid)
        except (OSError, ValueError):
            continue
    return moved


def restore(generation_id: str) -> sc.Manifest:
    src = trash_folder(generation_id)
    if not src.exists():
        raise FileNotFoundError(generation_id)
    dst = folder(generation_id)
    shutil.move(str(src), str(dst))
    (dst / ".deleted").unlink(missing_ok=True)
    m = sc.read(dst)
    index(m)
    return m


def trash_folder(generation_id: str) -> Path:
    folder(generation_id)  # same id rules
    return paths.trash_dir() / generation_id


def trash() -> list[dict]:
    out = []
    for d in paths.trash_dir().iterdir():
        try:
            m = sc.read(d)
            deleted = float((d / ".deleted").read_text("utf-8"))
        except Exception:
            continue
        res = m.result
        w, h = (_dims_at(d, res.poster or res.file) if res else (None, None))
        out.append({
            "id": m.id, "title": m.title, "prompt": m.prompt, "mode": m.mode, "model": m.engine.model, "status": m.status,
            "starred": m.starred, "created": m.created, "deleted": deleted, "purge_at": deleted + TRASH_DAYS * 86400,
            "poster": res.poster if res else None, "preview": res.file if res else None, "result_kind": res.kind if res else None,
            "width": w, "height": h, "bytes": dir_size(d),
        })
    return sorted(out, key=lambda t: t["deleted"], reverse=True)


def purge(generation_id: str) -> bool:
    """Delete one trashed generation for good."""
    d = trash_folder(generation_id)
    if not d.exists():
        return False
    shutil.rmtree(d)
    return True


def empty_trash() -> int:
    n = 0
    for d in list(paths.trash_dir().iterdir()):
        try:
            shutil.rmtree(d) if d.is_dir() else d.unlink()
            n += 1
        except OSError:
            continue
    return n


def dir_size(p: Path) -> int:
    total = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            continue
    return total


def _dims_at(base: Path, rel: str | None) -> tuple[int | None, int | None]:
    if not rel:
        return None, None
    try:
        from PIL import Image

        with Image.open(base / rel) as im:
            return im.width, im.height
    except Exception:
        return None, None


def purge_trash(now: float | None = None) -> int:
    now = now or time.time()
    n = 0
    for d in paths.trash_dir().iterdir():
        marker = d / ".deleted"
        try:
            if now - float(marker.read_text("utf-8")) > TRASH_DAYS * 86400:
                shutil.rmtree(d)
                n += 1
        except (OSError, ValueError):
            continue
    return n


def reindex() -> int:
    with _lock:
        c = db()
        c.execute("DELETE FROM generations")
        c.execute("DELETE FROM generations_fts")
        c.commit()
    n = 0
    for d in paths.generations_dir().iterdir():
        if not (d / "generation.json").exists():
            continue
        try:
            index(sc.read(d))
            n += 1
        except Exception:
            continue
    return n
