import dataclasses
import json

import pytest

from server import engines

from conftest import make_image, make_video

HAT = "local/qwen21-add-hat"


def clip_spec(engine="cloud/test-clip", **kw):
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
    "cutout",  # 1 MP, 25 steps, ~2 min
)} | {"local/minimax-h3-character-swap",  # same card, 0.4 MP x 124 frames, 4 steps, ~10 min
     "local/minimax-h3-animate",  # 0.4 MP x 124 frames, 4 steps, ~4 min
     "local/minimax-h3-create"} | {"local/qwen21-create"}  # text only: 0.4 MP x 124 frames ~3.5 min; 1 MP, 25 steps ~1.5 min
# Ran for real on Comfy Router with a key. Text to Image's cover is that run's result; the two Seedance edits
# ship their samples (all generated here) and no cover, so the first run makes one.
TESTED |= {"cloud/text-to-image-seedream-5-0-pro", "cloud/swap-two-people-seedance-2-5", "cloud/replace-character-seedance-2-5"}


def test_only_tested_templates_ship(fresh_templates):
    assert {e.id for e in engines.ENGINES.values() if e.origin == "shipped"} == TESTED


def test_shipped_cloud_templates_send_their_prompt_and_ship_their_files(fresh_templates):
    for tid in sorted(t for t in TESTED if t.startswith("cloud/")):
        e = engines.ENGINES[tid]
        d = engines.describe(e)
        prompt = next(f for f in d["fields"] if f["key"] == "prompt")
        assert prompt["default"] == e.default_prompt and prompt["bind"]
        assert all(f["bind"] or f.get("keep_sound") for f in d["fields"])
        assert e.blurb and all(p.is_file() for p in e.default_inputs.values())
        assert len(d["defaults"]["inputs"]) == len(d["inputs"])
        assert not e.cover or (d["cover"] and e.cover.is_file())


@pytest.mark.parametrize("tid", sorted(t for t in TESTED if t.startswith("local/")))
def test_shipped_templates_list_every_input_and_bind_it(tid, fresh_templates):
    e = engines.ENGINES[tid]
    raw = json.loads(e.path.read_text("utf-8"))
    assert raw["version"] == 2 and "bindings" not in raw and "instruction" not in raw and "defaults" not in raw
    d = engines.describe(e)
    keys = [f["key"] for f in d["fields"]]
    assert keys[: len(e.inputs)] == ["video:1"] * e.needs_video + [f"image:{n}" for n in range(1, e.max_images + 1)]
    assert "prompt" in keys and all(f["bind"] or f.get("keep_sound") for f in d["fields"])  # Sound acts after the run
    # The whole prompt is the input: the workflow has no text of its own around it.
    prompt = next(f for f in d["fields"] if f["key"] == "prompt")
    node, inp = prompt["bind"][0]
    assert e.workflow[node]["inputs"][inp] == prompt["default"] == e.default_prompt
    assert not any(n["class_type"] == "StringConcatenate" for n in e.workflow.values())
    assert "examples" not in prompt and "examples" not in d and "tags" not in d
    # A template is its inputs, its prompt and the output settings any generator has (size, length, sound);
    # everything else runs as the workflow says.
    assert all(f["type"] in ("image", "video", "audio", "size") or f["key"] in ("prompt", "duration", "sound") for f in d["fields"])


def test_hat_template_writes_every_binding():
    spec = {
        "engine": HAT,
        "inputs": [{"slot": "image:1", "role": "base", "asset": "a.png"}],
        "prompt": "Put a red wool beanie on the person in <image1>.",
        "params": {},
    }
    out = engines.compose(spec)
    wf = out["template"]
    assert not [w for w in out["warnings"] if w["level"] == "error"]
    assert wf["5"]["inputs"]["prompt"] == "Put a red wool beanie on the person in <image1>."  # sent exactly as typed
    assert wf["11"]["inputs"]["image"] == "{{image:1}}"
    assert wf["5"]["inputs"]["resolution"] == 0  # images arrive already sized (prep.py)
    assert wf["7"]["inputs"]["steps"] == 25 and wf["2"]["inputs"]["device"] == "cpu"  # as saved in the workflow


def test_hat_template_needs_its_image():
    spec = {"engine": HAT, "inputs": [], "prompt": "straw fedora", "params": {}}
    w = engines.compose(spec)["warnings"]
    assert any(x["field"] == "inputs" and x["level"] == "error" for x in w)


