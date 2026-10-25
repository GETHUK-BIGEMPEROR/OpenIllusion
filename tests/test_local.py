"""Local templates, the requirements check, and the run loop against a fake Comfy API v2."""

import asyncio
import json

import httpx
import pytest

from server import engines, jobs, local, media, paths, store

from conftest import make_video

pytestmark = pytest.mark.usefixtures("fixture_templates")

KLEIN = "local/flux3-klein-edit"
H3 = "local/minimax-h3-i2v"


def object_info_for(*workflows, drop_nodes=(), drop_models=()):
    """A minimal /object_info that accepts every node and combo value in these workflows."""
    info: dict = {}
    for wf in workflows:
        for node in wf.values():
            ct = node["class_type"]
            if ct in drop_nodes:
                continue
            req = info.setdefault(ct, {"input": {"required": {}}})["input"]["required"]
            for k, v in node["inputs"].items():
                if isinstance(v, str) and v.endswith(".safetensors") and v not in drop_models:
                    req.setdefault(k, [[]])[0].append(v)
                elif isinstance(v, str) and v.endswith(".safetensors"):
                    req.setdefault(k, [["something_else.safetensors"]])
    return info


def klein_spec(n_images=2, seed=-1):
    return {
        "engine": KLEIN,
        "inputs": [{"slot": f"image:{i}", "asset": "ref.png"} for i in range(1, n_images + 1)],
        "prompt": "Put <ref_image_0> in the jacket from <ref_image_1>",
        "params": {"size": "1024", "steps": 8, "seed": seed},
    }


def test_templates_load():
    assert engines.get(KLEIN).kind == "local" and engines.get(H3).kind == "local"
    with pytest.raises(KeyError):
        engines.get("local/nope")


def test_build_local_prunes_unfilled_refs():
    wf = engines.compose(klein_spec(2))["template"]
    assert "13" not in wf and "14" not in wf
    ref = wf["17"]["inputs"]
    assert ref["images.image0"] == ["11", 0] and ref["images.image1"] == ["12", 0]
    assert "images.image2" not in ref and "images.image3" not in ref
    assert wf["11"]["inputs"]["image"] == "{{image:1}}"
    assert wf["7"]["inputs"]["steps"] == 8
    assert wf["7"]["inputs"]["seed"] == engines.SEED_TOKEN
    assert wf["15"]["inputs"]["megapixels"] == pytest.approx(1.049, abs=0.001)
    assert wf["4"]["inputs"]["text"].startswith("Put <ref_image_0>")


def test_build_local_casts_params():
    spec = {"engine": H3, "inputs": [{"slot": "image:1", "asset": "ref.png"}], "prompt": "wave",
            "params": {"duration": 5, "megapixels": "0.6", "steps": "6", "seed": 42}}
    wf = engines.compose(spec)["template"]
    assert wf["21"]["inputs"]["value"] == 5.0
    assert wf["2"]["inputs"]["megapixels"] == 0.6
    assert wf["32"]["inputs"]["steps"] == 6
    assert wf["30"]["inputs"]["noise_seed"] == 42


def test_check_lists_everything_missing():
    wf = engines.compose(klein_spec(1))["template"]
    info = object_info_for(wf, drop_nodes=("ReferenceMultiLatent", "EmptyFlux2LatentImage"),
                           drop_models=("flux3-image-klein-int8-convrot.safetensors",))
    c = local.check(wf, info, engines.get(KLEIN).hints)
    assert not c["ok"]
    assert {n["class_type"] for n in c["missing_nodes"]} == {"ReferenceMultiLatent", "EmptyFlux2LatentImage"}
    (mm,) = c["missing_models"]
    assert mm["value"] == "flux3-image-klein-int8-convrot.safetensors"
    assert mm["folder"] == "diffusion_models" and mm["url"].startswith("https://huggingface.co/")
    assert "missing nodes" in local.check_message(c) and "missing models" in local.check_message(c)


def test_check_passes_and_ignores_tokens_and_links():
    wf = engines.compose(klein_spec(4))["template"]
    assert local.check(wf, object_info_for(wf))["ok"]


# ---- the run loop ----------------------------------------------------------------


