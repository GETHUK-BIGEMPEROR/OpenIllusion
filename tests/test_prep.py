import math

import pytest
from PIL import Image

from server import engines, jobs, paths, prep

QWEN = {"multiple": 32}


def qwen_node_size(w, h, res):
    """TextEncodeQwenImage21's own resize, copied from ComfyUI (comfy_extras/nodes_qwen.py)."""
    ratio = w / h
    return max(32, round(math.sqrt(res * res * ratio) / 32) * 32), max(32, round(math.sqrt(res * res / ratio) / 32) * 32)


@pytest.mark.parametrize("w,h", [(1024, 1536), (2959, 3564), (4000, 3000), (1920, 1080), (1080, 1920), (640, 960), (3000, 1000), (777, 1333), (1000, 1250)])
@pytest.mark.parametrize("px", [447, 632, 1000, 1024, 1414, 2048])
def test_target_keeps_the_shape_closer_than_the_qwen_node(w, h, px):
    tw, th = prep.target(w, h, px, 32)
    assert tw % 32 == 0 and th % 32 == 0 and abs(tw * th / px**2 - 1) <= 0.12
    nw, nh = qwen_node_size(w, h, px)
    assert abs(math.log(tw / th * h / w)) <= abs(math.log(nw / nh * h / w)) + 1e-9


def test_common_shapes_stay_true_at_1_mp():
    assert prep.target(1920, 1080, 1000, 32) == (1312, 736)
    assert prep.target(1080, 1920, 1000, 32) == (736, 1312)


def test_original_trims_to_the_multiple_without_resampling():
    p = prep.plan(1000, 750, px=0, multiple=32)
    assert (p.width, p.height) == (992, 736)
    assert p.box == (4.0, 7.0, 996.0, 743.0)  # centred, exact pixels
    img = Image.new("RGB", (1000, 750))
    img.putpixel((4, 7), (255, 0, 0))
    out = prep.apply(img, p)
    assert out.size == (992, 736) and out.getpixel((0, 0)) == (255, 0, 0)


def test_resize_never_stretches():
    p = prep.plan(4000, 3000, px=1024, multiple=32)
    l, t, r, b = p.box
    assert (p.width, p.height) == (1152, 864)  # exactly 4:3
    assert (r - l) / (b - t) == pytest.approx(p.width / p.height, rel=1e-9)
    assert 0 <= l and 0 <= t and r <= 4000 and b <= 3000


def test_crop_is_kept_and_sized():
    # The right half of a 4000x3000 photo, as fractions.
    p = prep.plan(4000, 3000, px=1024, multiple=32, crop=[0.5, 0, 0.5, 1])
    l, t, r, b = p.box
    assert l >= 2000 and r <= 4000 and t >= 0 and b <= 3000
    assert p.width < p.height  # 2000x3000 is portrait
    with pytest.raises(ValueError):
        prep.plan(4000, 3000, px=1024, multiple=32, crop=[0, 0, 0.001, 0.001])


def test_prepared_images_are_left_alone():
    first = prep.plan(2959, 3564, px=1024, multiple=32)
    again = prep.plan(first.width, first.height, px=1024, multiple=32)
    assert again.identity


def test_every_input_has_its_own_size():
    s = prep.spec_of(QWEN, [{"slot": "image:1", "size": "2 MP"}, {"slot": "image:2"}])
    imgs = [{"slot": "image:1", "width": 4000, "height": 3000}, {"slot": "image:2", "width": 6000, "height": 4000, "size": "1 MP"}]
    plans = prep.plans(s, imgs)
    assert plans["image:1"].width * plans["image:1"].height == pytest.approx(2e6, rel=0.12)  # its template default
    assert plans["image:2"].width * plans["image:2"].height == pytest.approx(1e6, rel=0.12)  # its own choice
    # Nothing chosen and no template default: the input keeps its own size, trimmed to the multiple, not resampled.
    plans = prep.plans(s, [{"slot": "image:2", "width": 1600, "height": 1200}])
    assert (plans["image:2"].width, plans["image:2"].height) == (1600, 1184)