def test_missing_inputs_are_named_by_their_place():
    hold = "local/qwen21-hold-product"
    # Slots can be filled in any order: here only the product (Image 2) is in.
    spec = {"engine": hold, "inputs": [{"slot": "image:2", "role": "reference", "asset": "p.png"}], "prompt": "", "params": {}}
    texts = [x["text"] for x in engines.compose(spec)["warnings"] if x["field"] == "inputs"]
    assert texts == ["Add Image 1"]
    spec["inputs"] = []
    texts = [x["text"] for x in engines.compose(spec)["warnings"] if x["field"] == "inputs"]
    assert texts == ["Add Image 1", "Add Image 2"]
    restore = {"engine": "local/qwen21-restore", "inputs": [], "prompt": "", "params": {}}
    assert [x["text"] for x in engines.compose(restore)["warnings"] if x["field"] == "inputs"] == ["Add Image 1"]


# ---- a Router template ------------------------------------------------------------


def test_prompt_is_never_rewritten(clip_template):
    p = "  keep   my   spacing  "
    body = engines.compose(clip_spec(prompt=p))["template"]
    assert body["prompt"] == p


def test_cloud_body_carries_media_tokens(clip_template):
    body = engines.compose(clip_spec())["template"]
    assert body["images"] == ["{{image:1}}"] and body["video_url"] == "{{video:1}}"


def test_video_window_is_enforced(clip_template, monkeypatch):
    fields = [{**f, "window": [2.0, 15.0]} if f["key"] == "video:1" else f for f in clip_template.fields]
    e = dataclasses.replace(clip_template, fields=fields)
    monkeypatch.setitem(engines.ENGINES, e.id, e)
    s = clip_spec(e.id)
    s["inputs"][0]["trimmed_duration"] = 20  # too long is cut at the run, not refused
    assert not engines.compose(s)["warnings"]
    s["inputs"][0]["trimmed_duration"] = 1
    w = engines.compose(s)["warnings"]
    assert any(x["field"] == "video" and x["level"] == "error" and "at least 2 s" in x["text"] for x in w)


def test_materialize_replaces_only_whole_tokens():
    t = {"a": "{{image:1}}", "b": ["{{video:1|url}}", "text {{image:1}}"], "c": {"d": "{{image:2|b64}}"}}
    out = engines.materialize(t, lambda k, n, f: f"{k}{n}-{f}")
    assert out == {"a": "image1-uri", "b": ["video1-url", "text {{image:1}}"], "c": {"d": "image2-b64"}}
    assert t["a"] == "{{image:1}}"  # template untouched



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
    engines.set_cover(e.id, make_image(tmp_path / "big.png", size=(3200, 2000)))
    d = engines.describe(e)
    assert d["cover_custom"] and d["cover"].startswith("/api/cover?engine=local%2Fqwen21-add-hat&v=")
    assert d["cover_video"] is None and d["cover_aspect"] == 1.6
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


def test_a_cover_shows_beside_the_input_it_was_made_from(tmp_path):
    # Shipped covers were made from the shipped samples: the lead one (a clip first, else a photo).
    hat = engines.describe(engines.get(HAT))["cover_before"]
    assert hat == {"url": engines.describe(engines.get(HAT))["cover"] + "&before=1", "kind": "image"}
    assert engines.cover_before(engines.get(HAT)) == engines.get(HAT).default_inputs["image:1"]
    swap = engines.get("local/minimax-h3-character-swap")
    assert engines.lead_slot(swap) == "video:1" and engines.cover_before(swap) == swap.default_inputs["video:1"]
    assert engines.cover_before(engines.get("local/minimax-h3-create")) is None  # words only: nothing beside it
    # A cover set from a run keeps that run's input; one set without it shows alone.
    engines.set_cover(HAT, make_image(tmp_path / "out.png"), before=make_image(tmp_path / "in.png", size=(900, 600)))
    assert engines.cover_before(engines.get(HAT)) == engines.user_cover(HAT, ".before.webp")
    engines.set_cover(HAT, make_image(tmp_path / "out2.png"))
    assert engines.cover_before(engines.get(HAT)) is None
    engines.set_cover(HAT, make_video(tmp_path / "o.mp4", seconds=2), before=make_video(tmp_path / "i.mp4", seconds=12))
    clip = engines.cover_before(engines.get(HAT))
    info = engines.media.probe(clip)
    assert clip.name.endswith(".before.mp4") and info["duration"] <= engines.COVER_LOOP_SECONDS + 0.2 and not info["has_audio"]
    engines.clear_cover(HAT)
    assert not any(engines.user_cover(HAT, x).exists() for x in engines.BEFORE_EXT)
    assert engines.cover_before(engines.get(HAT)) == engines.get(HAT).default_inputs["image:1"]  # the shipped pair again


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


