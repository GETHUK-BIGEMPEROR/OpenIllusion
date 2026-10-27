"""Router templates: one adapter per model, a template frozen to the files its run used,
and a whole cloud run against a fake Router."""

import asyncio
import base64
import json

import httpx
import pytest

from server import adapters, builder, engines, jobs, media, settings, store
from server.router import Router

from conftest import make_image, make_video

VEO = "veo/veo-3.1-fast-generate-001"
SEEDANCE = "byteplus/dreamina-seedance-2-0-260128"


def _spec(model=VEO, media=(), prompt="a fox in the snow", **kw):
    return {"model": model, "label": "Fox clip", "media": [{"input": i, "kind": "image"} for i in media],
            "prompt": {"default": prompt}, **kw}


# ---- the adapters themselves -----------------------------------------------------

def test_five_models_ship_with_an_adapter():
    got = adapters.all_adapters()
    assert set(got) == {"openai/gpt-image-2", "vertexai/gemini-nano-banana-2.1", SEEDANCE, "kling/kling-v3-omni", VEO}
    assert {m: a.mode for m, a in got.items()}["openai/gpt-image-2"] == "edit" and got[VEO].mode == "motion"
    for a in got.values():
        body, _ = adapters.assemble(a, [], "x")  # prompt only: every model takes that
        assert "{{" not in json.dumps(body)


@pytest.mark.parametrize("bad,match", [
    ({"model": "nope"}, "provider/model"),
    ({"makes": "audio"}, "photo or video"),
    ({"body": {"image": "{{$|uri}}"}}, "without file tokens"),
    ({"prompt": "prompt"}, "path"),
    ({"inputs": [{"role": "A", "type": "image", "at": ["a"], "value": "https://x"}]}, "token"),
    ({"inputs": [{"role": "A", "type": "image", "at": ["a"], "value": "{{$|uri}}", "max": 3}]}, "ends in \\+"),
    ({"inputs": [{"role": "A", "type": "image", "at": ["a", "+", "b"], "value": "{{$|uri}}"}]}, "path"),
    ({"inputs": [{"role": "A", "type": "image", "at": ["a"], "value": "{{$|uri}}", "needs": "B"}]}, "needs"),
    ({"result": []}, "result"),
])
def test_a_broken_adapter_is_refused(bad, match):
    good = {"model": "acme/m", "makes": "photo", "body": {"prompt": ""}, "prompt": ["prompt"],
            "inputs": [{"role": "Photo", "type": "image", "at": ["image"], "value": "{{$|uri}}"}], "result": [["url"]]}
    with pytest.raises(adapters.AdapterError, match=match):
        adapters.parse({**good, **bad})


def test_inputs_go_where_the_adapter_says():
    seed = adapters.get(SEEDANCE)
    body, where = adapters.assemble(seed, [(0, "image:1"), (1, "image:2")], "dolly in")
    assert body["content"] == [
        {"type": "text", "text": "dolly in"},
        {"type": "image_url", "role": "first_frame", "image_url": {"url": "{{image:1|uri}}"}},
        {"type": "image_url", "role": "last_frame", "image_url": {"url": "{{image:2|uri}}"}},
    ]
    assert where == {"image:1": ["content", 1], "image:2": ["content", 2]}
    gpt, _ = adapters.assemble(adapters.get("openai/gpt-image-2"), [(0, "image:1"), (0, "image:2")], "p")
    assert gpt == {"prompt": "p", "image": ["{{image:1|uri}}", "{{image:2|uri}}"]}
    veo, _ = adapters.assemble(adapters.get(VEO), [(2, "image:1")], "p")
    assert veo["instances"][0]["referenceImages"] == [
        {"image": {"bytesBase64Encoded": "{{image:1|b64}}", "mimeType": "{{image:1|mime}}"}, "referenceType": "asset"}]


@pytest.mark.parametrize("used,match", [
    ([0, 2], "First frame or Reference, not both"),
    ([1], "needs a First frame"),
    ([2, 2, 2, 2, 2], "up to 4"),
    ([7], "no such input"),
])
def test_inputs_the_model_cant_take_together(used, match):
    with pytest.raises(adapters.AdapterError, match=match):
        adapters.assemble(adapters.get(SEEDANCE), [(i, f"image:{n + 1}") for n, i in enumerate(used)], "x")


