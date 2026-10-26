import math

import pytest
from PIL import Image

from server import engines, jobs, paths, prep

QWEN = {"options": [{"label": "1K", "px": 1024}, {"label": "2K", "px": 2048}, {"label": "Original", "px": 0}],
        "default": "1K", "multiple": 32, "follows": "image:1"}


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
    s = prep.spec_of(QWEN, [{"slot": "image:1", "size": "2K"}, {"slot": "image:2"}])
    imgs = [{"slot": "image:1", "width": 4000, "height": 3000}, {"slot": "image:2", "width": 6000, "height": 4000, "size": "1K"}]
    plans = prep.plans(s, imgs)
    assert plans["image:1"].width * plans["image:1"].height == pytest.approx(2048**2, rel=0.12)  # its template default
    assert (plans["image:2"].width, plans["image:2"].height) == (1248, 832)  # its own choice
    # Nothing chosen and no template default: the input keeps its own size.
    plans = prep.plans(s, [{"slot": "image:2", "width": 6000, "height": 4000}])
    assert (plans["image:2"].width, plans["image:2"].height) == (5984, 4000)  # trimmed to the multiple, not resampled


def test_a_run_wide_size_from_older_drafts_sizes_the_followed_input():
    s = prep.spec_of(QWEN, [{"slot": "image:1"}, {"slot": "image:2"}])
    assert s["inputs"] == {"image:1": "1K", "image:2": "Original"}  # the old run-wide default lands on image:1
    plans = prep.plans(s, [{"slot": "image:1", "width": 4000, "height": 3000}, {"slot": "image:2", "width": 800, "height": 600}], legacy="2K")
    assert plans["image:1"].width > 2000 and (plans["image:2"].width, plans["image:2"].height) == (800, 576)


def test_unknown_choice_falls_back_to_the_inputs_default():
    s = prep.spec_of(QWEN, [{"slot": "image:1"}])
    assert prep.choice_of(s, "image:1", "nope") == "1K" and prep.choice_of(s, "image:9") == "Original"
    assert prep.budget(s, "Original") == 0 and prep.budget(s, "nope") == 0


def test_templates_without_sizes_get_the_generic_list():
    s = prep.spec_of(None, [{"slot": "video:1"}, {"slot": "image:1"}])
    assert [o["label"] for o in s["options"]] == ["0.5 MP", "1 MP", "2 MP", "4 MP", "Original"]
    assert s["follows"] == "video:1" and s["inputs"] == {"video:1": "Original", "image:1": "Original"}


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


def test_shipped_templates_declare_a_size():
    for e in engines.ENGINES.values():
        if e.kind == "local" and e.id.startswith("local/qwen21-"):
            assert e.size and e.size["multiple"] == 32 and e.size["follows"] == "image:1", e.id
            assert not any(p["key"] == "resolution" for p in e.params), e.id


# ---- template defaults: samples and prompt -------------------------------------


def test_every_template_opens_ready_to_run():
    for e in engines.ENGINES.values():
        if e.kind != "local":
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
    assert jobs.resolve_asset(a["asset"]).name == "camera.jpg"
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
    assert jobs.resolve_asset(d["inputs"][0]["asset"]).name == "man-grey.jpg"  # still the shipped file
    engines.reset_template(e.id)
    assert "straw fedora with a black band" in engines.describe(engines.ENGINES[e.id])["defaults"]["prompt"]


def test_every_template_ships_its_cover_and_samples():
    for e in engines.ENGINES.values():
        if e.kind == "local":
            assert e.cover and e.cover.is_file(), e.id  # the result of running it on its defaults
            assert all(p.is_file() for p in e.default_inputs.values()), e.id
            assert engines.describe(e)["cover"], e.id


def test_options_can_be_given_in_megapixels():
    s = prep.spec_of({"options": [{"mp": 0.5}, {"label": "1 MP", "mp": 1}]}, [{"slot": "image:1", "size": "1 MP"}])
    assert [o["label"] for o in s["options"]] == ["0.5 MP", "1 MP", "Original"]  # Original is always offered
    assert [o["px"] for o in s["options"]] == [707, 1000, 0] and s["inputs"] == {"image:1": "1 MP"}
    assert prep.target(1920, 1080, 1000, 32) == (1312, 736)


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
