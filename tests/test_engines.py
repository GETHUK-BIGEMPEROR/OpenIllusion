import dataclasses
import json

import pytest

from server import engines

from conftest import make_image, make_video

HAT = "local/qwen21-add-hat"


def generic_spec(engine="acme/any-router-model", **kw):
    s = {
        "engine": engine,
        "inputs": [
            {"slot": "video:1", "role": "motion", "asset": "v.mp4", "duration": 8},
            {"slot": "image:1", "role": "character", "asset": "a.png"},
        ],
        "prompt": "Image 1 is the character. Video 1 is the motion. Night rooftop, rain.",
        "params": {},
    }
    s.update(kw)
    return s


# ---- shipped templates --------------------------------------------------------


# Each of these ran end to end on a 16 GB card (RTX 4060 Ti, 1024 px, 25 steps) before shipping.
TESTED = {HAT} | {f"local/qwen21-{n}" for n in (
    "outfit-swap", "relight", "background-swap", "hair", "expression",
    "glasses", "makeup", "restyle", "remove", "recolor", "product-shot", "hold-product", "weather", "restore",
)} | {"local/minimax-h3-character-swap"}  # same card, 0.4 MP x 124 frames, 4 steps, ~10 min


def test_only_tested_templates_ship():
    assert {e.id for e in engines.ENGINES.values() if e.origin == "shipped"} == TESTED


@pytest.mark.parametrize("tid", sorted(TESTED))
def test_shipped_templates_list_every_input_and_bind_it(tid):
    e = engines.ENGINES[tid]
    raw = json.loads(e.path.read_text("utf-8"))
    assert raw["version"] == 2 and "bindings" not in raw and "instruction" not in raw and "defaults" not in raw
    d = engines.describe(e)
    keys = [f["key"] for f in d["fields"]]
    assert keys[: len(e.inputs)] == ["video:1"] * e.needs_video + [f"image:{n}" for n in range(1, e.max_images + 1)]
    assert "prompt" in keys and all(f["bind"] for f in d["fields"])
    # The whole prompt is the input: the workflow has no text of its own around it.
    prompt = next(f for f in d["fields"] if f["key"] == "prompt")
    node, inp = prompt["bind"][0]
    assert e.workflow[node]["inputs"][inp] == prompt["default"] == e.default_prompt
    assert not any(n["class_type"] == "StringConcatenate" for n in e.workflow.values())
    assert d["examples"] and all(x["label"] and x["text"].startswith(prompt["default"][:12]) for x in d["examples"]) and d["tags"]


def test_hat_template_writes_every_binding():
    spec = {
        "engine": HAT,
        "inputs": [{"slot": "image:1", "role": "base", "asset": "a.png"}],
        "prompt": "Put a red wool beanie on the person in <image1>.",
        "params": {"size": "1K", "steps": "25", "seed": 7, "cache": "cpu"},
    }
    out = engines.compose(spec)
    wf = out["template"]
    assert not [w for w in out["warnings"] if w["level"] == "error"]
    assert wf["5"]["inputs"]["prompt"] == "Put a red wool beanie on the person in <image1>."  # sent exactly as typed
    assert wf["11"]["inputs"]["image"] == "{{image:1}}"
    assert wf["5"]["inputs"]["resolution"] == 0  # images arrive already sized (prep.py)
    assert wf["7"]["inputs"]["steps"] == 25 and wf["7"]["inputs"]["seed"] == 7
    assert wf["2"]["inputs"]["device"] == "cpu"


def test_hat_template_needs_its_image():
    spec = {"engine": HAT, "inputs": [], "prompt": "straw fedora", "params": {}}
    w = engines.compose(spec)["warnings"]
    assert any(x["field"] == "inputs" and x["level"] == "error" for x in w)


def test_missing_inputs_are_named_in_the_templates_words():
    hold = "local/qwen21-hold-product"
    # Slots can be filled in any order: here only the product (Image 2) is in.
    spec = {"engine": hold, "inputs": [{"slot": "image:2", "role": "reference", "asset": "p.png"}], "prompt": "", "params": {}}
    texts = [x["text"] for x in engines.compose(spec)["warnings"] if x["field"] == "inputs"]
    assert texts == ["Add a person"]
    spec["inputs"] = []
    texts = [x["text"] for x in engines.compose(spec)["warnings"] if x["field"] == "inputs"]
    assert texts == ["Add a person", "Add a product"]
    restore = {"engine": "local/qwen21-restore", "inputs": [], "prompt": "", "params": {}}
    assert [x["text"] for x in engines.compose(restore)["warnings"] if x["field"] == "inputs"] == ["Add an old photo"]