def test_sizing_is_input_prep_only():
    # Without a declared size input there is no canvas: nothing gets written into the graph.
    for inputs in ([{"slot": "image:1"}], []):
        assert "canvas" not in prep.spec_of({"multiple": 32, "aspect": "4:5", "default": "1 MP"}, inputs)
    # An old size block's default no longer picks a size for an input.
    assert prep.spec_of({"default": "1 MP"}, [{"slot": "image:1"}])["inputs"] == {"image:1": "Original"}


def test_unknown_choice_falls_back_to_the_inputs_default():
    s = prep.spec_of(QWEN, [{"slot": "image:1", "size": "1 MP"}])
    assert prep.choice_of(s, "image:1", "nope") == "1 MP" and prep.choice_of(s, "image:9") == "Original"
    assert prep.budget(s, "Original") == 0 and prep.budget(s, "nope") == 0


def test_every_template_gets_the_same_steps_for_what_it_makes():
    s = prep.spec_of(None, [{"slot": "video:1"}, {"slot": "image:1"}], "motion")
    assert [o["label"] for o in s["options"]] == ["0.4 MP", "0.75 MP", "1 MP", "1.5 MP", "Original"]
    assert s["inputs"] == {"video:1": "Original", "image:1": "Original"}
    s = prep.spec_of({"options": [{"label": "1K", "px": 1024}], "multiple": 32}, [{"slot": "image:1", "size": "1K"}])
    assert [o["label"] for o in s["options"]] == ["0.5 MP", "1 MP", "2 MP", "3 MP", "Original"]  # a template's own list is ignored
    assert s["inputs"] == {"image:1": "Original"}


@pytest.mark.parametrize("mode,mp", [("edit", 3), ("motion", 1.5)])
def test_inputs_are_capped_unless_the_cap_is_lifted(mode, mp):
    s = prep.spec_of(None, [{"slot": "image:1"}], mode)
    big = [{"slot": "image:1", "width": 6000, "height": 4000}]
    p = prep.plans(s, big)["image:1"]
    assert p.width * p.height == pytest.approx(mp * 1e6, rel=0.12) and p.width / p.height == pytest.approx(1.5, rel=0.03)  # Original, scaled down
    small = prep.plans(s, [{"slot": "image:1", "width": 960, "height": 640}])["image:1"]
    assert (small.width, small.height) == (960, 640)  # under the cap: untouched
    free = prep.limit(s, True)
    assert free["cap"] == 0 and len(free["options"]) == 7 and free["options"][-1]["label"] == "Original"
    p = prep.plans(free, big)["image:1"]
    assert (p.width, p.height) == (6000, 4000)  # full size
    assert prep.limit(s, False) is s


def _upload(name, size):
    Image.new("RGB", size, (90, 120, 150)).save(paths.uploads_dir() / name)
    return name


def test_runs_get_prepared_images_and_record_how():
    spec = {
        "engine": "local/qwen21-hold-product", "prompt": "",
        "inputs": [{"slot": "image:1", "role": "base", "asset": _upload("p.png", (3000, 4000)), "crop": [0, 0, 1, 0.75]},
                   {"slot": "image:2", "role": "reference", "asset": _upload("c.png", (5000, 5000))}],
        "params": {"size": "1 MP", "steps": 4, "seed": 1},
    }
    planned = jobs.input_plans(spec)
    m = jobs.prepare_generation(spec)
    folder = paths.user_root() / "generations" / m.id
    one, two = m.inputs
    with Image.open(folder / one.file) as a, Image.open(folder / two.file) as b:
        assert a.size == (992, 992)  # the top 3000x3000 of the portrait, at 1 MP
        assert b.size == (992, 992)
    assert one.prep == {**planned["image:1"].to_dict(), "size": "1 MP"} and one.prep["source"] == [3000, 4000]
    assert two.prep["size"] == "1 MP"  # its template default
    assert (one.width, one.height) == (992, 992)
    # The encoder takes images as they come: the app already sized them.
    assert m.request_template["5"]["inputs"]["resolution"] == 0


