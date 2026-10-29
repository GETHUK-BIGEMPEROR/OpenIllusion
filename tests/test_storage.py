"""The home folder: safe writes, secrets kept off disk, the queue file, the index version, what's where."""

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


def test_secrets_never_touch_the_disk():
    settings.save({"api_key": "comfyui-test-key-1234", "local_token": "tok-5678", "max_parallel": 3})
    assert "comfyui-test-key-1234" not in "".join(f.read_text("utf-8") for f in paths.user_root().rglob("*") if f.is_file())
    assert json.loads(paths.settings_file().read_text("utf-8"))["max_parallel"] == 3
    assert not paths.secrets_file().exists()
    assert settings.api_key() == "comfyui-test-key-1234" and settings.local_token() == "tok-5678"
    assert "api_key" not in settings.public() and settings.public()["key_hint"] == "…1234"
    assert settings.public()["key_source"] == "browser"


def test_the_browser_sends_the_secrets_back_after_a_restart():
    settings._session.update(api_key="", local_token="")  # what a restart leaves
    assert settings.api_key() == "" and not settings.public()["has_key"]
    assert settings.remember(key="comfyui-sent-key-1111") is True
    assert settings.remember(key="comfyui-sent-key-1111") is False  # same key, nothing changes
    assert settings.api_key() == "comfyui-sent-key-1111" and settings.local_token() == ""
    settings.save({"api_key": ""})  # Forget
    assert settings.api_key() == ""


def test_migrate_deletes_secrets_an_older_version_wrote():
    paths.settings_file().write_text(json.dumps({"api_key": "comfyui-old-key-9876", "strip_exif": False}), "utf-8")
    paths.secrets_file().write_text(json.dumps({"api_key": "comfyui-old-key-5432", "local_token": "t"}), "utf-8")
    assert settings.api_key() == ""  # never read from disk
    settings.migrate()
    assert "api_key" not in json.loads(paths.settings_file().read_text("utf-8"))
    assert not paths.secrets_file().exists()
    assert settings.load()["strip_exif"] is False
    settings.migrate()  # nothing left


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


def _aged(p, days, now):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"x" * 10)
    os.utime(p, (now - days * 86400, now - days * 86400))
    return p


def test_scratch_cleans_itself_after_going_unused():
    import time

    from server import staging, storage

    now = time.time()
    up, cache = paths.uploads_dir(), paths.cache_dir()
    stale = _aged(up / "old.png", 40, now)
    fresh = _aged(up / "new.png", 2, now)
    shown = _aged(up / "shown.png", 40, now)
    used = _aged(up / "used.png", 40, now)
    staged = _aged(up / "staging" / str(time.time_ns()) / "a.png", 40, now)  # import staging goes by its folder's name
    draft = _aged(cache / "builder" / "d.json", 2, now)
    schema = _aged(cache / "schemas" / "s.json", 10, now)
    thumb = _aged(cache / "samples" / "t.webp", 40, now)
    storage.touch(shown)  # a page showed it
    assert staging.resolve_asset("used.png") == used.resolve()  # a run used it
    gone = storage.auto_clean(now=now + 1)
    assert gone["files"] == 3 and gone["bytes"] == 30
    assert not stale.exists() and not draft.exists() and not thumb.exists()
    assert fresh.exists() and shown.exists() and used.exists() and schema.exists() and staged.exists()
    with pytest.raises(FileNotFoundError, match="Drop it again"):
        staging.resolve_asset("old.png")


def test_comfyui_address_from_the_environment_until_one_is_saved(monkeypatch):
    from server import settings

    monkeypatch.setenv("OPENILLUSION_COMFYUI_URL", "http://host.docker.internal:8188/")
    assert settings.load()["local_comfyui_url"] == "http://host.docker.internal:8188"
    settings.save({"local_comfyui_url": "http://10.0.0.5:8188"})
    assert settings.load()["local_comfyui_url"] == "http://10.0.0.5:8188"
