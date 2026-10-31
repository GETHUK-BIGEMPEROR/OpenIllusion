"""Router adapter and the whole run loop against a fake Router."""

import asyncio
import json

import httpx
import pytest

from server import generation as sc
from server import jobs, media, paths, settings, store
from server.router import Router

from conftest import make_video


class FakeRouter:
    """Speaks the queue routes. Behaviour is switched per test."""

    def __init__(self, video_bytes: bytes, mode="ok"):
        self.video = video_bytes
        self.mode = mode
        self.calls: list[tuple[str, str]] = []
        self.polls = 0
        self.keys: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.calls.append((request.method, path))
        if request.method == "POST" and path.endswith("/requests"):
            self.keys.append(request.headers.get("Idempotency-Key"))
            if self.mode == "rate_limited" and len(self.keys) == 1:
                return httpx.Response(429, headers={"X-Comfy-Error-Type": "rate_limited", "Retry-After": "0"})
            if self.mode == "invalid":
                return httpx.Response(422, headers={"X-Comfy-Error-Type": "invalid_input", "content-type": "application/json"},
                                      json={"detail": [{"loc": ["body", "duration"], "msg": "must be ≤ 15", "type": "less_than_equal"}]})
            body = json.loads(request.content)
            assert body["images"][0].startswith("data:image/")
            assert body["video_url"].startswith("data:video/mp4;base64,")
            return httpx.Response(201, json={"request_id": "r1", "status": "IN_QUEUE", "queue_position": 2})
        if path.endswith("/status"):
            self.polls += 1
            if self.polls == 1:
                return httpx.Response(200, json={"status": "IN_PROGRESS", "queue_position": 0}, headers={"Retry-After": "0"})
            if self.mode == "moderated":
                return httpx.Response(200, json={"status": "COMPLETED", "error_type": "content_policy_violation"})
            return httpx.Response(200, json={"status": "COMPLETED"})
        if request.method == "GET" and path.endswith("/requests/r1"):
            return httpx.Response(200, json={"task": {"status": "succeeded", "content": {"url": "https://cdn.test/out.mp4"}}})
        if request.url.host == "cdn.test":
            return httpx.Response(200, content=self.video, headers={"content-type": "video/mp4"})
        return httpx.Response(404)


@pytest.fixture
def uploads(tmp_path, clip_template):
    from PIL import Image

    up = paths.uploads_dir()
    Image.new("RGB", (640, 480), (30, 60, 90)).save(up / "ref.png")
    make_video(up / "clip.mp4", seconds=5)
    return up


def motion_spec():
    return {
        "engine": "cloud/test-clip",
        "inputs": [
            {"slot": "image:1", "role": "character", "asset": "ref.png", "license": "own-image"},
            {"slot": "video:1", "role": "motion", "asset": "clip.mp4", "trim": [1, 4], "duration": 5,
             "contains_person": True, "license": "own-footage"},
        ],
        "prompt": "Image 1 is the character. Video 1 is the motion. Night rooftop, rain.",
        "params": {"duration": 6, "resolution": "768P", "seed": 7},
    }


def run_with(fake: FakeRouter, monkeypatch, spec=None):
    settings.save({"api_key": "comfyui-test-key-1234"})
    transport = httpx.MockTransport(fake)
    mgr = jobs.Manager()
    mgr.router_factory = lambda: Router(transport=transport)
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)

    async def go():
        ids = await mgr.start(spec or motion_spec())
        await asyncio.gather(*mgr.tasks.values())
        return ids

    return mgr, asyncio.run(go())


_real_sleep = asyncio.sleep


async def _fast_sleep(s, *a, **k):
    await _real_sleep(0)


def test_full_run_writes_generation_and_output(tmp_path, uploads, monkeypatch):
    fake = FakeRouter(make_video(tmp_path / "out.mp4", seconds=2).read_bytes())
    mgr, ids = run_with(fake, monkeypatch)
    job = mgr.jobs[ids[0]]
    assert job.state == "done", job.detail
    assert fake.keys == [ids[0]]  # generation id is the Idempotency-Key
    m = store.get(ids[0])
    assert m.status == "done" and m.result.cost_reported is None  # usage is the Comfy dashboard's
    assert not any(p.endswith("/estimate") for _, p in fake.calls)  # no price asked before the run
    assert m.result.kind == "video" and m.result.seed == 7
    trimmed = media.probe(store.folder(m.id) / "driving" / "driving.mp4")
    assert 2.7 <= trimmed["duration"] <= 3.3
    assert media.read_mp4_recipe(m.result.output_file)["id"] == sc.share_id(m.id)
    assert not (store.folder(m.id) / "comfy" / "workflow.json").exists()  # cloud generations carry no workflow


def test_rate_limit_retries_with_same_key(tmp_path, uploads, monkeypatch):
    fake = FakeRouter(make_video(tmp_path / "out.mp4", seconds=2).read_bytes(), mode="rate_limited")
    mgr, ids = run_with(fake, monkeypatch)
    assert mgr.jobs[ids[0]].state == "done"
    assert fake.keys == [ids[0], ids[0]]


