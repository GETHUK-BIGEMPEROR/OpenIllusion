"""Output settings: what people choose about the result (shape, size, resolution, length, sound),
for Router models (adapter settings) and local workflows (size and duration inputs)."""

import pytest

from server import adapters, builder, engines, prep
from server.engines import build, contract

FLUX = "bfl/flux-2-max"
SEEDREAM = "byteplus/seedream-5-0-pro-260628"
VEO = "veo/veo-3.1-fast-generate-001"
KLING = "kling/kling-v3-omni"
GPT = "openai/gpt-image-2"
BANANA = "vertexai/gemini-nano-banana-2.1"

GOOD = {"model": "acme/m", "makes": "photo", "body": {"prompt": ""}, "prompt": ["prompt"],
        "inputs": [{"role": "Photo", "type": "image", "at": ["image"], "value": "{{$|uri}}"}], "result": [["url"]]}


def _spec(model, media=(), settings=None, prompt="a fox"):
    rows = [{"input": i, "kind": k} for i, k in media]
    return {"model": model, "label": "T", "media": rows, "prompt": {"default": prompt}, "settings": settings or []}


def _role(model, role):
    a = adapters.get(model)
    return next((i, x["type"]) for i, x in enumerate(a.inputs) if x["role"] == role)


# ---- adapters ---------------------------------------------------------------

def test_every_model_has_settings_and_their_defaults_are_valid():
    for a in adapters.all_adapters().values():
        assert a.settings, a.model
        for s in a.settings:
            assert adapters.setting_ok(s, adapters.setting_default(s)), (a.model, s["key"])
        assert all("at" not in s for s in adapters.describe(a)["settings"])  # where they go stays on the server


@pytest.mark.parametrize("bad,match", [
    ({"key": "Bad", "type": "select", "at": ["x"], "options": ["a"], "default": "a"}, "short lowercase"),
    ({"key": "q", "type": "dial", "at": ["x"]}, "type one of"),
    ({"key": "q", "type": "select", "at": ["x"], "options": ["a"], "default": "b"}, "default is one of them"),
    ({"key": "q", "type": "int", "at": ["x"], "min": 1, "max": 5, "default": 9}, "min, max"),
    ({"key": "q", "type": "bool", "at": ["x"], "default": "yes"}, "true or false"),
    ({"key": "q", "type": "select", "at": ["x"], "options": ["a"], "default": "a", "off_with": ["Nope"]}, "off_with lists roles"),
    ({"key": "size", "type": "select", "at": ["x"], "options": ["a"], "default": "a"}, "keyed size"),
    ({"key": "size", "type": "size", "at": {"width": ["w"]}, "steps": [1], "aspects": ["1:1"], "aspect": "1:1",
      "default": "1 MP"}, "at is"),
    ({"key": "size", "type": "size", "at": {"text": ["s"]}, "steps": [1], "aspects": ["1:1"], "aspect": "1:1",
      "default": "2 MP"}, "default is one of the steps"),
    ({"key": "size", "type": "size", "at": {"text": ["s"]}, "steps": [1], "aspects": ["wide"], "aspect": "wide",
      "default": "1 MP"}, "aspects lists shapes"),
])
def test_bad_settings_are_refused(bad, match):
    with pytest.raises(adapters.AdapterError, match=match):
        adapters.parse({**GOOD, "settings": [bad]})


def test_settings_follow_the_roles_filled():
    keys = lambda m, *roles: [s["key"] for s in adapters.settings_for(adapters.get(m), list(roles))]
    assert keys(KLING) == ["aspect", "resolution", "duration", "sound"]
    assert keys(KLING, "First frame") == ["resolution", "duration", "sound"]  # the frame sets the shape
    assert keys(KLING, "Video to edit") == ["resolution"]  # the clip sets shape, length and sound
    assert keys(VEO, "Video to extend") == []
    assert keys(SEEDREAM) == ["size"] and keys(SEEDREAM, "Photo") == ["resolution"]
    assert keys(FLUX, "Photo") == []


def test_size_is_megapixels_at_the_shape_inside_the_model_limits():
    flux = next(s for s in adapters.get(FLUX).settings if s["key"] == "size")
    assert adapters.size_dims(flux, "1:1", "1 MP") == (1024, 1024)
    w, h = adapters.size_dims(flux, "16:9", "4 MP")
    assert max(w, h) <= 2048 and w % 16 == 0 and h % 16 == 0 and abs(w / h - 16 / 9) < 0.02
    seed = next(s for s in adapters.get(SEEDREAM).settings if s["key"] == "size")
    w, h = adapters.size_dims(seed, "21:9", "4 MP")
    assert w * h <= 4194304 and w % 16 == 0
    assert prep.shape("16:9") == (16, 9) and prep.shape("1536x1024") == (1536, 1024) and prep.shape("auto") is None


