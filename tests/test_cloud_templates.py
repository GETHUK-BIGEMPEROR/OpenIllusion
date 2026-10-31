"""Router templates: one adapter per model, a template frozen to the files its run used,
and a whole cloud run against a fake Router."""

import asyncio
import base64
import json

import httpx
import pytest

from server import generation as sc
from server import adapters, builder, engines, jobs, local, media, settings, store
from server.router import Router

from conftest import make_image, make_video

VEO = "veo/veo-3.1-fast-generate-001"
SEEDANCE = "byteplus/dreamina-seedance-2-5-260628"
KLING = "kling/kling-v3-omni"
FAMILY = "acme/family"  # the conftest fixture's adapter
SHIPPED = {"openai/gpt-image-2", "vertexai/gemini-nano-banana-2.1", "byteplus/seedream-5-0-pro-260628", "bfl/flux-2-max",
       "xai/grok-imagine-image-2.0", SEEDANCE, KLING, VEO, "wan/wan3.0-video"}


def _spec(model=VEO, media=(), prompt="a fox in the snow", **kw):
    """``media``: adapter-input indexes (images) or (index, kind) pairs."""
    rows = [{"input": i, "kind": "image"} if isinstance(i, int) else {"input": i[0], "kind": i[1]} for i in media]
    return {"model": model, "label": "Fox clip", "media": rows, "prompt": {"default": prompt}, **kw}


def _roles(a, *roles):
    """(input index, slot) rows for these roles, slots numbered per kind as the Builder does."""
    out, n = [], {}
    for r in roles:
        i = next(k for k, x in enumerate(a.inputs) if x["role"] == r)
        kind = a.inputs[i]["type"]
        n[kind] = n.get(kind, 0) + 1
        out.append((i, f"{kind}:{n[kind]}"))
    return out


def _run(model, *roles, prompt="p"):
    a = adapters.get(model)
    return adapters.assemble(a, _roles(a, *roles), prompt)


# ---- the adapters themselves -----------------------------------------------------

def test_nine_models_ship_with_an_adapter():
    got = adapters.all_adapters()
    assert set(got) == SHIPPED
    assert got["openai/gpt-image-2"].mode == "edit" and got[VEO].mode == "motion"
    for a in got.values():
        body, where, _ = adapters.assemble(a, [], "x")  # prompt only: every model takes that
        assert "{{" not in json.dumps(body) and where == {}


GOOD = {"model": "acme/m", "makes": "photo", "body": {"prompt": ""}, "prompt": ["prompt"],
        "inputs": [{"role": "Photo", "type": "image", "at": ["image"], "value": "{{$|uri}}"}], "result": [["url"]]}


def _inp(**kw):
    return {"inputs": [{**GOOD["inputs"][0], **kw}]}


@pytest.mark.parametrize("bad,match", [
    ({"model": "nope"}, "provider/model"),
    ({"makes": "audio"}, "photo or video"),
    ({"body": {"image": "{{$|uri}}"}}, "without file tokens"),
    ({"prompt": "prompt"}, "path"),
    (_inp(value="https://x"), "token"),
    (_inp(value="{{$|uri}} and more"), "alone in a string"),
    (_inp(type="text"), "image, video or audio"),
    (_inp(max=3), "ends in \\+"),
    (_inp(at=["a", "+", "b"]), "path"),
    (_inp(needs="B"), "needs"),
    (_inp(set=[]), "set is a name"),
    (_inp(**{"with": [["task", "extend"]]}), "with lists"),
    (_inp(**{"with": [[["image2"], "{{$|uri}}"]]}), "not file tokens"),
    (_inp(drop=["duration"]), "drop lists paths"),
    (_inp(at=[["a"], ["b"]], max=3), "number of paths"),
    (_inp(at=["a", "+"], max=4, max_with={"roles": ["Photo"], "max": 2}), "max_with"),
    (_inp(at=["a", "+"], max=4, max_with={"roles": ["Nope"], "max": 2}), "max_with"),
    (_inp(at=["a", "+"], max=4, max_with={"roles": [], "max": 2}), "max_with"),
    ({"models": [{"model": "acme/m-i2v", "takes": ["Nope"]}]}, "models lists"),
    ({"inputs": [GOOD["inputs"][0], GOOD["inputs"][0]]}, "its own role"),
    ({"result": []}, "result"),
])
def test_a_broken_adapter_is_refused(bad, match):
    with pytest.raises(adapters.AdapterError, match=match):
        adapters.parse({**GOOD, **bad})