# ---- the generic Router path --------------------------------------------------


def test_prompt_is_never_rewritten():
    p = "  keep   my   spacing  "
    body = engines.compose(generic_spec(prompt=p))["template"]
    assert body["prompt"] == p


def test_generic_body_carries_media_tokens():
    body = engines.compose(generic_spec())["template"]
    assert body["images"] == ["{{image:1}}"] and body["video_url"] == "{{video:1}}"


def test_video_window_is_enforced(monkeypatch):
    e = dataclasses.replace(engines.get("acme/clip-model"), mode="motion", needs_video=True, video_window=(2.0, 15.0))
    monkeypatch.setitem(engines.ENGINES, e.id, e)
    s = generic_spec(e.id)
    s["inputs"][0]["trimmed_duration"] = 20
    w = engines.compose(s)["warnings"]
    assert any(x["field"] == "video" and "2–15" in x["text"] for x in w)


def test_boxes_ride_at_end_of_prompt():
    boxes = [
        {"rect": [0.1, 0.2, 0.3, 0.4], "label": "replace jacket with a yellow raincoat"},
        {"rect": [0.5, 0.5, 0.1, 0.1], "label": ""},
    ]
    first, json_line = engines.prompt_with_boxes("Make it rain.", boxes).split("\n")
    assert first == "Make it rain."
    assert json.loads(json_line) == [{
        "id": "box_1", "from": "image_1", "src_bbox": [200, 100, 600, 400], "tgt_bbox": [200, 100, 600, 400],
        "desc": "replace jacket with a yellow raincoat",
    }]
    assert engines.prompt_with_boxes("Plain.", boxes[1:]) == "Plain."


def test_materialize_replaces_only_whole_tokens():
    t = {"a": "{{image:1}}", "b": ["{{video:1|url}}", "text {{image:1}}"], "c": {"d": "{{image:2|b64}}"}}
    out = engines.materialize(t, lambda k, n, f: f"{k}{n}-{f}")
    assert out == {"a": "image1-uri", "b": ["video1-url", "text {{image:1}}"], "c": {"d": "image2-b64"}}
    assert t["a"] == "{{image:1}}"  # template untouched


def test_role_sentences():
    s = engines.role_sentences([{"slot": "image:1", "role": "character"}, {"slot": "video:1", "role": "motion"}])
    assert s == "Image 1 is the character. Video 1 is the motion."


def test_result_parsing():
    h3 = {"task": {"status": "succeeded", "content": {"url": "https://x/generated.mp4"}, "seed": 5}}
    assert engines.find_assets(h3) == ["https://x/generated.mp4"]
    assert engines.result_seed(h3) == 5
    flux = {"id": "1", "status": "Ready", "result": {"sample": "https://cdn/s?sig=1", "seed": 2784347701}}
    assert engines.find_assets(flux) == ["https://cdn/s?sig=1"]
    assert engines.result_seed(flux) == 2784347701
    hf = {"status": "completed", "status_url": "https://api/s", "video": {"url": "https://v/out.mp4"}}
    assert engines.find_assets(hf) == ["https://v/out.mp4"]
    assert engines.classify_failure({"status": "nsfw"})["error_type"] == "content_policy_violation"
    assert engines.classify_failure({"task": {"status": "failed", "error": {"message": "boom"}}})["message"] == "boom"
    assert engines.classify_failure(h3) is None


# ---- covers -------------------------------------------------------------------