def test_write_setting_puts_values_where_the_model_reads_them():
    a = adapters.get(KLING)
    sound = next(s for s in a.settings if s["key"] == "sound")
    body: dict = {}
    adapters.write_setting(body, sound, True)
    assert body == {"sound": "on"}  # a bool the model spells as words
    seed = next(s for s in adapters.get(SEEDREAM).settings if s["key"] == "size")
    body = {}
    adapters.write_setting(body, seed, {"aspect": "1:1", "size": "2 MP"})
    assert body == {"size": "1456x1456"}  # 2 x 1024² px, on the 16 grid
    banana = next(s for s in adapters.get(BANANA).settings if s["key"] == "aspect")
    body = {"generationConfig": {"imageConfig": {"aspectRatio": "1:1"}}}
    adapters.write_setting(body, banana, "")  # Auto: the field isn't sent
    assert "aspectRatio" not in str(body)


# ---- the Builder ----------------------------------------------------------------

def test_builder_writes_settings_and_offers_the_unlocked_ones():
    data = builder.assemble_cloud(_spec(KLING, settings=[
        {"key": "aspect", "value": "9:16", "locked": True}, {"key": "duration", "value": "10"}, {"key": "sound", "value": True}]))
    assert data["body"]["aspect_ratio"] == "9:16" and data["body"]["duration"] == "10" and data["body"]["sound"] == "on"
    fields = {f["key"]: f for f in data["inputs"]}
    assert "aspect" not in fields  # locked: fixed in the request
    assert fields["duration"]["default"] == "10" and fields["duration"]["unit"] == "s"
    assert fields["resolution"]["labels"] == {"std": "720p", "pro": "1080p"}
    e = contract.load_template({**data, "id": "cloud/t"})
    assert build.build_cloud(e, {"prompt": "x", "params": {"sound": False, "duration": "5"}})["sound"] == "off"


def test_builder_leaves_out_settings_an_input_decides():
    frame = builder.assemble_cloud(_spec(KLING, media=[_role(KLING, "First frame")]))
    assert "aspect_ratio" not in frame["body"] and "aspect" not in [f["key"] for f in frame["inputs"]]


def test_builder_refuses_a_value_the_model_has_not():
    with pytest.raises(builder.BuildError, match="Duration: pick one"):
        builder.assemble_cloud(_spec(KLING, settings=[{"key": "duration", "value": "99"}]))
    with pytest.raises(builder.BuildError, match="Size: pick one"):
        builder.assemble_cloud(_spec(FLUX, settings=[{"key": "size", "value": {"aspect": "7:3", "size": "1 MP"}}]))


def test_cloud_size_field_runs_at_the_shape_and_step_picked():
    data = builder.assemble_cloud(_spec(FLUX))
    size = next(f for f in data["inputs"] if f["key"] == "size")
    assert size["bind"] == [[["width"], "width"], [["height"], "height"]] and size["default"] == "1 MP"
    e = contract.load_template({**data, "id": "cloud/flux"})
    body = build.build_cloud(e, {"prompt": "x", "params": {"aspect": "16:9", "out_size": "2 MP"}})
    assert (body["width"], body["height"]) == (1936, 1088)
    body = build.build_cloud(e, {"prompt": "x", "params": {}})
    assert (body["width"], body["height"]) == (1024, 1024)


def test_auto_leaves_the_field_out_and_values_keep_their_type():
    data = builder.assemble_cloud(_spec(BANANA))
    e = contract.load_template({**data, "id": "cloud/b"})
    body = build.build_cloud(e, {"prompt": "x", "params": {"aspect": "", "resolution": "2K"}})
    assert "aspectRatio" not in str(body) and body["generationConfig"]["imageConfig"]["imageSize"] == "2K"
    veo = contract.load_template({**builder.assemble_cloud(_spec(VEO)), "id": "cloud/v"})
    assert build.build_cloud(veo, {"prompt": "x", "params": {"duration": "6"}})["parameters"]["durationSeconds"] == 6


def test_a_template_saved_before_settings_gets_them():
    data = builder.assemble_cloud(_spec(GPT))
    old = {**data, "id": "cloud/old", "inputs": [f for f in data["inputs"] if f["key"] == "prompt"]}
    e = contract.load_template(old)
    assert {f["key"] for f in e.fields} >= {"aspect", "quality"}


# ---- local workflows --------------------------------------------------------------

def test_local_create_templates_offer_size_and_length():
    h3 = engines.ENGINES["local/minimax-h3-create"]
    wf = build.build_local(h3, {"prompt": "x", "inputs": [], "params": {"aspect": "9:16", "out_size": "1 MP", "duration": 8}})
    n = wf["140:131"]["inputs"]
    assert (n["width"], n["height"]) == (736, 1312) and wf["140:133"]["inputs"]["value"] == 8.0
    animate = engines.ENGINES["local/minimax-h3-animate"]
    assert next(p for p in animate.params if p["key"] == "duration")["options"] == [3, 5, 8, 10, 15]
    qwen = engines.ENGINES["local/qwen21-create"]
    wf = build.build_local(qwen, {"prompt": "x", "inputs": [], "params": {"aspect": "1:1", "out_size": "1 MP"}})
    assert wf["459:456"]["inputs"]["width"] == wf["459:456"]["inputs"]["height"] == 992  # 1 MP (10^6 px) on the 32 grid