class FakeV2:
    """Speaks the Comfy API v2 job routes."""

    def __init__(self, out: bytes, ctype="image/png", mode="ok"):
        self.out, self.ctype, self.mode = out, ctype, mode
        self.uploads: list[str] = []
        self.submitted: list[dict] = []
        self.keys: list[str] = []
        self.polls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v2/health":
            return httpx.Response(200, json={"status": "healthy"})
        if path == "/api/v2/assets" and request.method == "POST":
            n = len(self.uploads) + 1
            self.uploads.append(f"a{n}")
            return httpx.Response(201, json={"id": f"a{n}", "hash": f"blake3:{n}", "file_path": f"f{n}.png"})
        if path == "/api/v2/jobs" and request.method == "POST":
            self.keys.append(request.headers.get("Idempotency-Key"))
            body = json.loads(request.content)
            self.submitted.append(body["workflow"])
            if self.mode == "invalid":
                return httpx.Response(422, json={"error": {"code": "invalid_workflow", "message": "Prompt outputs failed validation", "details": {
                    "node_errors": {"1": {"class_type": "UNETLoader", "errors": [{"message": "Value not in list", "details": "unet_name: 'x' not in [...]"}]}}}}})
            return httpx.Response(201, json={"id": "j1", "status": "queued", "queue_position": 1})
        if path == "/api/v2/jobs/j1/events":
            return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                  content=b"event: progress\ndata: {\"value\": 0.5, \"nodes_done\": 3, \"nodes_total\": 6}\n\n")
        if path == "/api/v2/jobs/j1":
            self.polls += 1
            if self.polls == 1:
                return httpx.Response(200, json={"id": "j1", "status": "running"})
            if self.mode == "fail":
                return httpx.Response(200, json={"id": "j1", "status": "failed", "error": {
                    "code": "node_execution_error", "message": "CUDA out of memory", "node_id": "7", "class_type": "KSampler"}})
            outputs = [] if self.mode == "empty" else [
                {"node_id": "9", "name": "out.png", "content_type": self.ctype, "url": "/api/v2/assets/tok/content"}]
            return httpx.Response(200, json={"id": "j1", "status": "succeeded", "outputs": outputs})
        if path == "/api/v2/assets/tok/content":
            return httpx.Response(200, content=self.out, headers={"content-type": self.ctype})
        return httpx.Response(404)


@pytest.fixture
def uploads(tmp_path):
    from PIL import Image

    up = paths.uploads_dir()
    Image.new("RGB", (640, 480), (30, 60, 90)).save(up / "ref.png")
    return up


def png_bytes():
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 10, 10)).save(buf, "PNG")
    return buf.getvalue()


async def _fast_sleep(s, *a, **k):
    await _real_sleep(0)


_real_sleep = asyncio.sleep


def run_local(fake: FakeV2, monkeypatch, spec, info=None):
    transport = httpx.MockTransport(fake)
    mgr = jobs.Manager()
    mgr.v2_factory = lambda: local.ComfyV2(base="http://v2.test", token="", transport=transport)
    wf = engines.compose(spec)["template"]
    info = info if info is not None else object_info_for(wf)

    class FakeComfy:
        async def object_info(self, fresh=False):
            return info

    mgr.comfyui_factory = FakeComfy

    async def up():
        return {"ok": True}

    mgr.ensure_proxy = up
    monkeypatch.setattr(asyncio, "sleep", _fast_sleep)

    async def go():
        ids = await mgr.start(spec)
        await asyncio.gather(*mgr.tasks.values())
        return ids

    return mgr, asyncio.run(go())


def test_local_run_uploads_submits_and_saves(uploads, monkeypatch):
    fake = FakeV2(png_bytes())
    mgr, ids = run_local(fake, monkeypatch, klein_spec(2))
    job = mgr.jobs[ids[0]]
    assert job.state == "done", job.detail
    assert "in your ComfyUI" in job.detail
    assert fake.keys == [ids[0]]
    assert fake.uploads == ["a1", "a2"]
    wf = fake.submitted[0]
    assert wf["11"]["inputs"]["image"] == {"__type": "core/ASSET", "info": {"id": "a1"}}
    assert wf["12"]["inputs"]["image"] == {"__type": "core/ASSET", "info": {"id": "a2"}}
    seed = wf["7"]["inputs"]["seed"]
    assert isinstance(seed, int) and seed >= 0
    m = store.get(ids[0])
    assert m.status == "done" and m.result.kind == "image" and m.result.seed == seed
    assert m.engine.kind == "local"
    saved = json.loads((store.folder(m.id) / "comfy" / "workflow.json").read_text("utf-8"))
    assert saved["11"]["inputs"]["image"] == "ref-01.jpg" and saved["7"]["inputs"]["seed"] == seed


