"""The home folder: safe writes, secrets kept apart, the queue file, the index version, what's where."""

import json
import os
import sqlite3

import pytest

from server import jobs, paths, settings, store
from server import generation as sc


def test_write_atomic_keeps_the_old_file_when_the_write_fails(monkeypatch):
    f = paths.user_root() / "settings.json"
    paths.write_atomic(f, '{"a": 1}')

    def boom(*a):
        raise OSError("disk full")

    monkeypatch.setattr(os, "replace", boom)
    with pytest.raises(OSError):
        paths.write_atomic(f, '{"a": 2}')
    assert json.loads(f.read_text("utf-8")) == {"a": 1}
    assert [p.name for p in f.parent.iterdir() if p.name.endswith(".tmp")] == []


def test_secrets_live_apart_from_settings():
    settings.save({"api_key": "comfyui-test-key-1234", "max_parallel": 3})
    plain = json.loads(paths.settings_file().read_text("utf-8"))
    secret = json.loads(paths.secrets_file().read_text("utf-8"))
    assert "api_key" not in plain and plain["max_parallel"] == 3
    assert secret["api_key"] == "comfyui-test-key-1234"
    assert settings.api_key() == "comfyui-test-key-1234"
    assert "api_key" not in settings.public() and settings.public()["key_hint"] == "…1234"
    if os.name != "nt":
        assert paths.secrets_file().stat().st_mode & 0o077 == 0


def test_migrate_moves_an_old_key_out_of_settings():
    paths.settings_file().write_text(json.dumps({"api_key": "comfyui-old-key-9876", "strip_exif": False}), "utf-8")
    assert settings.api_key() == "comfyui-old-key-9876"  # still read before the move
    settings.migrate()
    assert "api_key" not in json.loads(paths.settings_file().read_text("utf-8"))
    assert settings.api_key() == "comfyui-old-key-9876" and settings.load()["strip_exif"] is False
    settings.migrate()  # nothing left to move
    assert json.loads(paths.secrets_file().read_text("utf-8"))["api_key"] == "comfyui-old-key-9876"


def test_the_queue_file_keeps_states_not_progress():
    mgr = jobs.Manager()
    job = jobs.Job(id="01JB8Z0000000000000000000A", title="t", mode="edit", model="m", provider="local", kind="local")
    mgr.jobs[job.id] = job
    mgr.set(job, "running", "Running in your ComfyUI")
    f = paths.user_root() / "jobs.json"
    written = f.stat().st_mtime_ns
    job.progress, job.preview = {"value": 0.5}, "data:image/jpeg;base64," + "A" * 5000
    mgr.emit(job, save=False)  # a progress tick
    assert f.stat().st_mtime_ns == written
    mgr.set(job, "downloading", "Saving the result")
    saved = json.loads(f.read_text("utf-8"))[0]
    assert saved["state"] == "downloading" and saved["preview"] is None and saved["progress"] is None


def test_an_index_from_another_version_is_rebuilt():
    m = sc.Manifest(id=sc.new_id(), title="Kept", mode="edit", engine=sc.Engine(model="local/qwen21-add-hat"), status="done")
    store.save(m)
    store._conn.close()
    store._conn = None
    with sqlite3.connect(paths.db_file()) as c:  # an older layout: one column, no version
        c.executescript("DROP TABLE generations; CREATE TABLE generations (id TEXT); PRAGMA user_version = 0;")
    assert [r["title"] for r in store.query()] == ["Kept"]
    assert store.db().execute("PRAGMA user_version").fetchone()[0] == store.INDEX_VERSION


def test_every_entry_of_the_home_folder_is_classified():
    settings.save({"api_key": "comfyui-test-key-1234"})
    store.save(sc.Manifest(id=sc.new_id(), title="x", mode="edit", engine=sc.Engine(model="local/qwen21-add-hat"), status="done"))
    jobs.Manager()._persist()
    for d in (paths.uploads_dir, paths.cache_dir, paths.trash_dir):
        d()
    (paths.user_root() / "templates").mkdir(exist_ok=True)
    paths.claim_home("http://127.0.0.1:7870/")
    try:
        names = {p.name for p in paths.user_root().iterdir()}
    finally:
        paths.release_home()
    assert names - set(paths.TIERS) == set(), "add new home entries to paths.TIERS (backup and cleaning read it)"