def test_moderated_has_no_retry(tmp_path, uploads, monkeypatch):
    fake = FakeRouter(b"", mode="moderated")
    mgr, ids = run_with(fake, monkeypatch)
    job = mgr.jobs[ids[0]]
    assert job.state == "moderated" and job.fixes == []
    assert store.get(ids[0]).status == "moderated"


def test_invalid_input_maps_to_field(tmp_path, uploads, monkeypatch):
    fake = FakeRouter(b"", mode="invalid")
    mgr, ids = run_with(fake, monkeypatch)
    job = mgr.jobs[ids[0]]
    assert job.state == "failed" and "duration" in job.detail and job.fixes == ["edit"]


def test_variants_group_under_parent(tmp_path, uploads, monkeypatch):
    fake = FakeRouter(make_video(tmp_path / "out.mp4", seconds=2).read_bytes())
    spec = motion_spec() | {"variants": 2}
    mgr, ids = run_with(fake, monkeypatch, spec)
    parents = {store.get(i).lineage.parent for i in ids}
    assert len(ids) == 2 and len(parents) == 1 and None not in parents


def test_read_error_survives_html():
    resp = httpx.Response(502, text="<html>bad gateway</html>", headers={"X-Comfy-Request-Id": "abc"})
    from server.router import read_error

    e = read_error(resp)
    assert e.status == 502 and e.request_id == "abc" and e.error_type == "internal_error"


def test_key_never_leaves_in_public_settings():
    settings.save({"api_key": "comfyui-secret-abcd"})
    pub = settings.public()
    assert "api_key" not in pub and pub["key_hint"] == "…abcd"
    assert "secret" not in json.dumps(pub)


def test_failed_run_keeps_its_reason_and_can_be_dismissed(tmp_path, uploads, monkeypatch):
    fake = FakeRouter(b"", mode="invalid")
    mgr, ids = run_with(fake, monkeypatch)
    job = mgr.jobs[ids[0]]
    row = next(r for r in store.query() if r["id"] == ids[0])
    assert row["status"] == "failed" and row["error"] == job.detail
    assert mgr.dismiss(ids[0]) and ids[0] not in mgr.jobs
    assert store.get(ids[0]).status == "failed"  # the run itself stays in the Library


def test_runs_are_named_after_their_template(tmp_path, uploads, monkeypatch):
    fake = FakeRouter(make_video(tmp_path / "out.mp4", seconds=2).read_bytes())
    mgr, ids = run_with(fake, monkeypatch)
    m = store.get(ids[0])
    job = mgr.jobs[ids[0]]
    assert m.title == jobs.engines.get(m.engine.model).label.split(" · ")[0]
    assert job.engine == m.engine.model and job.prompt == m.prompt


def test_one_server_per_home_folder():
    from server import server

    paths.claim_home("http://127.0.0.1:7870/")
    try:
        with pytest.raises(paths.HomeInUse, match="7870"):
            paths.claim_home("http://127.0.0.1:7871/")
        with pytest.raises(SystemExit):  # refused before it binds a port or resumes a run
            server.main(["--port", "7871"])
    finally:
        paths.release_home()
    paths.claim_home("http://127.0.0.1:7871/")  # free again once the first one stops
    paths.release_home()


def _keyed(fake: FakeRouter, seen: list[str]):
    """The fake Router, noting the key each API call came with (asset downloads are signed, keyless)."""
    def call(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v2/"):
            seen.append(request.headers.get("X-API-Key", ""))
        return fake(request)
    return call


def test_a_run_keeps_the_key_of_the_browser_that_started_it(tmp_path, uploads, monkeypatch):
    fake, seen = FakeRouter(make_video(tmp_path / "out.mp4", seconds=2).read_bytes()), []
    mgr = jobs.Manager()
    mgr.router_factory = lambda: Router(transport=httpx.MockTransport(_keyed(fake, seen)))
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)

    async def go():
        settings.use_key("comfyui-browser-a-1111")
        ids = await mgr.start(motion_spec())
        settings.use_key("")  # the tab closes; another browser, with no key, opens the app
        await asyncio.gather(*mgr.tasks.values())
        return ids

    ids = asyncio.run(go())
    assert mgr.jobs[ids[0]].state == "done"
    assert seen and set(seen) == {"comfyui-browser-a-1111"} and mgr.keys == {}  # dropped once it ended


def test_a_run_a_restart_left_waiting_takes_the_next_key_sent(tmp_path, uploads, monkeypatch):
    fake, seen = FakeRouter(make_video(tmp_path / "out.mp4", seconds=2).read_bytes()), []
    mgr = jobs.Manager()
    mgr.router_factory = lambda: Router(transport=httpx.MockTransport(_keyed(fake, seen)))
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)

    async def go():
        ids = await mgr.start(motion_spec())  # no key, as after a restart
        for _ in range(500):  # until it reaches the wait for a key
            if "API key" in mgr.jobs[ids[0]].detail:
                break
            await _real_sleep(0)
        assert mgr.jobs[ids[0]].state == "waiting" and "API key" in mgr.jobs[ids[0]].detail
        settings.remember(key="comfyui-browser-b-2222")  # a browser holding a key opens the app
        await asyncio.gather(*mgr.tasks.values())
        return ids

    ids = asyncio.run(go())
    assert mgr.jobs[ids[0]].state == "done" and set(seen) == {"comfyui-browser-b-2222"}
