"""Inputs fitted to what each model takes: shape, sides, length, totals, file size."""

import wave

import pytest
from PIL import Image

from server import adapters, builder, engines, fit, media, prep, staging
from server import paths

from conftest import make_image, make_video

KLING = "kling/kling-v3-omni"
WAN = "wan/wan3.0-video"
NANO = "vertexai/gemini-nano-banana-2.1"
KL_IMG = {"short": [300.0, None], "aspect": [0.4, 2.5], "mb": 10.0}


def whole(w, h):
    return prep.Plan(source=(w, h), box=(0.0, 0.0, float(w), float(h)), width=w, height=h)


def test_too_wide_is_cropped_in_the_middle_then_scaled_up():
    p, notes = fit.plan(whole(1000, 200), KL_IMG)
    assert (p.width, p.height) == (750, 300) and p.box == (250.0, 0.0, 750.0, 200.0)
    assert notes == ["cropped to 5:2", "scaled up to 750×300"]


def test_too_big_is_scaled_down_to_even_sides_for_video():
    p, notes = fit.plan(whole(3840, 2160), {"short": [720.0, None], "long": [None, 2160.0]}, even=True)
    assert (p.width, p.height) == (2160, 1214) and notes == ["scaled down to 2160×1214"]


def test_what_already_fits_is_left_alone():
    p = whole(1024, 768)
    assert fit.plan(p, KL_IMG) == (p, []) and fit.plan(p, {}) == (p, [])


def test_spans_cut_long_clips_and_refuse_short_ones():
    assert fit.span(15, None, (3, 10)) == (0, 10, "runs 10 s of it", None)
    assert fit.span(15, [2, 0], (3, 10))[:3] == (2, 12, "runs 10 s of it (2–12 s)")
    assert fit.span(8, None, (3, 10)) == (0, 8, None, None)
    assert fit.span(2, None, (3, 10))[3] == "is 2.0 s; it needs at least 3 s"
    assert fit.span(10, None, (None, None), left=5)[:2] == (0, 5)  # what a total leaves


@pytest.mark.parametrize("bad, why", [
    ({"aspect": [2.5, 0.4]}, "least first"),
    ({"short": [0, None]}, "above 0"),
    ({"short": [None, None]}, "above 0"),
    ({"sides": [1, 2]}, "fit takes"),
    ({"mb": -1}, "above 0"),
])
def test_bad_fits_are_refused(bad, why):
    with pytest.raises(ValueError, match=why):
        fit.check(bad, "x")


def test_an_adapter_photo_has_no_seconds():
    d = {"model": "a/b", "makes": "photo", "body": {}, "prompt": ["p"], "result": [["r"]],
         "inputs": [{"role": "Photo", "type": "image", "at": ["i"], "value": "{{$|uri}}", "fit": {"seconds": [1, 2]}}]}
    with pytest.raises(adapters.AdapterError, match="no seconds"):
        adapters.parse(d)


def test_every_adapter_names_its_family_and_limits():
    assert adapters.for_model("wan/happyhorse-1.1-i2v").model == "wan/happyhorse-1.1"
    assert adapters.for_model("nobody/none") is None
    assert adapters.get(NANO).media_mb == 14


def _template(model, inputs):
    a = adapters.get(model)
    rows = [{"input": next(k for k, x in enumerate(a.inputs) if x["role"] == r), "kind": a.inputs[[x["role"] for x in a.inputs].index(r)]["type"]}
            for r in inputs]
    tid = builder.save(builder.assemble_cloud({"model": model, "label": "Fit", "media": rows, "prompt": {"default": "go"}}), {})
    engines.reload_templates()
    return tid


def _upload(name, path):
    dst = paths.uploads_dir() / name
    dst.write_bytes(path.read_bytes())
    return name


def test_a_kling_first_frame_is_made_big_enough_and_its_clip_cut(tmp_path):
    tid = _template(KLING, ["First frame"])
    e = engines.get(tid)
    assert fit.of(e, "image:1") == KL_IMG  # found from the request, not stored in the template
    a = _upload("small.png", make_image(tmp_path / "small.png", (400, 100)))
    fx = staging.fitted({"engine": tid, "inputs": [{"slot": "image:1", "asset": a}], "prompt": "go", "params": {}})
    p = fx.plans["image:1"]
    assert p.width / p.height == pytest.approx(2.5, abs=0.01) and min(p.width, p.height) >= 300
    assert fx.notes and fx.notes[0]["level"] == "info" and "cropped to 5:2" in fx.notes[0]["text"] and "Kling" in fx.notes[0]["text"]
    assert fx.bytes["image:1"] <= 10_000_000


def test_kling_clips_have_its_length_and_frame_rates(tmp_path):
    tid = _template(KLING, ["Video to edit"])
    e = engines.get(tid)
    assert engines.clip_limits(e, "video:1") == ((3.0, 10.0), (24.0, 60.0))
    info = engines.describe(e)["fields"][0]
    assert info["window"] == [3.0, 10.0] and info["fps"] == [24.0, 60.0] and info["fit"]["short"] == [720.0, None]
    a = _upload("short.mp4", make_video(tmp_path / "short.mp4", seconds=1))
    fx = staging.fitted({"engine": tid, "inputs": [{"slot": "video:1", "asset": a}], "prompt": "go", "params": {}})
    assert [n["text"] for n in fx.errors] == ["Video 1 is 1.0 s; it needs at least 3 s"]


def test_wan_reference_clips_share_fifteen_seconds(tmp_path):
    tid = _template(WAN, ["Reference video", "Reference video"])
    a = _upload("ten.mp4", make_video(tmp_path / "ten.mp4", seconds=10, fps=8, size=(160, 120)))
    spec = {"engine": tid, "inputs": [{"slot": "video:1", "asset": a}, {"slot": "video:2", "asset": a}], "prompt": "go", "params": {}}
    fx = staging.fitted(spec)
    assert fx.spans["video:1"] == pytest.approx((0, 10), abs=0.1) and fx.spans["video:2"] == pytest.approx((0, 5), abs=0.1)
    assert any(n["field"] == "video:2" and "runs 5 s" in n["text"] for n in fx.notes) and not fx.errors


def test_nano_banana_photos_share_its_request_limit(tmp_path):
    tid = _template(NANO, ["Photo"] * 4)
    a = _upload("p.png", make_image(tmp_path / "p.png"))
    fx = staging.fitted({"engine": tid, "inputs": [{"slot": f"image:{n}", "asset": a} for n in range(1, 5)], "prompt": "go", "params": {}})
    assert all(v == 14_000_000 // 4 for v in fx.bytes.values())


def test_a_photo_is_written_under_its_byte_limit(tmp_path):
    import random

    rnd = random.Random(1)
    img = Image.frombytes("RGB", (600, 600), bytes(rnd.getrandbits(8) for _ in range(600 * 600 * 3)))
    dst = media.save_image(img, tmp_path / "noise", 60_000)
    assert dst.suffix == ".jpg" and dst.stat().st_size <= 60_000
    assert media.save_image(Image.new("RGBA", (64, 64)), tmp_path / "clear").suffix == ".png"


def test_a_sound_is_cut_and_written_as_mp3(tmp_path):
    src = tmp_path / "v.wav"
    with wave.open(str(src), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(8000), w.writeframes(bytes(2) * 8000 * 3)
    info = media.transcode_audio(src, tmp_path / "v.mp3", start=1.0, end=2.0)
    assert info["duration"] == pytest.approx(1.0, abs=0.1) and (tmp_path / "v.mp3").read_bytes()[:3] == b"ID3"