def test_cover_from_image_then_reset(tmp_path):
    e = engines.get(HAT)
    shipped = engines.describe(e)["cover"]  # the template ships one
    assert shipped and not engines.describe(e)["cover_custom"]
    engines.set_cover(e.id, make_image(tmp_path / "big.png", size=(2400, 1600)))
    d = engines.describe(e)
    assert d["cover_custom"] and d["cover"].startswith("/api/cover?engine=local%2Fqwen21-add-hat&v=")
    assert d["cover_video"] is None and d["cover_aspect"] == 1.5
    from PIL import Image

    with Image.open(engines.cover_file(e)) as img:
        assert img.format == "WEBP" and max(img.size) == engines.COVER_SIDE
    engines.clear_cover(e.id)
    assert engines.describe(e)["cover"] == shipped and not engines.describe(e)["cover_custom"]


def test_cover_from_video_is_a_muted_loop_with_poster(tmp_path):
    engines.set_cover(HAT, make_video(tmp_path / "clip.mp4", seconds=12, size=(240, 320)))
    e = engines.get(HAT)
    d = engines.describe(e)
    assert d["cover_video"] == d["cover"] + "&video=1" and d["cover_aspect"] == 0.75
    info = engines.media.probe(engines.cover_file(e, video=True))
    assert info["duration"] <= engines.COVER_LOOP_SECONDS + 0.2 and not info["has_audio"]
    engines.set_cover(HAT, make_image(tmp_path / "still.png"))  # an image replaces the loop
    assert engines.cover_file(e, video=True) is None
    engines.set_cover(HAT, make_video(tmp_path / "clip2.mp4", seconds=2))
    engines.clear_cover(HAT)
    assert engines.cover_files(e) == (e.cover, None)  # back to the shipped still


def test_shipped_cover_is_the_fallback(tmp_path, monkeypatch):
    shipped = make_image(tmp_path / "shipped.png")
    e = dataclasses.replace(engines.get(HAT), cover=shipped)
    monkeypatch.setitem(engines.ENGINES, HAT, e)
    assert engines.cover_file(e) == shipped and not engines.describe(e)["cover_custom"]
    engines.set_cover(HAT, make_image(tmp_path / "mine.png", color=(1, 2, 3)))
    assert engines.cover_file(e) == engines.user_cover(HAT)  # the user's choice wins
    engines.clear_cover(HAT)
    assert engines.cover_file(e) == shipped


def test_load_template_resolves_cover_next_to_it(tmp_path):
    data = json.loads((engines.paths.templates_dir() / "qwen21-add-hat.json").read_text("utf-8"))
    data["cover"] = "hat.webp"
    assert engines.load_template(data, base=tmp_path).cover == tmp_path / "hat.webp"


@pytest.mark.parametrize("bad", ["../x", "local/../../y"])
def test_cover_names_stay_inside_covers_folder(bad):
    p = engines.user_cover(bad)
    assert p.parent == engines.paths.user_root() / "covers"


# ---- editing templates ---------------------------------------------------------


@pytest.fixture
def fresh_templates():
    """Reload templates against this test's user folder, and put the real set back after."""
    before = dict(engines.ENGINES)
    engines.reload_templates()
    yield
    engines.ENGINES.clear()
    engines.ENGINES.update(before)


def test_hat_describes_what_it_needs():
    d = engines.describe(engines.ENGINES[HAT])
    assert d["origin"] == "shipped" and d["edited"] is False
    assert d["inputs"][0]["slot"] == "image:1" and d["fields"][0]["sample"]["slot"] == "image:1"
    assert d["examples"] and d["tips"] and d["tags"]
    assert d["defaults"]["prompt"].startswith("Put a hat on") and "The hat sits naturally" in d["defaults"]["prompt"]
    assert [f["key"] for f in d["fields"] if f.get("advanced")] == ["steps", "seed", "cache"]
    names = {m["name"] for m in d["requires"]["models"]}
    assert any("qwen_image_2.1" in n for n in names)
    assert {"KSampler", "LoadImage", "SaveImage"} <= set(d["requires"]["nodes"])


