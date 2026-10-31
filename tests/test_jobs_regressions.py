"""Regression coverage for job lifecycle and mutation gates."""

import asyncio
import json

import httpx
import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import engines, jobs, paths, routes, settings, staging, store
from server import generation as sc
from server.routes import builder as builder_routes
from server.routes.system import _probe_router

from conftest import make_image


KLEIN = "local/flux3-klein-edit"
HAT = "local/qwen21-add-hat"


def _manifest(sid: str | None = None, engine: str = HAT) -> sc.Manifest:
    return sc.Manifest(
        id=sid or sc.new_id(),
        title="Lifecycle test",
        mode="edit",
        engine=sc.Engine(kind="local", model=engine),
        prompt="test",
        status="running",
    )


def _job(m: sc.Manifest, **kw) -> jobs.Job:
    return jobs.Job(
        id=m.id,
        title=m.title,
        mode=m.mode,
        model=m.engine.model,
        provider="local",
        engine=m.engine.model,
        kind="local",
        **kw,
    )


def _call(fn):
    async def go():
        app = web.Application()
        table = web.RouteTableDef()
        routes.register(table)
        app.add_routes(table)
        async with TestClient(TestServer(app)) as client:
            return await fn(client)

    return asyncio.run(go())


def test_shutdown_keeps_a_running_job_resumable_and_bounds_task_registry(monkeypatch):
    m = store.save(_manifest())

    async def go():
        manager = jobs.Manager()
        entered = asyncio.Event()
        hold = asyncio.Event()

        async def blocked(_job):
            entered.set()
            await hold.wait()

        monkeypatch.setattr(manager, "_run_inner", blocked)
        job = _job(m)
        manager.jobs[job.id] = job
        manager._track(job.id, asyncio.create_task(manager._run(job)))
        await entered.wait()
        await manager.shutdown()

        assert job.state not in jobs.TERMINAL
        assert manager.tasks == {}
        saved = json.loads((paths.user_root() / "jobs.json").read_text("utf-8"))
        assert saved[0]["id"] == job.id and saved[0]["state"] not in jobs.TERMINAL

        resumed = jobs.Manager()
        entered_again = asyncio.Event()

        async def blocked_again(_job):
            entered_again.set()
            await hold.wait()

        monkeypatch.setattr(resumed, "_run_inner", blocked_again)
        assert resumed.resume() == 1
        await entered_again.wait()
        assert set(resumed.tasks) == {job.id}
        await resumed.shutdown()
        assert resumed.tasks == {}

    asyncio.run(go())


def test_explicit_pre_submit_cancel_is_terminal(monkeypatch):
    m = store.save(_manifest())

    async def go():
        manager = jobs.Manager()
        entered = asyncio.Event()
        hold = asyncio.Event()

        async def blocked(_job):
            entered.set()
            await hold.wait()

        monkeypatch.setattr(manager, "_run_inner", blocked)
        job = _job(m)
        manager.jobs[job.id] = job
        manager._track(job.id, asyncio.create_task(manager._run(job)))
        await entered.wait()
        assert await manager.cancel(job.id)
        await asyncio.gather(*list(manager.tasks.values()), return_exceptions=True)
        await asyncio.sleep(0)
        assert job.state == "cancelled"
        assert store.get(job.id).status == "cancelled"
        assert manager.tasks == {}

    asyncio.run(go())


