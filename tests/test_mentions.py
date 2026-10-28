"""How a cloud prompt names its files (adapter mentions), and shipped templates taken off Explore."""

from types import SimpleNamespace

import pytest

from server import adapters, engines

KLING = "kling/kling-v3-omni"
SEEDANCE = "byteplus/dreamina-seedance-2-5-260628"
VEO = "veo/veo-3.1-fast-generate-001"
GOOD = {"model": "acme/m", "makes": "photo", "body": {"prompt": ""}, "prompt": ["prompt"],
        "inputs": [{"role": "Photo", "type": "image", "at": ["image"], "value": "{{$|uri}}"}], "result": [["url"]]}


def test_each_model_names_files_as_its_docs_say():
    assert adapters.get(KLING).mentions == {"image": "<<<image_{n}>>>", "video": "<<<video_{n}>>>"}
    assert adapters.get(SEEDANCE).mentions["image"] == "@Image {n}"
    assert adapters.get(VEO).mentions == {}
    assert adapters.get("bfl/flux-2-max").mentions == adapters.MENTIONS
    assert all("mentions" in adapters.describe(a) for a in adapters.all_adapters().values())


@pytest.mark.parametrize("bad", [{"image": "Image"}, {"photo": "Image {n}"}, {"image": 3}, ["Image {n}"]])
def test_a_mention_needs_a_kind_and_a_number(bad):
    with pytest.raises(adapters.AdapterError, match="mentions"):
        adapters.parse({**GOOD, "mentions": bad})


def test_kling_numbers_follow_the_image_list():
    # <<<image_n>>> is the nth entry of image_list, filled in the template's order.
    a = adapters.get(KLING)
    ref = next(i for i, x in enumerate(a.inputs) if x["role"] == "Reference image")
    vid = next(i for i, x in enumerate(a.inputs) if x["type"] == "video")
    _, where, _ = adapters.assemble(a, [(ref, "image:1"), (ref, "image:2"), (vid, "video:1")], "p")
    assert where["image:1"] == ["image_list", 0] and where["image:2"] == ["image_list", 1]
    assert where["video:1"] == ["video_list", 0]


def test_cloud_templates_carry_their_models_names():
    assert engines.mentions_of(SimpleNamespace(kind="cloud", model=KLING))["image"] == "<<<image_{n}>>>"
    assert engines.mentions_of(SimpleNamespace(kind="cloud", model="acme/unknown")) == adapters.MENTIONS
    assert engines.mentions_of(SimpleNamespace(kind="local", model=None)) == {}


def test_a_shipped_template_comes_off_explore_and_back():
    tid = "local/minimax-h3-create"
    assert engines.describe(engines.ENGINES[tid])["hidden"] is False
    engines.hide_template(tid, True)
    assert engines.describe(engines.ENGINES[tid])["hidden"] is True
    assert tid in engines.ENGINES  # its file stays: runs and links still find it
    engines.hide_template(tid, False)
    assert engines.describe(engines.ENGINES[tid])["hidden"] is False
    with pytest.raises(KeyError):
        engines.hide_template("local/nope", True)


def _kling_template():
    from server import builder

    a = adapters.get(KLING)
    ref = next(i for i, x in enumerate(a.inputs) if x["role"] == "Reference image")
    vid = next(i for i, x in enumerate(a.inputs) if x["role"] == "Video to edit")
    data = builder.assemble_cloud({"model": KLING, "label": "Lobby", "prompt": {"default": "Edit Video 1 with Image 2"},
                                   "media": [{"input": ref, "kind": "image"}, {"input": ref, "kind": "image"}, {"input": vid, "kind": "video"}],
                                   "settings": [{"key": "resolution", "value": "std", "locked": True}]})
    return engines.load_template({**data, "format": "openillusion.template", "id": "lobby"}), ref, vid


def test_a_prompt_says_image_1_and_the_model_gets_its_own_name():
    e, _, _ = _kling_template()
    sent = engines.build_cloud(e, {"inputs": [{"slot": "image:1"}, {"slot": "image:2"}, {"slot": "video:1"}],
                                   "prompt": "Put Image 2 into Video 1, keep Image 1's coat. Image 3 isn't sent.", "params": {}})
    assert sent["prompt"] == "Put <<<image_2>>> into <<<video_1>>>, keep <<<image_1>>>'s coat. Image 3 isn't sent."


def test_names_already_in_the_models_own_words_stay():
    e, _, _ = _kling_template()
    sent = engines.build_cloud(e, {"inputs": [{"slot": "image:1"}, {"slot": "image:2"}, {"slot": "video:1"}],
                                   "prompt": "<<<image_1>>> and @Image 1 and Images 1", "params": {}})
    assert sent["prompt"] == "<<<image_1>>> and @Image 1 and Images 1"


def test_a_cloud_template_opens_in_the_builder_as_it_was_made():
    from server import builder

    e, ref, vid = _kling_template()
    p = builder.cloud_preset(e)
    assert p["model"] == KLING and p["base"] == "cloud/lobby" and p["label"] == "Lobby (copy)"
    assert [(m["slot"], m["input"]) for m in p["media"]] == [("image:1", ref), ("image:2", ref), ("video:1", vid)]
    assert p["prompt"]["default"] == "Edit Video 1 with Image 2"
    # A setting the template fixed comes back fixed, at its value.
    assert p["settings"]["resolution"] == {"value": "std", "locked": True}
