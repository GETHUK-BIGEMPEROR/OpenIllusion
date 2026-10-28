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