def test_local_video_output(uploads, monkeypatch, tmp_path):
    clip = make_video(tmp_path / "o.mp4", seconds=1).read_bytes()
    fake = FakeV2(clip, ctype="video/mp4")
    spec = {"engine": H3, "inputs": [{"slot": "image:1", "asset": "ref.png"}], "prompt": "wave", "params": {"seed": 3}}
    mgr, ids = run_local(fake, monkeypatch, spec)
    assert mgr.jobs[ids[0]].state == "done", mgr.jobs[ids[0]].detail
    m = store.get(ids[0])
    assert m.result.kind == "video" and media.read_mp4_recipe(m.result.output_file)["id"] == m.id


def test_local_precheck_blocks_submit(uploads, monkeypatch):
    fake = FakeV2(png_bytes())
    wf = engines.compose(klein_spec(1))["template"]
    info = object_info_for(wf, drop_models=("flux3-image-klein-int8-convrot.safetensors",))
    mgr, ids = run_local(fake, monkeypatch, klein_spec(1), info=info)
    job = mgr.jobs[ids[0]]
    assert job.state == "failed" and "flux3-image-klein" in job.detail
    assert job.error["error_type"] == "missing_requirements"
    assert job.error["check"]["missing_models"][0]["url"]
    assert fake.submitted == [] and fake.uploads == []


@pytest.mark.parametrize("mode,needle", [
    ("invalid", "unet_name"),
    ("fail", "ran out of memory at #7 KSampler. Try a smaller size"),
    ("empty", "saved no image or video"),
])
def test_local_failures_are_readable(uploads, monkeypatch, mode, needle):
    mgr, ids = run_local(FakeV2(png_bytes(), mode=mode), monkeypatch, klein_spec(1))
    job = mgr.jobs[ids[0]]
    assert job.state == "failed" and needle in job.detail, job.detail


# ---- which ComfyUI the proxy runs on ------------------------------------------------


@pytest.mark.parametrize("upstream,v2,comfy,want", [
    ("http://127.0.0.1:8188", "http://127.0.0.1:8189", "http://localhost:8188", True),
    ("http://127.0.0.1:8188", "http://127.0.0.1:8189", "http://127.0.0.1:8288", False),
    ("http://127.0.0.1:8188", "http://192.168.1.20:8189", "http://192.168.1.20:8188", True),  # loopback on the proxy's machine
    ("http://127.0.0.1:8188", "http://192.168.1.20:8189", "http://127.0.0.1:8188", False),
    ("http://10.0.0.5:8188", "http://127.0.0.1:8189", "http://10.0.0.5:8188/", True),
    ("http://comfyui:8188", "http://127.0.0.1:8189", "http://127.0.0.1:8188", None),  # Docker service name: can't tell
    (None, "http://127.0.0.1:8189", "http://127.0.0.1:8188", None),
])
def test_upstream_match(upstream, v2, comfy, want):
    assert local.upstream_match(upstream, v2, comfy) is want


def test_upstream_seen_from_here():
    assert local.upstream_seen_from_here("http://127.0.0.1:8188", "http://192.168.1.20:8189") == "http://192.168.1.20:8188"
    assert local.upstream_seen_from_here("http://localhost:8188", "http://127.0.0.1:8189") == "http://localhost:8188"


def _ensure_with(monkeypatch, upstream, comfy="http://127.0.0.1:8188", ours=False):
    from server import proxy, settings

    settings.save({"local_comfyui_url": comfy, "local_v2_url": "http://127.0.0.1:8189"})

    async def health(self):
        return {"status": "healthy", "upstream": upstream}

    monkeypatch.setattr(local.ComfyV2, "health", health)
    monkeypatch.setattr(proxy, "running", lambda: ours)
    stopped = []
    monkeypatch.setattr(proxy, "stop", lambda: stopped.append(True))
    monkeypatch.setattr(proxy, "available", lambda: False)  # don't spawn in tests
    return asyncio.run(proxy.ensure()), stopped


def test_ensure_accepts_matching_proxy(monkeypatch):
    r, stopped = _ensure_with(monkeypatch, "http://127.0.0.1:8188")
    assert r["ok"] and not stopped


def test_ensure_refuses_someone_elses_proxy_on_another_comfyui(monkeypatch):
    r, stopped = _ensure_with(monkeypatch, "http://127.0.0.1:8188", comfy="http://127.0.0.1:8288")
    assert not r["ok"] and r["reason"] == "upstream_mismatch" and r["upstream"] == "http://127.0.0.1:8188"
    assert not stopped


def test_ensure_restarts_its_own_proxy_when_comfyui_moved(monkeypatch):
    r, stopped = _ensure_with(monkeypatch, "http://127.0.0.1:8188", comfy="http://127.0.0.1:8288", ours=True)
    assert stopped == [True]
    assert r["reason"] == "proxy_not_installed"  # it went on to start a new one (blocked here by the test)
