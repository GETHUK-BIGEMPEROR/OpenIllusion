"""The media editor: crop, turn, resize, cut, resample, mute; and uploads in other formats."""

import wave

import aiohttp
import pytest
from PIL import Image

from server import edit, media, paths

from conftest import make_image, make_video
from test_crud import call


def _up(name, path):
    dst = paths.uploads_dir() / name
    dst.write_bytes(path.read_bytes())
    return dst


def _wav(path, seconds=3):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1), w.setsampwidth(2), w.setframerate(8000), w.writeframes(bytes(2) * 8000 * seconds)
    return path


def test_a_photo_is_turned_cropped_and_sized(tmp_path):
    src = tmp_path / "p.png"
    img = Image.new("RGB", (400, 200), (255, 0, 0))
    img.paste((0, 0, 255), (0, 0, 100, 200))  # blue left quarter
    img.save(src)
    out = edit.edit(_up("p.png", src), {"rotate": 90, "crop": [0, 0.5, 1, 0.5], "width": 100})
    got = Image.open(out)
    # Turned clockwise the blue strip is on top; the bottom half kept is all red.
    assert out.suffix == ".png" and got.size == (100, 100) and got.getpixel((50, 10))[:3] == (255, 0, 0)
    assert out.parent == paths.uploads_dir() and src.exists()


def test_a_photo_flips_and_keeps_jpeg(tmp_path):
    src = tmp_path / "p.jpg"
    img = Image.new("RGB", (64, 32), (255, 255, 255))
    img.paste((0, 0, 0), (0, 0, 16, 32))
    img.save(src, quality=95)
    out = edit.edit(_up("p.jpg", src), {"flip": "h"})
    got = Image.open(out)
    assert out.suffix == ".jpg" and got.size == (64, 32) and sum(got.getpixel((60, 16))) < 60


def test_a_clip_is_cut_resampled_turned_and_muted(tmp_path):
    src = _up("c.mp4", make_video(tmp_path / "c.mp4", seconds=3, fps=24, size=(320, 240)))
    out = edit.edit(src, {"start": 0.5, "end": 2.5, "fps": 12, "rotate": 90, "width": 120, "mute": True})
    info = media.probe(out)
    assert (info["width"], info["height"]) == (120, 160) and info["fps"] == pytest.approx(12, abs=0.1)
    assert info["duration"] == pytest.approx(2.0, abs=0.15) and not info["has_audio"]


def test_a_sound_is_cut(tmp_path):
    out = edit.edit(_up("v.wav", _wav(tmp_path / "v.wav")), {"start": 1, "end": 2})
    assert out.suffix == ".mp3" and media.audio_info(out)["duration"] == pytest.approx(1.0, abs=0.1)


@pytest.mark.parametrize("ops, why", [
    ({"rotate": 45}, "Rotate"),
    ({"flip": "x"}, "Flip"),
    ({"crop": [0, 0]}, "Crop"),
    ({"width": 4}, "Width"),
    ({"start": 2, "end": 2}, "at least"),
    ({"fps": 500}, "Frame rate"),
])
def test_bad_edits_are_refused(tmp_path, ops, why):
    with pytest.raises(edit.EditError, match=why):
        edit.edit(_up("p.png", make_image(tmp_path / "p.png")), ops)


def test_other_formats_are_turned_into_ones_the_app_takes(tmp_path):
    tif = tmp_path / "a.tiff"
    Image.new("RGB", (40, 30)).save(tif)
    png = edit.normalize(_up("a.tiff", tif))
    assert png.suffix == ".png" and Image.open(png).size == (40, 30) and not (paths.uploads_dir() / "a.tiff").exists()

    gif = tmp_path / "a.gif"
    frames = [Image.new("RGB", (41, 30), (n * 40, 0, 0)) for n in range(5)]
    frames[0].save(gif, save_all=True, append_images=frames[1:], duration=100, loop=0)
    mp4 = edit.normalize(_up("a.gif", gif))
    info = media.probe(mp4)
    assert mp4.suffix == ".mp4" and (info["width"], info["height"]) == (40, 30) and info["fps"] == pytest.approx(10, abs=0.1)

    still = tmp_path / "s.gif"
    Image.new("RGB", (20, 20)).save(still)
    assert edit.normalize(_up("s.gif", still)).suffix == ".png"


def test_upload_converts_and_the_edit_route_makes_a_new_file(tmp_path):
    bmp = tmp_path / "shot.bmp"
    Image.new("RGB", (64, 48), (10, 20, 30)).save(bmp)

    async def go(c):
        fd = aiohttp.FormData()
        fd.add_field("file", bmp.read_bytes(), filename="shot.bmp", content_type="image/bmp")
        up = await (await c.post("/api/upload", data=fd)).json()
        r = await c.post("/api/media/edit", json={"asset": up["asset"], "name": up["name"], "ops": {"crop": [0, 0, 0.5, 1]}})
        bad = await c.post("/api/media/edit", json={"asset": up["asset"], "ops": {"rotate": 10}})
        gone = await c.post("/api/media/edit", json={"asset": "nope.png", "ops": {}})
        return up, await r.json(), bad.status, gone.status

    up, done, bad, gone = call(go)
    assert up["asset"].endswith(".png") and up["name"] == "shot.png" and up["kind"] == "image"
    assert done["name"] == "shot-edited.png" and (done["width"], done["height"]) == (32, 48) and done["asset"] != up["asset"]
    assert (paths.uploads_dir() / up["asset"]).exists() and bad == 400 and gone == 404