def test_terminal_state_is_not_claimed_when_manifest_save_fails(monkeypatch):
    m = store.save(_manifest())
    manager = jobs.Manager()
    job = _job(m, state="running")
    manager.jobs[job.id] = job

    def fail_save(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(store, "save", fail_save)
    assert manager._finish(job, "failed", "provider failed") is False
    assert job.state == "running"
    assert job.error["error_type"] == "persistence_error"
    assert "Couldn't save" in job.detail
    assert sc.read(store.folder(job.id)).status == "running"


def test_parallel_limit_downshift_does_not_create_a_second_permit_pool(monkeypatch):
    limit = [2]
    monkeypatch.setattr(settings, "load", lambda: {"max_parallel": limit[0]})

    async def go():
        manager = jobs.Manager()
        entered = {str(n): asyncio.Event() for n in range(3)}
        release = {str(n): asyncio.Event() for n in range(3)}

        async def blocked(job):
            entered[job.id].set()
            await release[job.id].wait()

        monkeypatch.setattr(manager, "_run_inner", blocked)
        for n in range(2):
            job = jobs.Job(id=str(n), title="t", mode="edit", model=HAT, provider="local")
            manager.jobs[job.id] = job
            manager._track(job.id, asyncio.create_task(manager._run(job)))
        await entered["0"].wait()
        await entered["1"].wait()
        assert manager._slots_in_use == 2

        limit[0] = 1
        third = jobs.Job(id="2", title="t", mode="edit", model=HAT, provider="local")
        manager.jobs[third.id] = third
        manager._track(third.id, asyncio.create_task(manager._run(third)))
        await asyncio.sleep(0.12)
        assert not entered["2"].is_set()
        release["0"].set()
        await asyncio.sleep(0.12)
        assert not entered["2"].is_set()
        release["1"].set()
        await asyncio.wait_for(entered["2"].wait(), 1)
        release["2"].set()
        await asyncio.gather(*list(manager.tasks.values()))
        await asyncio.sleep(0)
        assert manager.tasks == {}

    asyncio.run(go())


@pytest.mark.usefixtures("fixture_templates")
def test_variants_roll_independent_random_seeds(monkeypatch):
    make_image(paths.uploads_dir() / "ref.png")
    rolled = iter((101, 202, 303))
    monkeypatch.setattr(staging.random, "randint", lambda *_: next(rolled))
    spec = {
        "engine": KLEIN,
        "inputs": [{"slot": "image:1", "asset": "ref.png"}],
        "prompt": "A portrait",
        "params": {"size": "1024", "steps": 8, "seed": -1},
        "variants": 3,
    }

    async def go():
        manager = jobs.Manager()

        async def no_run(_job):
            return None

        monkeypatch.setattr(manager, "_run", no_run)
        ids = await manager.start(spec)
        await asyncio.gather(*list(manager.tasks.values()))
        return ids

    ids = asyncio.run(go())
    assert spec["params"]["seed"] == -1
    assert [store.get(sid).params["seed"] for sid in ids] == [101, 202, 303]


@pytest.mark.usefixtures("fixture_templates")
def test_second_variant_staging_failure_rolls_back_the_whole_group(monkeypatch):
    make_image(paths.uploads_dir() / "ref.png")
    manager = jobs.Manager()
    real_save = store.save
    saves = 0

    def fail_second_save(*args, **kwargs):
        nonlocal saves
        saves += 1
        if saves == 2:
            raise OSError("second variant failed")
        return real_save(*args, **kwargs)

    monkeypatch.setattr(store, "save", fail_second_save)
    spec = {
        "engine": KLEIN,
        "inputs": [{"slot": "image:1", "asset": "ref.png"}],
        "prompt": "A portrait",
        "params": {"size": "1024", "steps": 8, "seed": 7},
        "variants": 2,
    }

    with pytest.raises(OSError, match="second variant failed"):
        asyncio.run(manager.start(spec))

    assert saves == 2
    assert manager.jobs == {} and manager.tasks == {}
    assert list(paths.generations_dir().iterdir()) == []
    assert list(paths.trash_dir().iterdir()) == []
    assert store.query() == []


@pytest.mark.usefixtures("fixture_templates")
def test_failed_staging_removes_the_partial_generation_folder(monkeypatch):
    sid = "01J00000000000000000000000"
    make_image(paths.uploads_dir() / "ref.png")
    monkeypatch.setattr(staging.sc, "new_id", lambda: sid)

    def fail_save(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(store, "save", fail_save)
    spec = {
        "engine": KLEIN,
        "inputs": [{"slot": "image:1", "asset": "ref.png"}],
        "prompt": "A portrait",
        "params": {"seed": 1},
    }
    with pytest.raises(OSError, match="disk full"):
        staging.prepare_generation(spec)
    assert not store.folder(sid).exists()


@pytest.mark.usefixtures("fresh_templates")
def test_resumed_local_job_reconnects_proxy_before_polling():
    m = store.save(_manifest())
    manager = jobs.Manager()
    sequence = []

    async def ensure_proxy():
        sequence.append("proxy")
        return {"ok": True}

    class V2:
        async def job(self, request_id):
            sequence.append(f"poll:{request_id}")
            return {"id": request_id, "status": "canceled"}

        async def events(self, _path):
            if False:
                yield "progress", {}

    manager.ensure_proxy = ensure_proxy
    manager.v2_factory = V2
    job = _job(m, request_id="local-job-1", state="running")
    manager.jobs[job.id] = job

    asyncio.run(manager._run_local(job, m, store.folder(m.id)))
    assert sequence == ["proxy", "poll:local-job-1"]
    assert job.state == "cancelled"


@pytest.mark.usefixtures("fresh_templates")
def test_active_template_cannot_be_deleted_or_replaced(monkeypatch):
    custom = engines.duplicate_template(HAT)
    active = jobs.Job(
        id="active",
        title="active",
        mode="edit",
        model=custom.id,
        provider="local",
        engine=custom.id,
        state="running",
    )
    monkeypatch.setattr(jobs.MANAGER, "jobs", {active.id: active})

    async def go(client):
        deleted = await client.delete("/api/builder/template", params={"engine": custom.id})
        replaced = await client.post("/api/builder/save", json={"replace": custom.id})
        return deleted.status, replaced.status

    try:
        assert _call(go) == (409, 409)
        assert custom.id in engines.ENGINES and custom.path.is_file()
    finally:
        engines.delete_template(custom.id)


def test_restore_maintenance_gate_rejects_new_runs_and_template_mutations(monkeypatch):
    monkeypatch.setattr(jobs.MANAGER, "jobs", {})
    monkeypatch.setattr(jobs.MANAGER, "tasks", {})
    monkeypatch.setattr(jobs.MANAGER, "_maintenance", None)
    assert jobs.MANAGER.begin_maintenance("restore")

    async def go(client):
        run = await client.post("/api/run", json={})
        hide = await client.post("/api/templates/hide", json={"engine": HAT})
        save = await client.post("/api/builder/save", json={})
        return run.status, hide.status, save.status

    try:
        assert _call(go) == (409, 409, 409)
        with pytest.raises(jobs.MaintenanceError):
            asyncio.run(jobs.MANAGER.start({}))
    finally:
        jobs.MANAGER.end_maintenance("restore")


def test_generation_delete_and_missing_template_rerun_have_deliberate_errors():
    missing_template = store.save(_manifest(engine="local/template-was-removed"))

    async def go(client):
        deleted = await client.delete("/api/generations/does-not-exist")
        rerun = await client.post(f"/api/generations/{missing_template.id}/rerun", json={})
        return deleted.status, rerun.status, await rerun.json()

    deleted, rerun, payload = _call(go)
    assert deleted == 404
    assert rerun == 409 and "no longer installed" in payload["error"]


def test_builder_workflow_reader_stops_as_soon_as_stream_exceeds_limit(monkeypatch):
    class Part:
        def __init__(self):
            self.chunks = [b"12345", b"67890", b"unread"]
            self.reads = 0

        async def read_chunk(self, _size):
            self.reads += 1
            return self.chunks.pop(0) if self.chunks else b""

    part = Part()
    monkeypatch.setattr(builder_routes, "MAX_WORKFLOW", 8)
    assert asyncio.run(builder_routes._read_workflow_part(part)) is None
    assert part.reads == 2


def test_router_probe_can_decode_a_non_200_response():
    class ProbeRouter:
        def _client(self):
            transport = httpx.MockTransport(
                lambda _request: httpx.Response(
                    401,
                    json={"error": "bad key"},
                    headers={"X-Comfy-Error-Type": "unauthorized"},
                )
            )
            return httpx.AsyncClient(transport=transport, base_url="https://router.test")

    result = asyncio.run(_probe_router(ProbeRouter()))
    assert result["ok"] is False
    assert result["status"] == 401
