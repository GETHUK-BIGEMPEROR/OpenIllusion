"""Bulk trash, delete forever, storage cleanup and template duplicates."""

import asyncio
import os
import time

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import engines, jobs, paths, routes, storage, store, usage
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
    # Nothing exported or backed up yet: there's no folder, and nothing to clean.
    assert not storage.backups_dir().exists() and storage.clean("backups") == {"removed": 0, "bytes": 0}


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
        r = await put(generation=mine.id, reuse=False)  # its prompt isn't the template's: take only the result
        d = await r.json()
        assert r.status == 200 and d["cover_custom"]
        assert d["cover_before"] is None  # the run kept no input file: nothing to show beside it
        # A run's lead input goes beside its cover, served by the cover route.
        m = store.get(mine.id)
        (store.folder(mine.id) / "refs").mkdir()
        make_image(store.folder(mine.id) / "refs" / "in.png", size=(320, 400))
        m.inputs = [sc.InputItem(slot="image:1", file="refs/in.png")]
        store.save(m)
        d = await (await put(generation=mine.id, reuse=False)).json()
        assert d["cover_before"] == {"url": d["cover"] + "&before=1", "kind": "image"}
        got = await c.get(d["cover_before"]["url"])
        assert got.status == 200 and (await got.read())[8:12] == b"WEBP"
        return True

    try:
        assert call(go)
    finally:
        engines.clear_cover(HAT)


@pytest.mark.usefixtures("fresh_templates")
def test_use_as_cover_asks_when_the_run_used_other_inputs_and_can_keep_them():
    shipped = engines.ENGINES[HAT]
    run = gen("Red hat")
    m = store.get(run.id)
    m.prompt = "Put a red beret on the person in <image1>."
    (store.folder(run.id) / "refs").mkdir()
    make_image(store.folder(run.id) / "refs" / "in.png", size=(320, 400))
    m.inputs = [sc.InputItem(slot="image:1", file="refs/in.png")]
    store.save(m)

    async def go(c):
        put = lambda **b: c.put("/api/cover", json={"engine": HAT, "generation": run.id, **b})
        r = await put()
        assert r.status == 409 and (await r.json())["differs"] == ["Image 1", "Prompt"]
        r = await put(reuse=True)
        d = await r.json()
        assert r.status == 200 and d["cover_custom"] and d["edited"]
        assert (await put()).status == 200  # the template opens with what the run used now: nothing to ask
        return True

    try:
        assert call(go)
        e = engines.ENGINES[HAT]
        assert e.default_prompt == m.prompt and e.workflow["5"]["inputs"]["prompt"] == m.prompt
        assert e.default_inputs["image:1"].read_bytes() == (store.folder(run.id) / "refs" / "in.png").read_bytes()
        assert engines.defaults_workflow(e)["5"]["inputs"]["prompt"] == m.prompt  # the downloaded workflow too
        back = engines.reset_template(HAT)
        assert back.default_prompt == shipped.default_prompt and back.default_inputs == shipped.default_inputs
    finally:
        engines.clear_cover(HAT)


@pytest.mark.usefixtures("fresh_templates")
def test_a_draft_is_published_by_a_finished_run_of_it_which_becomes_its_cover():
    import json

    e = engines.duplicate_template(HAT)
    data = json.loads(e.path.read_text("utf-8"))
    data["draft"] = True
    for k in ("cover", "cover_video"):
        data.pop(k, None)
    e.path.write_text(json.dumps(data), "utf-8")
    engines.reload_templates()
    assert engines.describe(engines.ENGINES[e.id])["draft"]
    hat_run, run = gen("Hat"), gen("Copy")
    m = store.get(run.id)
    m.engine.model = e.id
    store.save(m)
    usage.note(e.id)  # the test run started

    async def go(c):
        pub = lambda g: c.post("/api/templates/publish", json={"engine": e.id, "generation": g})
        assert (await pub("")).status == 404
        assert (await pub(hat_run.id)).status == 409  # a run of another template tests nothing
        r = await pub(run.id)
        d = await r.json()
        assert r.status == 200 and not d["draft"] and d["cover_custom"]
        assert d["uses"] >= 1 and d["used_at"]  # the page swaps this in: it keeps its place in Recently used
        assert (await pub(run.id)).status == 404  # published once
        assert (await c.post("/api/templates/publish", json={"engine": HAT, "generation": hat_run.id})).status == 404
        return True

    try:
        assert call(go)
        assert "draft" not in json.loads(e.path.read_text("utf-8"))
    finally:
        engines.clear_cover(e.id)
        engines.delete_template(e.id)


def test_typical_is_the_median_of_finished_runs_of_that_template():
    def run(elapsed, status="done", model=HAT):
        m = sc.Manifest(id=sc.new_id(), title="t", mode="edit", engine=sc.Engine(model=model), prompt="p", status=status,
                        result=sc.Result(file="result/x.webp", kind="image", elapsed=elapsed))
        store.save(m, shelf="mine")

    assert store.typical(HAT) is None
    run(30)
    assert store.typical(HAT) is None  # one run is no pattern
    run(50)
    assert store.typical(HAT) == 40
    run(90)
    run(500, status="failed")
    run(7, model="cloud/other")
    assert store.typical(HAT) == 50


def test_template_use_outlives_its_runs():
    from server import usage

    a = gen("A")
    b = gen("B")
    store.update(b.id, created=a.created + 60)
    u = usage.load()[HAT]  # no file yet: counted from the library
    assert u == {"n": 2, "at": a.created + 60}
    store.delete_many([a.id, b.id])
    store.empty_trash()
    usage.note(HAT, at=a.created + 120)
    usage.note("cloud/other", at=a.created + 30)
    assert usage.load()[HAT] == {"n": 3, "at": a.created + 120}

    async def go(c):
        return await (await c.get("/api/engines")).json()
    e = next(x for x in call(go) if x["id"] == HAT)
    assert e["used_at"] == a.created + 120 and e["uses"] == 3


def test_a_run_without_its_template_is_refused_not_crashed():
    async def go(c):
        return [(await c.post(f"/api{p}", json={"prompt": "x"})).status for p in ("/compose", "/run", "/local/check")]
    assert call(go) == [400, 400, 400]
