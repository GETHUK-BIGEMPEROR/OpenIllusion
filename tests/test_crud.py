"""Bulk trash, delete forever, storage cleanup and template duplicates."""

import asyncio
import os
import time

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import engines, jobs, paths, routes, storage, store
from server import generation as sc

from conftest import make_image

HAT = "local/qwen21-add-hat"


def gen(title="Take", starred=False):
    sid = sc.new_id()
    f = store.folder(sid)
    (f / "result").mkdir(parents=True)
    make_image(f / "result" / "poster.webp", size=(320, 400))
    m = sc.Manifest(id=sid, title=title, mode="edit", engine=sc.Engine(model=HAT), prompt="p", status="done", starred=starred,
                    result=sc.Result(file="result/poster.webp", poster="result/poster.webp", kind="image"))
    return store.save(m, shelf="mine")


def call(fn):
    """Run ``fn(client)`` against the API routes."""
    async def go():
        app = web.Application()
        table = web.RouteTableDef()
        routes.register(table)
        app.add_routes(table)
        async with TestClient(TestServer(app)) as c:
            return await fn(c)
    return asyncio.run(go())


def test_delete_many_and_trash_rows():
    a, b = gen("A"), gen("B")
    assert store.delete_many([a.id, b.id, "nope"]) == [a.id, b.id]
    assert store.query() == []
    rows = store.trash()
    assert {r["id"] for r in rows} == {a.id, b.id}
    assert rows[0]["poster"] == "result/poster.webp" and rows[0]["width"] == 320 and rows[0]["bytes"] > 0


def test_purge_and_empty_trash():
    a, b = gen(), gen()
    store.delete_many([a.id, b.id])
    assert store.purge(a.id) and not store.purge(a.id)
    assert [r["id"] for r in store.trash()] == [b.id]
    assert store.empty_trash() == 1 and store.trash() == []
    with pytest.raises(FileNotFoundError):
        store.restore(b.id)
    with pytest.raises(ValueError):
        store.purge("../x")


def test_bulk_routes_keep_running_runs(monkeypatch):
    a, b = gen("A"), gen("B")
    monkeypatch.setattr(jobs.MANAGER, "jobs", {b.id: jobs.Job(id=b.id, title="B", mode="edit", model=HAT, provider="local", state="running")})

    async def go(c):
        r = await (await c.post("/api/generations/trash", json={"ids": [a.id, b.id]})).json()
        assert r["moved"] == [a.id] and r["kept"] == [b.id]
        assert (await c.delete(f"/api/generations/{b.id}")).status == 409
        t = await (await c.get("/api/trash")).json()
        assert [x["id"] for x in t] == [a.id]
        f = await c.get(f"/api/trash/{a.id}/file/result/poster.webp")
        assert f.status == 200 and len(await f.read()) > 0  # a body, not just headers (sendfile on Windows)
        assert (await c.get(f"/api/trash/{a.id}/file/..%2F..%2F..%2Fsettings.json")).status == 404
        back = await (await c.post("/api/trash/restore", json={"ids": [a.id, "gone"]})).json()
        assert back["restored"] == [a.id]
        await c.post("/api/generations/trash", json={"ids": [a.id]})
        assert (await c.delete(f"/api/trash/{a.id}")).status == 200
        assert (await c.delete(f"/api/trash/{a.id}")).status == 404
        await c.post("/api/generations/trash", json={"ids": [b.id]})  # still running: stays
        c2 = gen("C")
        store.delete_many([c2.id])
        gone = await (await c.post("/api/trash/purge", json={"ids": [c2.id, "../x", "gone"]})).json()
        assert gone["removed"] == [c2.id] and await (await c.get("/api/trash")).json() == []
        return True

    assert call(go)


def test_storage_usage_and_clean():
    up = paths.uploads_dir()
    old, new = up / "old.png", up / "new.png"
    make_image(old), make_image(new)
    past = time.time() - storage.UPLOAD_GRACE - 10
    os.utime(old, (past, past))
    (paths.cache_dir() / "schemas").mkdir()
    (paths.cache_dir() / "schemas" / "x.json").write_text("{}")
    u = storage.usage()
    assert set(u) == set(storage.BUCKETS) and u["uploads"]["items"] == 2 and u["uploads"]["bytes"] > 0

    r = storage.clean("uploads")
    assert r["removed"] == 1 and r["bytes"] > 0 and not old.exists() and new.exists()
    assert storage.clean("cache")["removed"] == 1 and storage.usage()["cache"]["items"] == 0
    with pytest.raises(ValueError):
        storage.clean("generations")


@pytest.mark.usefixtures("fresh_templates")
def test_duplicate_is_a_self_contained_user_template():
    src = engines.ENGINES[HAT]
    e = engines.duplicate_template(HAT)
    assert e.id == HAT + "-copy" and e.built and e.origin == "user" and not e.edited
    assert e.label.startswith("Add a hat (copy)")
    assert e.default_inputs["image:1"].is_file() and paths.user_root() in e.default_inputs["image:1"].parents
    assert e.cover and e.cover.is_file() and e.workflow == src.workflow
    assert engines.duplicate_template(e.id).id == HAT + "-copy-2"

    engines.delete_template(e.id)
    assert e.id not in engines.ENGINES and not e.default_inputs["image:1"].exists()
    assert HAT in engines.ENGINES


def test_cover_comes_only_from_a_finished_run_of_that_template():
    mine = gen("Mine")
    other = gen("Other")
    m = store.get(other.id)
    m.engine.model = "local/someone-else"
    store.save(m)
    running = gen("Running")
    m = store.get(running.id)
    m.status = "running"
    store.save(m)

    async def go(c):
        put = lambda **b: c.put("/api/cover", json={"engine": HAT, **b})
        assert (await put(asset="x.png")).status == 400  # no uploads: a cover is a real result
        assert (await put(generation=other.id)).status == 409
        assert (await put(generation=running.id)).status == 409
        r = await put(generation=mine.id)
        assert r.status == 200 and (await r.json())["cover_custom"]
        return True

    try:
        assert call(go)
    finally:
        engines.clear_cover(HAT)