def test_exif_rotation_is_applied(tmp_path):
    img = Image.new("RGB", (400, 300))
    exif = img.getexif()
    exif[0x0112] = 6  # rotate 90° clockwise to view
    img.save(paths.uploads_dir() / "phone.jpg", exif=exif)
    from server import media

    assert media.image_size(paths.uploads_dir() / "phone.jpg") == (300, 400)
    assert media.open_image(paths.uploads_dir() / "phone.jpg").size == (300, 400)


def test_shipped_templates_only_write_what_they_declare():
    for e in engines.ENGINES.values():
        if e.kind != "local" or e.origin != "shipped":
            continue
        assert e.size["multiple"] == 32 and "follows" not in (e.data.get("size") or {}) and "computed" not in e.data, e.id
        # A template that takes no photo or clip declares its output size; the rest leave sizing to their workflow.
        out = next((f for f in e.fields if f["type"] == "size"), None)
        assert bool(out) == (not e.inputs) == ("canvas" in e.size), e.id
        if out:
            assert {b[2] for b in out["bind"]} == {"width", "height"} and all(str(b[0]) in e.workflow for b in out["bind"]), e.id
        assert not any(p["key"] in ("resolution", "size") for p in e.params), e.id


# ---- template defaults: samples and prompt -------------------------------------


def test_every_template_opens_ready_to_run():
    for e in engines.ENGINES.values():
        if e.kind != "local" or e.origin != "shipped":
            continue
        d = engines.describe(e)["defaults"]
        assert d["prompt"].strip(), e.id
        want = [f"image:{n}" for n in range(1, e.max_images + 1)] + (["video:1"] if e.needs_video else [])
        assert sorted(i["slot"] for i in d["inputs"]) == sorted(want), e.id
        spec = {"engine": e.id, "prompt": d["prompt"], "params": {}, "inputs": [{"slot": i["slot"], "asset": i["asset"], "duration": i.get("duration")} for i in d["inputs"]]}
        assert not [w for w in engines.compose(spec)["warnings"] if w["level"] == "error"], e.id


def test_samples_resolve_like_uploads():
    e = engines.ENGINES["local/qwen21-hold-product"]
    a = engines.describe(e)["defaults"]["inputs"][1]
    assert a["asset"] == "tpl:local/qwen21-hold-product|image:2"
    assert jobs.resolve_asset(a["asset"]).name == "instant-camera.jpg"
    with pytest.raises(FileNotFoundError):
        jobs.resolve_asset("tpl:local/qwen21-hold-product|image:9")
    with pytest.raises(FileNotFoundError):
        jobs.resolve_asset("tpl:local/nope|image:1")


def test_a_run_on_samples_copies_them_into_the_generation():
    e = engines.ENGINES["local/qwen21-add-hat"]
    d = engines.describe(e)["defaults"]
    m = jobs.prepare_generation({"engine": e.id, "prompt": d["prompt"], "params": {"size": "1 MP"},
                                 "inputs": [{"slot": "image:1", "asset": d["inputs"][0]["asset"]}]})
    with Image.open(paths.user_root() / "generations" / m.id / m.inputs[0].file) as img:
        assert img.size == (m.inputs[0].prep["width"], m.inputs[0].prep["height"])
    assert m.prompt == e.default_prompt and "straw fedora with a black band" in m.prompt