def test_inputs_go_where_the_adapter_says():
    body, where, model = _run(SEEDANCE, "First frame", "Last frame", prompt="dolly in")
    assert body["content"] == [
        {"type": "text", "text": "dolly in"},
        {"type": "image_url", "role": "first_frame", "image_url": {"url": "{{image:1|uri}}"}},
        {"type": "image_url", "role": "last_frame", "image_url": {"url": "{{image:2|uri}}"}},
    ]
    assert where == {"image:1": ["content", 1], "image:2": ["content", 2]} and model == SEEDANCE
    gpt = adapters.assemble(adapters.get("openai/gpt-image-2"), [(0, "image:1"), (0, "image:2")], "p")[0]
    assert gpt == {"prompt": "p", "size": "auto", "quality": "auto", "image": ["{{image:1|uri}}", "{{image:2|uri}}"]}
    veo = _run(VEO, "Reference image", "Reference image")[0]
    assert [r["referenceType"] for r in veo["instances"][0]["referenceImages"]] == ["asset", "asset"]
    assert veo["instances"][0]["referenceImages"][0]["image"] == {"bytesBase64Encoded": "{{image:1|b64}}", "mimeType": "{{image:1|mime}}"}


def test_one_path_per_file():
    """FLUX names each reference its own field: input_image, input_image_2, ..."""
    flux = adapters.get("bfl/flux-2-max")
    body, where, _ = adapters.assemble(flux, [(0, "image:1"), (0, "image:2"), (0, "image:3")], "p")
    assert body == {"prompt": "p", "output_format": "jpeg",  # the photos set the size
                    "input_image": "{{image:1|b64}}", "input_image_2": "{{image:2|b64}}", "input_image_3": "{{image:3|b64}}"}
    assert where["image:3"] == ["input_image_3"] and flux.inputs[0]["max"] == 9
    with pytest.raises(adapters.AdapterError, match="up to 9"):
        adapters.assemble(flux, [(0, f"image:{n}") for n in range(1, 11)], "p")


def test_an_edit_reshapes_the_request():
    """Mode is the inputs filled, and some of them change the settings around them."""
    kling = _run(KLING, "Video to edit", "Reference image")[0]
    assert kling["video_list"] == [{"video_url": "{{video:1|url}}", "refer_type": "base", "keep_original_sound": "yes"}]
    assert kling["image_list"] == [{"image_url": "{{image:1|b64}}"}]
    assert "duration" not in kling and "aspect_ratio" not in kling and kling["mode"] == "pro"
    feature = _run(KLING, "Reference video")[0]
    assert feature["video_list"][0]["refer_type"] == "feature" and feature["duration"] == "5"
    frames = _run(KLING, "First frame", "Last frame")[0]
    assert [x["type"] for x in frames["image_list"]] == ["first_frame", "end_frame"] and "aspect_ratio" not in frames
    seed = _run(SEEDANCE, "Video to edit", "Reference audio")[0]
    assert seed["duration"] == -1 and [c.get("role") for c in seed["content"]] == [None, "reference_video", "reference_audio"]
    assert _run(SEEDANCE, "Reference video")[0]["duration"] == 5
    veo = _run(VEO, "Video to extend")[0]
    assert veo["parameters"] == {"sampleCount": 1, "task": "extend"}
    assert veo["instances"][0]["video"] == {"bytesBase64Encoded": "{{video:1|b64}}", "mimeType": "{{video:1|mime}}"}
    assert "task" not in _run(VEO, "First frame")[0]["parameters"]


@pytest.mark.parametrize("roles,model", [
    ((), "acme/family-t2v"),
    (("First frame",), "acme/family-i2v"),
    (("Reference image", "Reference image"), "acme/family-r2v"),
    (("Video to edit",), "acme/family-edit"),
    (("Video to edit", "Reference image"), "acme/family-edit"),
])
def test_a_family_picks_its_model_from_the_inputs(roles, model, family):
    body, _, got = _run(FAMILY, *roles)
    assert got == model
    assert ("duration" in body["parameters"]) == ("Video to edit" not in roles)