@pytest.mark.usefixtures("fresh_templates")
def test_edit_writes_a_user_copy_and_reset_removes_it():
    shipped = engines.ENGINES[HAT].path
    before = shipped.read_text("utf-8")
    e = engines.edit_template(HAT, {
        "label": "  Hat me  ", "tags": ["hat", " ", "fun"],
        "inputs": {"prompt": {"hint": "a top hat", "default": "Give <image1> a top hat.", "examples": [{"label": "Top hat", "text": "Give <image1> a top hat."}, "Give <image1> a cap."]},
                   "image:1": {"label": "Someone"}},
    })
    assert e.label == "Hat me" and e.tags == ["hat", "fun"] and e.prompt["hint"] == "a top hat"
    assert e.default_prompt == "Give <image1> a top hat." and e.inputs[0]["label"] == "Someone"
    assert e.examples == [{"label": "Top hat", "text": "Give <image1> a top hat."}, {"label": "Give <image1> a cap.", "text": "Give <image1> a cap."}]
    assert e.origin == "user" and e.edited and e.default_inputs["image:1"].is_file()  # the sample stays where it shipped
    assert shipped.read_text("utf-8") == before

    again = engines.edit_template(HAT, {"blurb": "Second edit"})
    assert again.path == e.path and again.label == "Hat me"

    back = engines.reset_template(HAT)
    assert back.origin == "shipped" and not back.edited and back.label != "Hat me"
    assert not e.path.exists()


@pytest.mark.usefixtures("fresh_templates")
@pytest.mark.parametrize("patch", [
    {"label": "x" * 81},
    {"tags": "hat"},
    {"inputs": {"prompt": {"examples": ["x"] * 13}}},
    {"inputs": {"nope": {"label": "x"}}},
    {"inputs": {"prompt": {"default": 3}}},
    {"inputs": {"image:1": {"default": "other.png"}}},
    {"inputs": ["prompt"]},
])
def test_edit_rejects_bad_patches(patch):
    with pytest.raises(ValueError):
        engines.edit_template(HAT, patch)


@pytest.mark.usefixtures("fresh_templates")
def test_reset_needs_an_edit_and_edit_needs_a_template():
    with pytest.raises(KeyError):
        engines.reset_template(HAT)
    with pytest.raises(KeyError):
        engines.edit_template("local/nope", {"label": "x"})


# ---- motion templates ----------------------------------------------------------

SWAP = "local/minimax-h3-character-swap"


def test_swap_needs_its_clip_and_character_by_name():
    e = engines.ENGINES[SWAP]
    w = engines.compose({"engine": SWAP, "inputs": [{"slot": "image:1", "asset": "a.png"}], "prompt": "the man", "params": {}})["warnings"]
    assert [x["text"] for x in w] == ["Add a source clip"]
    w = engines.compose({"engine": SWAP, "inputs": [{"slot": "video:1", "asset": "v.mp4", "duration": 5}], "prompt": "the man", "params": {}})["warnings"]
    assert [x["text"] for x in w] == ["Add a character"]
    c = engines.compose({"engine": SWAP, "inputs": [{"slot": "image:1", "asset": "a.png"}, {"slot": "video:1", "asset": "v.mp4", "duration": 5}],
                         "prompt": "the man on the left", "params": {"keep_audio": False, "strength": 0.8}})
    assert c["warnings"] == []
    t = c["template"]
    assert t["1"]["inputs"]["image"] == "{{image:1}}" and t["2"]["inputs"]["file"] == "{{video:1}}"
    assert t["23"]["inputs"]["prompt"] == "the man on the left"
    assert t["42"]["inputs"]["switch"] is False and t["11"]["inputs"]["strength_model"] == 0.8
    # The app sizes the clip; the workflow takes its frames as they come.
    assert "4" not in t and t["5"]["inputs"]["image"] == ["3", 0] and t["23"]["inputs"]["ref_videos.ref_video_0"] == ["3", 0]
    assert e.fps_window == (24, 24) and e.size["follows"] == "video:1" and e.size["inputs"] == {"video:1": "0.4 MP", "image:1": "Original"}


def test_sample_clip_is_described_as_video_with_a_poster():
    e = engines.ENGINES[SWAP]
    d = {i["slot"]: i for i in engines.defaults_info(e)["inputs"]}
    v = d["video:1"]
    assert v["kind"] == "video" and v["duration"] > 2 and v["fps"] == 24 and v["poster"].endswith("&poster=1")
    assert d["image:1"]["kind"] == "image"
    p = engines.default_poster(SWAP, "video:1")
    assert p.suffix == ".webp" and p.is_file() and p.parent.parent == engines.paths.cache_dir()