def test_default_prompt_is_editable_and_samples_stay_put():
    e = engines.edit_template("local/qwen21-add-hat", {"inputs": {"prompt": {"default": "  Put a red beret on <image1>.  "}}})
    d = engines.describe(e)["defaults"]
    assert d["prompt"] == "Put a red beret on <image1>." and e.edited
    assert jobs.resolve_asset(d["inputs"][0]["asset"]).name == "man-park.jpg"  # still the shipped file
    engines.reset_template(e.id)
    assert "straw fedora with a black band" in engines.describe(engines.ENGINES[e.id])["defaults"]["prompt"]


def test_every_template_ships_its_cover_and_samples():
    for e in engines.ENGINES.values():
        if e.kind == "local":
            assert e.cover and e.cover.is_file(), e.id  # the result of running it on its defaults
            assert all(p.is_file() for p in e.default_inputs.values()), e.id
            assert engines.describe(e)["cover"], e.id


def test_clips_are_cropped_and_sized_like_photos(tmp_path):
    from server import media
    from tests.conftest import make_video

    src = make_video(tmp_path / "in.mp4", seconds=1.0, size=(640, 360))
    p = prep.plan(640, 360, px=300, multiple=32, crop=[0.25, 0, 0.75, 1])  # a centred portrait-ish cut
    info = media.transcode(src, tmp_path / "out.mp4", plan=p)
    assert (info["width"], info["height"]) == (p.width, p.height)
    assert media.probe(tmp_path / "out.mp4")["width"] == p.width


def test_area_boxes_follow_the_crop():
    from server import engines as en

    b = en.boxes_in_crop([{"rect": [0.5, 0.25, 0.25, 0.25], "label": "hat"}], [0.25, 0, 0.5, 1])
    assert b[0]["rect"] == [0.5, 0.25, 0.5, 0.25] and b[0]["target"] is None


def test_clips_kept_at_their_own_size_are_cut_not_resampled(tmp_path):
    from server import media
    from tests.conftest import make_video

    src = make_video(tmp_path / "in.mp4", seconds=1.0, size=(640, 360))
    p = prep.plan(640, 360, px=0, multiple=32, crop=[0.25, 0, 0.5, 1])
    assert p.trim_only and (p.width, p.height) == (320, 352)
    info = media.transcode(src, tmp_path / "out.mp4", plan=p)
    assert (info["width"], info["height"]) == (320, 352)


def test_templates_without_inputs_make_their_own_canvas():
    s = prep.spec_of({"multiple": 32}, [], "edit", {"aspect": "4:5", "default": "1 MP"})
    assert s["canvas"] == {"aspects": list(prep.ASPECTS), "aspect": "4:5", "size": "1 MP"}
    w, h = prep.canvas_size(s, None, None)  # the template's defaults
    assert w % 32 == 0 and h % 32 == 0 and w / h == pytest.approx(0.8, rel=0.03) and w * h == pytest.approx(1e6, rel=0.12)
    w, h = prep.canvas_size(s, "16:9", "3 MP")
    assert w / h == pytest.approx(16 / 9, rel=0.03) and w * h == pytest.approx(3e6, rel=0.12)
    assert prep.canvas_size(s, "7:1", "6 MP") == prep.canvas_size(s, None, None)  # not offered: defaults
    assert prep.canvas_size(prep.limit(s, True), "1:1", "6 MP")[0] > 2300  # offered once the cap is lifted
    assert prep.canvas_size(s, "1:1", "Original") == prep.canvas_size(s, "1:1", "1 MP")  # Original means nothing for a canvas
    v = prep.spec_of({}, [], "motion", {"aspect": "16:9", "default": "Original"})
    assert v["canvas"]["size"] == "0.75 MP"


def test_the_kept_box_never_leaves_the_picture():
    p = prep.plan(1088, 1376, px=632, multiple=32)  # float error once put the top at -1e-13
    l, t, r, b = p.box
    assert l >= 0 and t >= 0 and r <= 1088 and b <= 1376
    prep.apply(Image.new("RGB", (1088, 1376)), p)