# ---- a template from an adapter --------------------------------------------------

def test_template_is_frozen_to_the_files_its_run_used():
    data = builder.assemble_cloud(_spec(media=[0, 1]))
    assert data["body"]["instances"][0] == {
        "prompt": "a fox in the snow",
        "image": {"bytesBase64Encoded": "{{image:1|b64}}", "mimeType": "{{image:1|mime}}"},
        "lastFrame": {"bytesBase64Encoded": "{{image:2|b64}}", "mimeType": "{{image:2|mime}}"},
    }
    assert [(f["key"], f["required"], f["bind"]) for f in data["inputs"]] == [
        ("image:1", True, [["instances", 0, "image"]]), ("image:2", True, [["instances", 0, "lastFrame"]]),
        ("prompt", True, [["instances", 0, "prompt"]])]
    assert data["result"] == adapters.get(VEO).result and data["mode"] == "motion" and data["kind"] == "cloud"
    # Text only: no image fields in the request at all.
    plain = builder.assemble_cloud(_spec())
    assert plain["body"] == {"instances": [{"prompt": "a fox in the snow"}], "parameters": {"sampleCount": 1}}
    assert [f["key"] for f in plain["inputs"]] == ["prompt"]


def test_template_carries_its_own_copy_of_the_request():
    data = builder.assemble_cloud(_spec(media=[0]))
    data["body"]["instances"][0]["prompt"] = "changed"
    assert adapters.get(VEO).body["instances"][0]["prompt"] == ""


@pytest.mark.parametrize("spec,match", [
    (_spec(model="acme/edit-1"), "has no adapter"),
    (_spec(media=[1]), "needs a First frame"),
    (_spec(media=[0, 2]), "not both"),
    (_spec(prompt=""), "Write the prompt"),
    ({**_spec(), "media": [{"input": 0, "kind": "video"}]}, "no such video input"),
    ({**_spec(), "media": [{"input": "0", "kind": "image"}]}, "no such image input"),
])
def test_assemble_refuses_what_the_model_cant_take(spec, match):
    with pytest.raises(builder.BuildError, match=match):
        builder.assemble_cloud(spec)


def test_builder_lists_only_adapter_models():
    from test_crud import call

    async def go(c):
        r = await c.get("/api/builder/models")
        return await r.json()

    got = call(go)
    assert [m["model"] for m in got] == sorted(m["model"] for m in got) and len(got) == 5
    seed = next(m for m in got if m["model"] == SEEDANCE)
    assert seed["mode"] == "motion" and [i["role"] for i in seed["inputs"]] == ["First frame", "Last frame", "Reference"]
    assert seed["inputs"][1] == {"role": "Last frame", "type": "image", "max": 1, "set": "frames", "needs": "First frame"}


# ---- running one -------------------------------------------------------------------

def test_file_resolver_forms(tmp_path):
    make_image(tmp_path / "a.png", (64, 48))
    (tmp_path / "v.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    r = engines.file_resolver([{"slot": "image:1", "file": "a.png"}, {"slot": "video:1", "file": "v.mp4"}], tmp_path)
    uri = r("image", 1, "uri")
    assert uri.startswith("data:image/") and r("image", 1, "b64") == uri.split(",", 1)[1]
    assert r("image", 1, "mime") == uri[5:].split(";", 1)[0]
    assert r("video", 1, "mime") == "video/mp4"
    assert base64.b64decode(r("video", 1, "b64")).startswith(b"\x00\x00\x00\x18ftyp")
    with pytest.raises(KeyError):
        r("image", 1, "url")


PNG = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 300).decode()


