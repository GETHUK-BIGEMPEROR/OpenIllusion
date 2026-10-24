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
SHELVES = ("mine", "imported", "starter")

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
  starred INTEGER, parent TEXT, variant TEXT
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
            _conn.executescript(SCHEMA)
            _conn_path = f
        return _conn


def folder(generation_id: str) -> Path:
    if not generation_id or any(c in generation_id for c in "/\\.:"):
        raise ValueError("bad generation id")
    return paths.generations_dir() / generation_id


def shelf_of(generation_id: str) -> str:
    f = folder(generation_id) / ".shelf"
    return f.read_text("utf-8").strip() if f.exists() else "mine"


def set_shelf(generation_id: str, shelf: str) -> None:
    (folder(generation_id) / ".shelf").write_text(shelf, "utf-8")


def index(m: sc.Manifest, shelf: str | None = None) -> None:
    shelf = shelf or shelf_of(m.id)
    has_driving = any(i.slot.startswith("video:") and (i.file or i.url) for i in m.inputs)
    refs = sum(1 for i in m.inputs if i.slot.startswith("image:"))
    res = m.result
    row = (
        m.id, m.title, m.mode, m.engine.model, (res.provider if res else None) or m.engine.provider,
        m.status, m.outcome, shelf, m.created, time.time(),
        json.dumps(m.tags), int(has_driving), refs,
        res.poster if res else None, res.file if res else None, res.kind if res else None,
        int(m.starred), m.lineage.parent, m.variant,
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


def save(m: sc.Manifest, shelf: str | None = None) -> sc.Manifest:
    f = folder(m.id)
    sc.write(f, m)
    if shelf:
        set_shelf(m.id, shelf)
    index(m, shelf)
    return m


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


def restore(generation_id: str) -> sc.Manifest:
    src = paths.trash_dir() / generation_id
    dst = folder(generation_id)
    shutil.move(str(src), str(dst))
    (dst / ".deleted").unlink(missing_ok=True)
    m = sc.read(dst)
    index(m)
    return m


def trash() -> list[dict]:
    out = []
    for d in sorted(paths.trash_dir().iterdir()):
        try:
            m = sc.read(d)
            deleted = float((d / ".deleted").read_text("utf-8"))
        except Exception:
            continue
        out.append({"id": m.id, "title": m.title, "deleted": deleted, "purge_at": deleted + TRASH_DAYS * 86400})
    return out


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


def seed_starters(src: Path) -> int:
    """Copy the repo's starter generations into the library once."""
    if not src.exists():
        return 0
    n = 0
    for d in src.iterdir():
        if not (d / "generation.json").exists():
            continue
        try:
            m = sc.read(d)
        except Exception:
            continue
        dst = folder(m.id)
        if dst.exists():
            continue
        shutil.copytree(d, dst)
        set_shelf(m.id, "starter")
        index(m, "starter")
        n += 1
    return n