def test_hat_describes_what_it_needs():
    d = engines.describe(engines.ENGINES[HAT])
    assert d["origin"] == "shipped" and d["edited"] is False
    assert d["inputs"][0]["slot"] == "image:1" and d["fields"][0]["sample"]["slot"] == "image:1"
    assert "examples" not in d and "tags" not in d and "tips" not in d and d["varies"] is True
    assert d["defaults"]["prompt"].startswith("Put a hat on") and "The hat sits naturally" in d["defaults"]["prompt"]
    assert [f["key"] for f in d["fields"]] == ["image:1", "prompt"]
    names = {m["name"] for m in d["requires"]["models"]}
    assert any("qwen_image_2.1" in n for n in names)
    assert {"KSampler", "LoadImage", "SaveImage"} <= set(d["requires"]["nodes"])


@pytest.mark.usefixtures("fresh_templates")
def test_edit_writes_a_user_copy_and_reset_removes_it():
    shipped = engines.ENGINES[HAT].path
    before = shipped.read_text("utf-8")
    e = engines.edit_template(HAT, {
        "label": "  Hat me  ",
        "inputs": {"prompt": {"default": "Give <image1> a top hat.", "examples": [{"label": "Top hat", "text": "Give <image1> a top hat."}, "Give <image1> a cap."]}},
    })
    assert e.label == "Hat me" and e.prompt == {"label": "Prompt", "required": True}
    assert e.default_prompt == "Give <image1> a top hat." and e.inputs[0]["label"] == "Image 1"
    assert e.origin == "user" and e.edited and e.default_inputs["image:1"].is_file()  # the sample stays where it shipped
    assert shipped.read_text("utf-8") == before
    saved = json.loads(e.path.read_text("utf-8"))
    assert not any("examples" in f for f in saved["inputs"])  # prompt ideas are gone: one sent by an old page is dropped
    refs = [f["default"] for f in saved["inputs"] if f["type"] == "image" and f.get("default")] + [saved[k] for k in ("cover", "cover_video") if saved.get(k)]
    assert refs and all(r.startswith("shipped:local/media/") for r in refs)  # no machine's absolute path: backups restore anywhere
    assert e.cover is not None and e.cover.is_file()

    again = engines.edit_template(HAT, {"blurb": "Second edit"})
    assert again.path == e.path and again.label == "Hat me"

    back = engines.reset_template(HAT)
    assert back.origin == "shipped" and not back.edited and back.label != "Hat me"
    assert not e.path.exists()