def test_result_media_follows_the_template_paths():
    veo = {"response": {"videos": [{"bytesBase64Encoded": PNG}]}}
    kind, value, at = engines.result_media(veo, [["response", "videos", "*", "gcsUri"], ["response", "videos", "*", "bytesBase64Encoded"]])
    assert kind == "b64" and value == PNG and at == ["response", "videos", 0, "bytesBase64Encoded"]
    gem = {"candidates": [{"content": {"parts": [{"text": "here"}, {"inlineData": {"data": PNG, "mimeType": "image/png"}}]}}]}
    assert engines.result_media(gem, adapters.get("vertexai/gemini-nano-banana-2.1").result)[:2] == ("b64", PNG)
    assert engines.result_media({"x": 1}, [["result", "sample"]]) is None
    # A path that misses (an adapter written from the docs): any link, then any long base64.
    assert engines.result_media({"content": {"url": "https://cdn.test/o.mp4"}}, [["content", "video_url"]])[:2] == ("url", "https://cdn.test/o.mp4")
    assert engines.result_media({"a": {"b": [PNG]}}, [])[:2] == ("b64", PNG)
    data, ctype = engines.decode_media(PNG)
    assert ctype == "image/png" and data.startswith(b"\x89PNG")
    assert engines.slim(veo)["response"]["videos"][0]["bytesBase64Encoded"].startswith("<base64, ")


@pytest.mark.parametrize("result,kind", [
    ({"status": "Request Moderated"}, "content_policy_violation"),
    ({"status": "Error", "details": "bad"}, "provider_failed"),
    ({"data": {"task_status": "failed", "task_status_msg": "nope"}}, "provider_failed"),
    ({"data": {"error": {"message": "nope"}}}, "provider_failed"),
])
def test_provider_failures_inside_a_200(result, kind):
    assert engines.classify_failure(result)["error_type"] == kind


def test_built_template_runs_on_router(tmp_path, monkeypatch):
    """Veo with a first frame: the photo goes in as base64 beside its MIME type, and the
    video comes back inline as base64, where the adapter says."""
    clip = make_video(tmp_path / "out.mp4", seconds=1).read_bytes()
    make_image(tmp_path / "frame.png", (640, 360))
    sent = {}

    def fake(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path.endswith("/estimate"):
            return httpx.Response(200, json={"source": "unknown"})
        if request.method == "POST" and path.endswith("/requests"):
            sent["path"], sent["body"] = path, json.loads(request.content)
            return httpx.Response(201, json={"request_id": "r1", "status": "IN_QUEUE"})
        if path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        if request.method == "GET" and path.endswith("/requests/r1"):
            return httpx.Response(200, json={"response": {"videos": [{"bytesBase64Encoded": base64.b64encode(clip).decode()}]}})
        return httpx.Response(404)

    tid = builder.save(builder.assemble_cloud(_spec(media=[0])), {"image:1": tmp_path / "frame.png"})
    engines.reload_templates()
    e = engines.ENGINES[tid]
    assert e.result == adapters.get(VEO).result and e.min_images == 1
    settings.save({"api_key": "comfyui-test-key-1234"})
    mgr = jobs.Manager()
    mgr.router_factory = lambda: Router(transport=httpx.MockTransport(fake))
    real = asyncio.sleep

    async def fast(*a, **k):
        await real(0)

    monkeypatch.setattr(asyncio, "sleep", fast)
    from PIL import Image

    Image.new("RGB", (640, 360), (200, 120, 40)).save(jobs.paths.uploads_dir() / "frame.png")

    async def go():
        ids = await mgr.start({"engine": tid, "inputs": [{"slot": "image:1", "asset": "frame.png"}], "prompt": "a fox in the snow", "params": {}})
        await asyncio.gather(*mgr.tasks.values())
        return ids

    ids = asyncio.run(go())
    job = mgr.jobs[ids[0]]
    assert job.state == "done", job.detail
    assert VEO in sent["path"]
    inst = sent["body"]["instances"][0]
    assert inst["prompt"] == "a fox in the snow" and inst["image"]["mimeType"] == "image/jpeg"
    assert base64.b64decode(inst["image"]["bytesBase64Encoded"])[:3] == b"\xff\xd8\xff"
    m = store.get(ids[0])
    assert m.result.kind == "video" and media.read_mp4_recipe(m.result.output_file)["id"] == m.id


def test_an_unknown_engine_doesnt_run():
    with pytest.raises(KeyError, match="No template"):
        engines.get("acme/any-router-model")