# ---- the template format ---------------------------------------------------------


def test_version_1_files_load_with_their_hidden_text_moved_into_the_prompt():
    wf = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
          "2": {"class_type": "StringConcatenate", "inputs": {"string_a": "Give <image1> ", "string_b": "", "delimiter": ""}},
          "3": {"class_type": "StringConcatenate", "inputs": {"string_a": ["2", 0], "string_b": ". Keep the rest.", "delimiter": ""}},
          "4": {"class_type": "Encode", "inputs": {"text": ["3", 0], "steps": 20}}}
    old = {"format": "openillusion.template", "id": "old", "mode": "edit", "max_images": 2, "min_images": 1,
           "inputs": [{"slot": "image:1", "label": "Person", "size": "1 MP"}, {"slot": "image:2", "label": "Extra"}],
           "prompt": {"label": "Your hat", "hint": "a cap"}, "examples": ["a cap"], "defaults": {"prompt": "a beret", "inputs": {"image:1": "p.png"}},
           "instruction": {"start": ["2", "string_a"], "end": ["3", "string_b"]},
           "params": [{"key": "steps", "label": "Steps", "type": "int", "default": 20}],
           "bindings": {"image:1": [["1", "image"]], "prompt": [["2", "string_b"]], "params.steps": [["4", "steps", "int"]]},
           "workflow": wf}
    e = engines.load_template(old)
    assert [(f["key"], f.get("required")) for f in e.fields] == [("image:1", True), ("image:2", False), ("prompt", True), ("steps", None)]
    assert e.default_prompt == "Give <image1> a beret. Keep the rest."
    assert e.examples == [{"label": "a cap", "text": "Give <image1> a cap. Keep the rest."}]
    assert e.min_images == 1 and e.max_images == 2 and e.inputs[0] == {"slot": "image:1", "label": "Person", "size": "1 MP"}
    wf = e.build({"inputs": [{"slot": "image:1"}], "prompt": "Give <image1> a cap.", "params": {"steps": 9}})
    # The fixed text now lives in the prompt; the workflow's own copy is empty, so it isn't sent twice.
    assert wf["2"]["inputs"]["string_a"] == "" and wf["2"]["inputs"]["string_b"] == "Give <image1> a cap." and wf["3"]["inputs"]["string_b"] == ""
    assert wf["4"]["inputs"]["steps"] == 9 and "2" in wf
    assert old["workflow"]["2"]["inputs"]["string_a"] == "Give <image1> "  # the file as loaded is left alone

    wrapped = {"format": "openillusion.template", "id": "w", "kind": "cloud", "model": "a/b", "body": {"prompt": ""}, "built": True,
               "prompt": {"label": "Prompt"}, "prompt_wrap": {"start": "Photo of "}, "defaults": {"prompt": "a cat"},
               "bindings": {"prompt": [["prompt"]]}, "max_images": 0}
    e = engines.load_template(wrapped)
    assert e.default_prompt == "Photo of a cat" and e.build({"inputs": [], "prompt": "A dog", "params": {}})["prompt"] == "A dog"


@pytest.mark.parametrize("bad", [
    [{"key": "image:1", "type": "video"}],
    [{"key": "Steps", "type": "int"}],
    [{"key": "x", "type": "slider"}],
    [{"key": "prompt", "type": "text"}, {"key": "prompt", "type": "text"}],
])
def test_bad_inputs_are_refused(bad):
    with pytest.raises(ValueError):
        engines.load_template({"format": "openillusion.template", "version": 2, "id": "x", "inputs": bad, "workflow": {}})


def test_a_template_without_a_prompt_runs_without_one():
    e = engines.load_template({"format": "openillusion.template", "version": 2, "id": "up", "workflow": {"1": {"class_type": "LoadImage", "inputs": {"image": ""}}},
                               "inputs": [{"key": "image:1", "type": "image", "label": "Photo", "bind": [["1", "image"]]}]})
    engines.ENGINES[e.id] = e
    try:
        w = engines.compose({"engine": e.id, "inputs": [{"slot": "image:1", "asset": "a.png"}], "prompt": "", "params": {}})["warnings"]
        assert w == [] and e.prompt is None
    finally:
        engines.ENGINES.pop(e.id)