@pytest.mark.parametrize("model,roles,match", [
    (SEEDANCE, ("First frame", "Reference image"), "First frame or Reference image, not both"),
    (SEEDANCE, ("Last frame",), "needs a First frame"),
    (SEEDANCE, ("Video to edit", "Reference video"), "not both"),
    (SEEDANCE, ("Reference image",) * 31, "up to 30"),
    (KLING, ("Reference image",) * 5 + ("Reference video",), "up to 4 × Reference image with a Reference video"),
    (KLING, ("Reference image",) * 8, "up to 7"),
    (FAMILY, ("Video to edit",) + ("Reference image",) * 6, "up to 5 × Reference image with a Video to edit"),
    (KLING, ("Video to edit", "Reference video"), "not both"),
    (KLING, ("First frame", "Video to edit"), "not both"),
    (VEO, ("Style image", "Reference image"), "not both"),
    (VEO, ("Video to extend", "First frame"), "not both"),
    (FAMILY, ("First frame", "Reference image"), "can't take First frame and Reference image together"),
    (FAMILY, ("First frame", "Video to edit"), "together"),
])
def test_inputs_the_model_cant_take_together(model, roles, match, family):
    with pytest.raises(adapters.AdapterError, match=match):
        _run(model, *roles)


def test_inputs_that_share_a_set_go_together(family):
    _run(KLING, "Reference image", "Reference video")
    _run(KLING, "Reference image", "Video to edit")
    _run(SEEDANCE, "Reference image", "Reference video", "Reference audio")
    _run("wan/wan3.0-video", "Reference image", "Reference video", "Reference audio")
    # Each model's own limit, not a lower one: Kling takes 7 images alone, 4 beside a video.
    _run(KLING, *("Reference image",) * 7)
    _run(KLING, *("Reference image",) * 4, "Reference video")
    _run(FAMILY, *("Reference image",) * 9)
    _run(SEEDANCE, *("Reference image",) * 30, *("Reference video",) * 10, *("Reference audio",) * 10)
    with pytest.raises(adapters.AdapterError, match="no such input"):
        adapters.assemble(adapters.get(SEEDANCE), [(7, "image:1")], "x")


# ---- a template from an adapter --------------------------------------------------

def test_template_is_frozen_to_the_files_its_run_used():
    data = builder.assemble_cloud(_spec(media=[0, 1]))
    assert data["body"]["instances"][0] == {
        "prompt": "a fox in the snow",
        "image": {"bytesBase64Encoded": "{{image:1|b64}}", "mimeType": "{{image:1|mime}}"},
        "lastFrame": {"bytesBase64Encoded": "{{image:2|b64}}", "mimeType": "{{image:2|mime}}"},
    }
    assert [(f["key"], f.get("required"), f["bind"]) for f in data["inputs"]] == [
        ("image:1", True, [["instances", 0, "image"]]), ("image:2", True, [["instances", 0, "lastFrame"]]),
        ("prompt", True, [["instances", 0, "prompt"]]),
        # The model's settings, at its defaults, after the prompt
        ("aspect", None, [["parameters", "aspectRatio"]]), ("resolution", None, [["parameters", "resolution"]]),
        ("duration", None, [["parameters", "durationSeconds"]]), ("sound", None, [["parameters", "generateAudio"]])]
    assert data["result"] == adapters.get(VEO).result and data["mode"] == "motion" and data["kind"] == "cloud"
    # Text only: no image fields in the request at all.
    plain = builder.assemble_cloud(_spec())
    assert plain["body"] == {"instances": [{"prompt": "a fox in the snow"}], "parameters": {
        "sampleCount": 1, "aspectRatio": "16:9", "resolution": "720p", "durationSeconds": 8, "generateAudio": True}}
    assert [f["key"] for f in plain["inputs"]] == ["prompt", "aspect", "resolution", "duration", "sound"]


def test_template_goes_to_the_model_its_inputs_picked(family):
    data = builder.assemble_cloud(_spec(model=FAMILY, media=[(2, "video"), 1]))
    assert data["model"] == "acme/family-edit" and data["provider"] == "acme"
    assert data["body"]["input"]["media"] == [{"type": "video", "url": "{{video:1|url}}"},
                                              {"type": "reference_image", "url": "{{image:1|uri}}"}]
    assert [f["key"] for f in data["inputs"]] == ["video:1", "image:1", "prompt", "resolution"]  # the clip sets the length
    talk = builder.assemble_cloud(_spec(model=SEEDANCE, media=[2, (4, "audio")]))
    assert talk["body"]["content"][2]["audio_url"] == {"url": "{{audio:1|uri}}"}


