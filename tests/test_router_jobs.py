"""Router adapter and the whole run loop against a fake Router."""

import asyncio
import json

import httpx
import pytest

from server import jobs, media, paths, settings, store
from server.router import Router, RouterError

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
        if path.endswith("/estimate"):
            return httpx.Response(200, json={"source": "estimated", "min_amount": "0.40", "max_amount": "0.90"})
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
            return httpx.Response(200, json={"task": {"status": "succeeded", "content": {"url": "https://cdn.test/out.mp4"}}},
                                  headers={"X-Comfy-Credits-Used": "0.62"})
        if request.url.host == "cdn.test":
            return httpx.Response(200, content=self.video, headers={"content-type": "video/mp4"})
        return httpx.Response(404)


@pytest.fixture
def uploads(tmp_path):
    from PIL import Image

    up = paths.uploads_dir()
    Image.new("RGB", (640, 480), (30, 60, 90)).save(up / "ref.png")
    make_video(up / "clip.mp4", seconds=5)
    return up


def motion_spec():
    return {
        "engine": "acme/any-router-model",  # no template: the generic schema-form path
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
    assert job.estimate["source"] == "estimated"
    assert fake.keys == [ids[0]]  # generation id is the Idempotency-Key
    m = store.get(ids[0])
    assert m.status == "done" and m.result.cost_reported == "0.62"
    assert m.result.kind == "video" and m.result.seed == 7
    trimmed = media.probe(store.folder(m.id) / "driving" / "driving.mp4")
    assert 2.7 <= trimmed["duration"] <= 3.3
    assert media.read_mp4_recipe(m.result.output_file)["id"] == m.id
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


def test_estimate_not_enabled_is_unknown():
    t = httpx.MockTransport(lambda r: httpx.Response(403, headers={"X-Comfy-Error-Type": "not_enabled"}))
    est = asyncio.run(Router(key="k", transport=t).estimate("bfl/flux-3-image", {"prompt": "x"}))
    assert est == {"source": "unknown", "reason": "not_enabled"}


def test_key_never_leaves_in_public_settings():
    settings.save({"api_key": "comfyui-secret-abcd"})
    pub = settings.public()
    assert "api_key" not in pub and pub["key_hint"] == "…abcd"
    assert "secret" not in json.dumps(pub)
