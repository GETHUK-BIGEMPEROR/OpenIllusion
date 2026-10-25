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


@pytest.mark.parametrize("w,h", [(1024, 1536), (2959, 3564), (4000, 3000), (1920, 1080), (640, 960), (3000, 1000), (777, 1333)])
@pytest.mark.parametrize("px", [1024, 1536, 2048])
def test_target_matches_the_qwen_node(w, h, px):
    assert prep.target(w, h, px, 32) == qwen_node_size(w, h, px)


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
    assert (p.width, p.height) == (1184, 896)
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


def test_references_share_the_budget():
    imgs = [{"slot": "image:1", "width": 4000, "height": 3000}, {"slot": "image:2", "width": 6000, "height": 4000}]
    plans = prep.plans(prep.spec_of(QWEN), "1K", imgs)
    assert (plans["image:1"].width, plans["image:1"].height) == (1184, 896)
    assert plans["image:2"].width * plans["image:2"].height <= 1.1 * 1024 * 1024
    # Original: the reference gets the main picture's area, never its own 24 MP.
    plans = prep.plans(prep.spec_of(QWEN), "Original", imgs)
    lead = plans["image:1"]
    assert (lead.width, lead.height) == (4000, 2976)
    assert plans["image:2"].width * plans["image:2"].height <= 1.1 * lead.width * lead.height


def test_unknown_choice_falls_back_to_default():
    assert prep.budget(prep.spec_of(QWEN), "nope") == 1024
    assert prep.budget(prep.spec_of(QWEN), None) == 1024


def _upload(name, size):
    Image.new("RGB", size, (90, 120, 150)).save(paths.uploads_dir() / name)
    return name


def test_runs_get_prepared_images_and_record_how():
    spec = {
        "engine": "local/qwen21-hold-product", "prompt": "",
        "inputs": [{"slot": "image:1", "role": "base", "asset": _upload("p.png", (3000, 4000)), "crop": [0, 0, 1, 0.75]},
                   {"slot": "image:2", "role": "reference", "asset": _upload("c.png", (5000, 5000))}],
        "params": {"size": "1K", "steps": 4, "seed": 1},
    }
    planned = jobs.input_plans(spec)
    m = jobs.prepare_generation(spec)
    folder = paths.user_root() / "generations" / m.id
    one, two = m.inputs
    with Image.open(folder / one.file) as a, Image.open(folder / two.file) as b:
        assert a.size == (1024, 1024)  # the top 3000x3000 of the portrait
        assert b.size == (1024, 1024)
    assert one.prep == planned["image:1"].to_dict() and one.prep["source"] == [3000, 4000]
    assert (one.width, one.height) == (1024, 1024)
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
    m = jobs.prepare_generation({"engine": e.id, "prompt": d["prompt"], "params": {"size": "1K"},
                                 "inputs": [{"slot": "image:1", "asset": d["inputs"][0]["asset"]}]})
    with Image.open(paths.user_root() / "generations" / m.id / m.inputs[0].file) as img:
        assert img.size == (m.inputs[0].prep["width"], m.inputs[0].prep["height"])
    assert m.prompt == "straw fedora with a black band"


def test_default_prompt_is_editable_and_samples_stay_put():
    e = engines.edit_template("local/qwen21-add-hat", {"default_prompt": "  red beret  "})
    d = engines.describe(e)["defaults"]
    assert d["prompt"] == "red beret" and e.edited
    assert jobs.resolve_asset(d["inputs"][0]["asset"]).name == "man-grey.jpg"  # still the shipped file
    engines.reset_template(e.id)
    assert engines.describe(engines.ENGINES[e.id])["defaults"]["prompt"] == "straw fedora with a black band"


def test_every_template_ships_its_cover_and_samples():
    for e in engines.ENGINES.values():
        if e.kind == "local":
            assert e.cover and e.cover.is_file(), e.id  # the result of running it on its defaults
            assert all(p.is_file() for p in e.default_inputs.values()), e.id
            assert engines.describe(e)["cover"], e.id