def test_template_carries_its_own_copy_of_the_request():
    data = builder.assemble_cloud(_spec(media=[0]))
    data["body"]["instances"][0]["prompt"] = "changed"
    assert adapters.get(VEO).body["instances"][0]["prompt"] == ""


def test_every_shipped_cloud_template_reopens_with_the_roles_it_was_built_for():
    """Build from this must use the request's discriminators, not the first equal token.

    Seedance deliberately represents Reference video and Video to edit with the same
    content item; ``duration=-1`` is what distinguishes the edit job.
    """
    for e in [x for x in engines.ENGINES.values() if x.kind == "cloud" and x.origin == "shipped"]:
        a = adapters.for_model(e.model)
        preset = builder.cloud_preset(e)
        got = [a.inputs[m["input"]]["role"] for m in preset["media"]]
        want = [engines.fit.role(e, f["key"]) for f in e.fields if f["type"] in engines.MEDIA]
        assert got == want, e.id


@pytest.mark.parametrize("spec,match", [
    (_spec(model="acme/edit-1"), "has no adapter"),
    (_spec(media=[1]), "needs a First frame"),
    (_spec(media=[0, 2]), "not both"),
    (_spec(prompt=""), "Write the prompt"),
    ({**_spec(), "media": [{"input": 0, "kind": "video"}]}, "no such video input"),
    ({**_spec(), "media": [{"input": "0", "kind": "image"}]}, "no such image input"),
    (_spec(model=FAMILY, media=[0, 1]), "together"),
])
def test_assemble_refuses_what_the_model_cant_take(spec, match, family):
    with pytest.raises(builder.BuildError, match=match):
        builder.assemble_cloud(spec)


def test_builder_lists_only_adapter_models():
    from test_crud import call

    async def go(c):
        r = await c.get("/api/builder/models")
        return await r.json()

    got = call(go)
    assert [m["model"] for m in got] == sorted(m["model"] for m in got) and {m["model"] for m in got} == SHIPPED
    seed = next(m for m in got if m["model"] == SEEDANCE)
    assert seed["mode"] == "motion" and [i["role"] for i in seed["inputs"]] == [
        "First frame", "Last frame", "Reference image", "Reference video", "Reference audio", "Video to edit"]
    assert seed["inputs"][1] == {"role": "Last frame", "type": "image", "max": 1, "set": ["frames"], "needs": "First frame",
                                 "fit": {"short": [300.0, None], "long": [None, 6000.0], "aspect": [0.4, 2.5], "mb": 30.0}}
    assert seed["inputs"][2]["set"] == ["references", "edit"] and seed["inputs"][4]["type"] == "audio"
    assert all("models" not in m for m in got)  # one model id each


def test_a_family_shows_its_model_ids(family):
    d = adapters.describe(adapters.get(FAMILY))
    assert d["models"][0] == {"model": "acme/family-t2v", "takes": []} and "set" not in d["inputs"][0]


# ---- running one -------------------------------------------------------------------