@pytest.mark.usefixtures("fresh_templates")
@pytest.mark.parametrize("patch", [
    {"label": "x" * 81},
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
    assert [x["text"] for x in w] == ["Add Video 1"]  # named by place, the way the prompt's <Video 1> refers to it
    w = engines.compose({"engine": SWAP, "inputs": [{"slot": "video:1", "asset": "v.mp4", "duration": 5}], "prompt": "the man", "params": {}})["warnings"]
    assert [x["text"] for x in w] == ["Add Image 1"]
    c = engines.compose({"engine": SWAP, "inputs": [{"slot": "image:1", "asset": "a.png"}, {"slot": "video:1", "asset": "v.mp4", "duration": 5}],
                         "prompt": "the man on the left", "params": {}})
    assert c["warnings"] == []
    t = c["template"]
    # The repo's v1 workflow: two loaders and its prompt box are all the template writes.
    assert t["137"]["inputs"]["image"] == "{{image:1}}" and t["139"]["inputs"]["file"] == "{{video:1}}"
    assert t["138"]["inputs"]["value"] == "the man on the left"
    assert t["123"]["inputs"]["sampler_name"] == "res_multistep" and t["143"]["inputs"]["value"] == 20
    assert [f["key"] for f in e.fields] == ["video:1", "image:1", "prompt", "sound"]


def test_sample_clip_is_described_as_video_with_a_poster():
    e = engines.ENGINES[SWAP]
    d = {i["slot"]: i for i in engines.defaults_info(e)["inputs"]}
    v = d["video:1"]
    assert v["kind"] == "video" and v["duration"] > 2 and v["fps"] == 24 and v["poster"].endswith("&poster=1")
    assert d["image:1"]["kind"] == "image"
    p = engines.default_poster(SWAP, "video:1")
    assert p.suffix == ".webp" and p.is_file() and p.parent.parent == engines.paths.cache_dir()



@pytest.mark.parametrize("tid", [SWAP])
def test_a_swap_renders_at_the_clips_own_frame(tid):
    """The clip as prepared sets the frame: its shape, at the template's 0.4 MP unless you pick another size."""
    e = engines.ENGINES[tid]
    assert e.size["inputs"]["video:1"] == "0.4 MP" and e.size["multiple"] == 32
    wf = e.build({"inputs": [{"slot": "video:1"}, {"slot": "image:1"}], "prompt": "x", "params": {}})
    assert not any(n["class_type"] == "ResolutionSelector" for n in wf.values())
    ref = next(n for n in wf.values() if n["class_type"] == "MiniMaxH3ReferenceToVideo")["inputs"]
    size = wf[ref["width"][0]]
    assert ref["width"] == [ref["width"][0], 0] and ref["height"] == [ref["width"][0], 1]
    assert size["class_type"] == "GetImageSize" and wf[size["inputs"]["image"][0]]["class_type"] == "GetVideoComponents"


# ---- the template format ---------------------------------------------------------


def test_version_1_files_load_with_their_hidden_text_moved_into_the_prompt():
    wf = {"1": {"class_type": "LoadImage", "inputs": {"image": "x.png"}},
          "2": {"class_type": "StringConcatenate", "inputs": {"string_a": "Give <image1> ", "string_b": "", "delimiter": ""}},
          "3": {"class_type": "StringConcatenate", "inputs": {"string_a": ["2", 0], "string_b": ". Keep the rest.", "delimiter": ""}},
          "4": {"class_type": "Encode", "inputs": {"text": ["3", 0], "steps": 20}}}
    old = {"format": "openillusion.template", "id": "old", "label": "Old", "mode": "edit", "max_images": 2, "min_images": 1,
           "inputs": [{"slot": "image:1", "label": "Person", "size": "1 MP"}, {"slot": "image:2", "label": "Extra"}],
           "prompt": {"label": "Your hat", "hint": "a cap"}, "examples": ["a cap"], "defaults": {"prompt": "a beret", "inputs": {"image:1": "p.png"}},
           "instruction": {"start": ["2", "string_a"], "end": ["3", "string_b"]},
           "params": [{"key": "steps", "label": "Steps", "type": "int", "default": 20}],
           "bindings": {"image:1": [["1", "image"]], "prompt": [["2", "string_b"]], "params.steps": [["4", "steps", "int"]]},
           "workflow": wf}
    e = engines.load_template(old)
    assert [(f["key"], f.get("required")) for f in e.fields] == [("image:1", True), ("image:2", False), ("prompt", True), ("steps", None)]
    assert e.default_prompt == "Give <image1> a beret. Keep the rest."
    assert not any("examples" in f for f in e.fields)  # its prompt ideas are dropped
    assert e.min_images == 1 and e.max_images == 2 and e.inputs[0] == {"slot": "image:1", "label": "Image 1", "size": "1 MP"}
    assert e.size["inputs"] == {"image:1": "1 MP", "image:2": "Original"}  # a size the template names is the input's default
    wf = e.build({"inputs": [{"slot": "image:1"}], "prompt": "Give <image1> a cap.", "params": {"steps": 9}})
    # The fixed text now lives in the prompt; the workflow's own copy is empty, so it isn't sent twice.
    assert wf["2"]["inputs"]["string_a"] == "" and wf["2"]["inputs"]["string_b"] == "Give <image1> a cap." and wf["3"]["inputs"]["string_b"] == ""
    assert wf["4"]["inputs"]["steps"] == 9 and "2" in wf
    assert old["workflow"]["2"]["inputs"]["string_a"] == "Give <image1> "  # the file as loaded is left alone

    wrapped = {"format": "openillusion.template", "id": "w", "label": "W", "kind": "cloud", "model": "a/b", "body": {"prompt": ""}, "built": True,
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
        engines.load_template({"format": "openillusion.template", "version": 2, "id": "x", "label": "X", "inputs": bad, "workflow": {}})


@pytest.mark.parametrize("label", [None, "", "   ", " · Qwen Image 2.1"])
def test_a_template_without_a_title_is_refused(label):
    t = {"format": "openillusion.template", "version": 2, "id": "x", "workflow": {}, "inputs": []}
    if label is not None:
        t["label"] = label
    with pytest.raises(ValueError, match="label"):
        engines.load_template(t)


def test_a_template_without_a_prompt_runs_without_one():
    e = engines.load_template({"format": "openillusion.template", "version": 2, "id": "up", "label": "Up", "workflow": {"1": {"class_type": "LoadImage", "inputs": {"image": ""}}},
                               "inputs": [{"key": "image:1", "type": "image", "label": "Photo", "bind": [["1", "image"]]}]})
    engines.ENGINES[e.id] = e
    try:
        w = engines.compose({"engine": e.id, "inputs": [{"slot": "image:1", "asset": "a.png"}], "prompt": "", "params": {}})["warnings"]
        assert w == [] and e.prompt is None
    finally:
        engines.ENGINES.pop(e.id)


def test_variants_only_when_the_workflow_rerolls_its_seed():
    assert engines.describe(engines.ENGINES["local/qwen21-create"])["varies"] is False  # its seed is fixed
    assert engines.describe(engines.ENGINES[HAT])["varies"] is True


def test_the_prompt_is_sent_exactly_as_written():
    wf = engines.ENGINES[HAT].build({"inputs": [{"slot": "image:1"}], "prompt": "A cap.", "params": {}})
    assert wf["5"]["inputs"]["prompt"] == "A cap."


@pytest.mark.parametrize("tid", ["local/minimax-h3-character-swap"])
def test_a_local_swap_can_keep_the_clips_own_sound(tmp_path, tid):
    from types import SimpleNamespace as NS
    from server import jobs
    e = engines.get(tid)
    assert engines.sound_from(e, {}) is None  # Make new: H3's own sound
    assert engines.sound_from(e, {"sound": "new"}) is None
    assert engines.sound_from(e, {"sound": "clip"}) == "video:1"
    m = NS(engine=NS(model=tid), params={"sound": "clip"}, inputs=[NS(slot="image:1", file="in/a.png"), NS(slot="video:1", file="in/v.mp4")])
    assert jobs._kept_sound(m, tmp_path) == tmp_path / "in/v.mp4"


def test_a_title_that_carries_its_model_keeps_the_name():
    # Files once wrote "Name · Model": a workflow keeps the model as model_name, a Router template's is its model's own.
    raw = json.loads(engines.ENGINES[HAT].path.read_text("utf-8"))
    raw.pop("model_name", None)
    e = engines.load_template({**raw, "label": "Add a hat · Qwen Image 2.1"}, engines.ENGINES[HAT].path.parent)
    assert e.label == "Add a hat" and engines.model_name(e) == "Qwen Image 2.1"
    e = engines.load_template({**raw, "label": "Add a hat"}, engines.ENGINES[HAT].path.parent)
    assert engines.model_name(e) == "ComfyUI workflow"
    tti = engines.ENGINES["cloud/text-to-image-seedream-5-0-pro"]
    c = engines.load_template({**json.loads(tti.path.read_text("utf-8")), "label": "Text to Image · Something else"}, tti.path.parent)
    assert c.label == "Text to Image" and engines.model_name(c) == "Seedream 5.0 Pro" and not c.model_name


def test_shipped_titles_are_names_only(fresh_templates):
    for e in engines.ENGINES.values():
        if e.origin == "shipped":
            assert " · " not in json.loads(e.path.read_text("utf-8"))["label"], e.id
            assert engines.model_name(e) not in ("", "ComfyUI workflow"), e.id


def test_a_workflows_model_is_edited_like_its_name(fresh_templates):
    e = engines.edit_template(HAT, {"model_name": "  Qwen Image 2.1 Edit  "})
    assert engines.model_name(e) == "Qwen Image 2.1 Edit" and e.label == "Add a hat" and e.edited
    assert engines.describe(e)["workflow_model"] == "Qwen Image 2.1 Edit"
    tti = engines.edit_template("cloud/text-to-image-seedream-5-0-pro", {"model_name": "Mine"})
    assert engines.model_name(tti) == "Seedream 5.0 Pro"  # a Router model names itself