def test_file_resolver_forms(tmp_path):
    make_image(tmp_path / "a.png", (64, 48))
    (tmp_path / "v.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
    (tmp_path / "voice.wav").write_bytes(b"RIFF" + b"\x00" * 64)
    r = engines.file_resolver([{"slot": "image:1", "file": "a.png"}, {"slot": "video:1", "file": "v.mp4"},
                               {"slot": "audio:1", "file": "voice.wav"}, {"slot": "video:2", "file": "v.mp4", "url": "https://signed.test/v"}],
                              tmp_path)
    uri = r("image", 1, "uri")
    assert uri.startswith("data:image/") and r("image", 1, "b64") == uri.split(",", 1)[1]
    assert r("image", 1, "mime") == uri[5:].split(";", 1)[0]
    assert r("video", 1, "mime") == "video/mp4"
    assert base64.b64decode(r("video", 1, "b64")).startswith(b"\x00\x00\x00\x18ftyp")
    assert r("audio", 1, "mime") in ("audio/wav", "audio/x-wav") and r("audio", 1, "uri").startswith("data:audio/")
    assert r("video", 2, "url") == "https://signed.test/v"
    with pytest.raises(KeyError, match="wasn't uploaded"):
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


def _fast(monkeypatch):
    real = asyncio.sleep

    async def fast(*a, **k):
        await real(0)

    monkeypatch.setattr(asyncio, "sleep", fast)


def _router(sent, answer, files=None):
    """A fake Router: takes one request, answers ``answer``; ``files`` are links it serves."""
    def fake(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if str(request.url) in (files or {}):
            return httpx.Response(200, content=files[str(request.url)], headers={"content-type": "video/mp4"})
        if request.method == "POST" and path.endswith("/requests"):
            sent["path"], sent["body"] = path, json.loads(request.content)
            return httpx.Response(201, json={"request_id": "r1", "status": "IN_QUEUE"})
        if path.endswith("/status"):
            return httpx.Response(200, json={"status": "COMPLETED"})
        if request.method == "GET" and path.endswith("/requests/r1"):
            return httpx.Response(200, json=answer)
        return httpx.Response(404)
    return fake


def _start(mgr, tid, inputs, prompt="a fox in the snow"):
    async def go():
        ids = await mgr.start({"engine": tid, "inputs": inputs, "prompt": prompt, "params": {}})
        await asyncio.gather(*mgr.tasks.values())
        return ids

    return mgr.jobs[asyncio.run(go())[0]]


def test_built_template_runs_on_router(tmp_path, monkeypatch):
    """Veo with a first frame: the photo goes in as base64 beside its MIME type, and the
    video comes back inline as base64, where the adapter says."""
    clip = make_video(tmp_path / "out.mp4", seconds=1).read_bytes()
    make_image(tmp_path / "frame.png", (640, 360))
    sent = {}
    tid = builder.save(builder.assemble_cloud(_spec(media=[0])), {"image:1": tmp_path / "frame.png"})
    engines.reload_templates()
    e = engines.ENGINES[tid]
    assert e.result == adapters.get(VEO).result and e.min_images == 1
    settings.save({"api_key": "comfyui-test-key-1234"})
    mgr = jobs.Manager()
    mgr.router_factory = lambda: Router(transport=httpx.MockTransport(
        _router(sent, {"response": {"videos": [{"bytesBase64Encoded": base64.b64encode(clip).decode()}]}})))
    _fast(monkeypatch)
    from PIL import Image

    Image.new("RGB", (640, 360), (200, 120, 40)).save(jobs.paths.uploads_dir() / "frame.png")
    job = _start(mgr, tid, [{"slot": "image:1", "asset": "frame.png"}])
    assert job.state == "done", job.detail
    assert VEO in sent["path"]
    inst = sent["body"]["instances"][0]
    assert inst["prompt"] == "a fox in the snow" and inst["image"]["mimeType"] == "image/jpeg"
    assert base64.b64decode(inst["image"]["bytesBase64Encoded"])[:3] == b"\xff\xd8\xff"
    m = store.get(job.id)
    assert m.result.kind == "video" and media.read_mp4_recipe(m.result.output_file)["id"] == sc.share_id(m.id)


def _cloud(seen, status=201):
    """A fake Comfy Cloud asset store: an upload, then its content redirects to a signed link."""
    def fake(request: httpx.Request) -> httpx.Response:
        seen.append((request.method, request.url.path, request.headers.get("authorization")))
        if request.method == "POST" and request.url.path == "/api/v2/assets":
            if status >= 400:
                return httpx.Response(status, json={"error": {"code": "unauthorized", "message": "bad key"}})
            assert b"video/mp4" in request.content and b'name="file"' in request.content
            return httpx.Response(status, json={"id": "a1", "name": "clip.mp4"})
        if request.url.path == "/api/v2/assets/a1/content":
            return httpx.Response(302, headers={"Location": "https://signed.test/a1.mp4?sig=x"})
        return httpx.Response(404)
    return fake


def _kling_edit(tmp_path, monkeypatch, cloud_status=201):
    make_video(tmp_path / "clip.mp4", seconds=4)  # Kling takes 3 to 10 s
    out = make_video(tmp_path / "out.mp4", seconds=1).read_bytes()
    tid = builder.save(builder.assemble_cloud(_spec(model=KLING, media=[(4, "video")], prompt="make it snow")), {})
    engines.reload_templates()
    settings.save({"api_key": "comfyui-test-key-1234"})
    sent, seen = {}, []
    mgr = jobs.Manager()
    answer = {"data": {"task_status": "succeed", "task_result": {"videos": [{"url": "https://cdn.test/o.mp4"}]}}}
    mgr.router_factory = lambda: Router(transport=httpx.MockTransport(_router(sent, answer, {"https://cdn.test/o.mp4": out})))
    mgr.assets_factory = lambda: local.ComfyV2(base="https://cloud.test", token=settings.api_key(),
                                               transport=httpx.MockTransport(_cloud(seen, cloud_status)))
    _fast(monkeypatch)
    (jobs.paths.uploads_dir() / "clip.mp4").write_bytes((tmp_path / "clip.mp4").read_bytes())
    return _start(mgr, tid, [{"slot": "video:1", "asset": "clip.mp4"}], "make it snow"), sent, seen


def test_a_file_the_model_takes_as_a_link_goes_up_to_comfy_cloud_first(tmp_path, monkeypatch):
    job, sent, seen = _kling_edit(tmp_path, monkeypatch)
    assert job.state == "done", job.detail
    assert [s[:2] for s in seen] == [("POST", "/api/v2/assets"), ("GET", "/api/v2/assets/a1/content")]
    assert all(s[2] == "Bearer comfyui-test-key-1234" for s in seen)
    assert KLING in sent["path"]
    assert sent["body"]["video_list"] == [{"video_url": "https://signed.test/a1.mp4?sig=x", "refer_type": "base", "keep_original_sound": "yes"}]
    assert "duration" not in sent["body"] and sent["body"]["prompt"] == "make it snow"
    # The signed link runs out: it isn't kept with the generation.
    assert "signed.test" not in store.get(job.id).model_dump_json()


def test_a_refused_upload_stops_the_run(tmp_path, monkeypatch):
    job, sent, seen = _kling_edit(tmp_path, monkeypatch, cloud_status=401)
    assert job.state == "failed" and "refused the API key" in job.detail and "video:1" in job.detail
    assert sent == {} and len(seen) == 1


def test_an_audio_input_goes_in_with_the_run(tmp_path, monkeypatch):
    out = make_video(tmp_path / "out.mp4", seconds=1).read_bytes()
    tid = builder.save(builder.assemble_cloud(_spec(model=SEEDANCE, media=[2, (4, "audio")], prompt="she sings")), {})
    engines.reload_templates()
    settings.save({"api_key": "comfyui-test-key-1234"})
    sent = {}
    mgr = jobs.Manager()
    mgr.router_factory = lambda: Router(transport=httpx.MockTransport(
        _router(sent, {"content": {"video_url": "https://cdn.test/o.mp4"}}, {"https://cdn.test/o.mp4": out})))
    _fast(monkeypatch)
    from PIL import Image

    Image.new("RGB", (640, 360), (20, 120, 200)).save(jobs.paths.uploads_dir() / "face.png")
    import wave
    with wave.open(str(jobs.paths.uploads_dir() / "voice.wav"), "wb") as w:  # 3 s: Seedance takes 2 to 30
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(8000), w.writeframes(b"\x00\x10" * 24000)
    job = _start(mgr, tid, [{"slot": "image:1", "asset": "face.png"}, {"slot": "audio:1", "asset": "voice.wav"}], "she sings")
    assert job.state == "done", job.detail
    content = sent["body"]["content"]
    assert content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,")
    audio = content[2]["audio_url"]["url"]
    assert audio.startswith("data:audio/mpeg;base64,") and base64.b64decode(audio.split(",", 1)[1]).startswith(b"ID3")
    m = store.get(job.id)
    assert any(i.slot == "audio:1" and i.file and i.file.endswith(".mp3") for i in m.inputs)


def test_a_sound_uploads_and_ships_as_a_sample(tmp_path):
    """Audio goes up like a photo or a clip, and a template can carry one as its sample."""
    import aiohttp
    from test_crud import call

    wav = tmp_path / "voice.wav"
    import wave
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(8000), w.writeframes(b"\x00\x00" * 8000)

    async def go(c):
        fd = aiohttp.FormData()
        fd.add_field("file", wav.read_bytes(), filename="voice.wav", content_type="audio/wav")
        return await (await c.post("/api/upload", data=fd)).json()

    got = call(go)
    assert got["kind"] == "audio" and got["asset"].endswith(".wav") and abs(got["duration"] - 1.0) < 0.1
    make_image(tmp_path / "face.png", (64, 64))
    tid = builder.save(builder.assemble_cloud(_spec(model=SEEDANCE, media=[2, (4, "audio")])),
                       {"image:1": tmp_path / "face.png", "audio:1": wav})
    engines.reload_templates()
    d = {i["slot"]: i for i in engines.defaults_info(engines.ENGINES[tid])["inputs"]}
    assert d["audio:1"]["kind"] == "audio" and abs(d["audio:1"]["duration"] - 1.0) < 0.1 and d["image:1"]["kind"] == "image"


def test_an_unknown_engine_doesnt_run():
    with pytest.raises(KeyError, match="No template"):
        engines.get("acme/any-router-model")


# ---- keeping the edited clip's own sound -------------------------------------------

def _with_sound(path, seconds=4.0, size=(854, 480)):
    """A clip with a tone on it."""
    from fractions import Fraction

    import av
    import numpy as np

    silent = make_video(path.with_name(path.stem + "-silent.mp4"), seconds=seconds, size=size)
    with av.open(str(silent)) as inp, av.open(str(path), "w", format="mp4") as out:
        vin = inp.streams.video[0]
        vout = out.add_stream_from_template(vin)
        a = out.add_stream("aac", rate=48000)
        for pkt in inp.demux(vin):
            if pkt.dts is not None:
                pkt.stream = vout
                out.mux(pkt)
        t = np.arange(int(seconds * 48000)) / 48000
        tone = (np.sin(2 * np.pi * 440 * t) * 0.3).astype(np.float32)
        for k in range(0, len(tone), 1024):
            f = av.AudioFrame.from_ndarray(np.stack([tone[k:k + 1024]] * 2), format="fltp", layout="stereo")
            f.sample_rate, f.pts, f.time_base = 48000, k, Fraction(1, 48000)
            for p in a.encode(f):
                out.mux(p)
        for p in a.encode():
            out.mux(p)
    return path


def test_keep_the_clips_sound_is_offered_only_with_a_clip_to_edit():
    a = adapters.get(SEEDANCE)
    sound = lambda *roles: next(s for s in adapters.settings_for(a, list(roles)) if s["key"] == "sound")
    assert sound("First frame")["options"] == ["new", "none"] and "keep_sound" not in sound("First frame")
    assert sound("Video to edit")["options"] == ["new", "clip", "none"]
    # What the model is sent: its own sound for "new", none for the other two.
    for v, sent in (("new", True), ("clip", False), ("none", False)):
        assert adapters.assemble(a, _roles(a, "Video to edit"), "p", {"sound": v})[0]["generate_audio"] is sent
    with pytest.raises(adapters.AdapterError, match="Sound can't be 'clip'"):
        adapters.assemble(a, _roles(a, "First frame"), "p", {"sound": "clip"})


def test_a_template_names_the_clip_whose_sound_it_keeps():
    data = builder.assemble_cloud(_spec(model=SEEDANCE, media=[(5, "video")], prompt="make it snow"))
    f = next(f for f in data["inputs"] if f["key"] == "sound")
    assert f["keep_sound"] == {"option": "clip", "slot": "video:1"} and f["default"] == "new"
    e = engines.load_template({**data, "format": "openillusion.template", "id": "keep"})
    assert engines.sound_from(e, {}) is None and engines.sound_from(e, {"sound": "clip"}) == "video:1"
    assert engines.build_cloud(e, {"inputs": [{"slot": "video:1"}], "prompt": "x", "params": {"sound": "clip"}})["generate_audio"] is False
    # Fixed at "Keep the clip's": no input, and every run keeps it.
    fixed = builder.assemble_cloud(_spec(model=SEEDANCE, media=[(5, "video")], settings=[{"key": "sound", "value": "clip", "locked": True}]))
    assert fixed["keep_sound"] == "video:1" and not any(f["key"] == "sound" for f in fixed["inputs"])
    assert fixed["body"]["generate_audio"] is False
    assert engines.sound_from(engines.load_template({**fixed, "format": "openillusion.template", "id": "k2"}), {}) == "video:1"
    with pytest.raises(ValueError, match="keep_sound"):
        engines.load_template({**fixed, "format": "openillusion.template", "id": "k3", "keep_sound": "video:2"})


@pytest.mark.parametrize("pick,keeps", [("clip", True), ("new", False)])
def test_the_result_keeps_the_clips_own_sound(tmp_path, monkeypatch, pick, keeps):
    clip = _with_sound(tmp_path / "clip.mp4")
    out = make_video(tmp_path / "out.mp4", seconds=3).read_bytes()  # the model's answer, silent
    tid = builder.save(builder.assemble_cloud(_spec(model=SEEDANCE, media=[(5, "video")], prompt="make it snow")), {})
    engines.reload_templates()
    settings.save({"api_key": "comfyui-test-key-1234"})
    sent, seen = {}, []
    mgr = jobs.Manager()
    mgr.router_factory = lambda: Router(transport=httpx.MockTransport(
        _router(sent, {"content": {"video_url": "https://cdn.test/o.mp4"}}, {"https://cdn.test/o.mp4": out})))
    mgr.assets_factory = lambda: local.ComfyV2(base="https://cloud.test", token=settings.api_key(),
                                               transport=httpx.MockTransport(_cloud(seen)))
    _fast(monkeypatch)
    (jobs.paths.uploads_dir() / "clip.mp4").write_bytes(clip.read_bytes())

    async def go():
        ids = await mgr.start({"engine": tid, "inputs": [{"slot": "video:1", "asset": "clip.mp4"}], "prompt": "make it snow",
                               "params": {"sound": pick}})
        await asyncio.gather(*mgr.tasks.values())
        return ids

    job = mgr.jobs[asyncio.run(go())[0]]
    assert job.state == "done", job.detail
    assert sent["body"]["generate_audio"] is (pick == "new")
    m = store.get(job.id)
    got = media.probe(m.result.output_file)
    assert got["has_audio"] is keeps and abs(got["duration"] - 3.0) < 0.15  # cut to the result's length
    assert media.read_mp4_recipe(m.result.output_file)["id"] == sc.share_id(m.id)


def test_a_silent_clip_has_no_sound_to_keep(tmp_path):
    v = make_video(tmp_path / "v.mp4", seconds=1)
    before = v.read_bytes()
    assert media.put_sound(v, make_video(tmp_path / "s.mp4", seconds=1)) is False and v.read_bytes() == before


def _engine(data):
    return engines.load_template({"format": "openillusion.template", "id": "fox", **data})


def test_a_clip_is_compared_with_the_result_only_when_the_result_is_made_over_it():
    # Seedance's Reference video and Video to edit put the clip in the same place; the edit is the one whose
    # `with` (duration -1) the request carries, and it takes its own limits.
    edit = _engine(builder.assemble_cloud(_spec(model=SEEDANCE, media=[(5, "video"), 2])))
    ref = _engine(builder.assemble_cloud(_spec(model=SEEDANCE, media=[(3, "video"), 2])))
    assert engines.fit.role(edit, "video:1") == "Video to edit" and engines.fit.role(ref, "video:1") == "Reference video"
    assert engines.fit.of(edit, "video:1")["seconds"][0] == 4 and engines.fit.of(ref, "video:1")["seconds"][0] == 2
    assert engines.lead_is_before(edit) and not engines.lead_is_before(ref)
    # Photos guiding a clip aren't a before; a first frame is.
    assert not engines.lead_is_before(_engine(builder.assemble_cloud(_spec(model=SEEDANCE, media=[2]))))
    assert engines.lead_is_before(_engine(builder.assemble_cloud(_spec(media=[0]))))
    assert not engines.lead_is_before(_engine(builder.assemble_cloud(_spec())))  # words only


def test_the_model_under_a_cloud_template_is_the_models_own_name():
    e = _engine({**builder.assemble_cloud(_spec(model=SEEDANCE, media=[2])), "label": "Reference to video"})
    assert engines.model_name(e) == adapters.get(SEEDANCE).name
    assert engines.describe(e)["model_name"] == adapters.get(SEEDANCE).name
