"""What leaves the library leaves without dates: files cleaned of their stamps, exports undated,
a generation without its history, a template without your Builder's state."""

import io
import json
import struct
import zipfile

import av
import numpy as np
import pytest
from PIL import Image

from server import archive, backup, bundle, engines, paths, scrub, settings, store, template_pack, usage
from server import generation as sc

from conftest import make_video

HAT = "local/qwen21-add-hat"


def exif(orientation=1):
    e = Image.Exif()
    e[0x0132] = "2024:05:01 10:00:00"  # DateTime
    e[0x0112] = orientation
    return e.tobytes()


def photo(fmt, **kw):
    buf = io.BytesIO()
    img = Image.new("RGB", (40, 20), (200, 80, 40))
    img.save(buf, fmt, **kw)
    return buf.getvalue()


def test_jpeg_loses_exif_and_keeps_its_pixels():
    raw = photo("JPEG", exif=exif(), quality=90)
    out = scrub.clean(raw, "a.jpg")
    assert b"2024:05:01" in raw and b"2024:05:01" not in out
    assert Image.open(io.BytesIO(out)).tobytes() == Image.open(io.BytesIO(raw)).tobytes()


def test_a_photo_turned_by_its_exif_is_turned_for_real():
    out = scrub.clean(photo("JPEG", exif=exif(orientation=6)), "a.jpg")
    img = Image.open(io.BytesIO(out))
    assert img.size == (20, 40) and not img.getexif()


def test_png_loses_text_and_time():
    from PIL import PngImagePlugin

    meta = PngImagePlugin.PngInfo()
    meta.add_text("Creation Time", "2024-05-01")
    raw = photo("PNG", pnginfo=meta)
    out = scrub.clean(raw, "a.png")
    assert b"tEXt" in raw and b"tEXt" not in out and b"2024-05-01" not in out
    assert Image.open(io.BytesIO(out)).tobytes() == Image.open(io.BytesIO(raw)).tobytes()


def test_webp_loses_exif():
    raw = photo("WEBP", exif=exif(), lossless=True)
    out = scrub.clean(raw, "a.webp")
    assert b"2024:05:01" in raw and b"2024:05:01" not in out
    img = Image.open(io.BytesIO(out))
    assert not img.getexif() and img.tobytes() == Image.open(io.BytesIO(raw)).tobytes()
    assert struct.unpack("<I", out[4:8])[0] == len(out) - 8


def test_mp4_times_are_zeroed_and_tags_blanked(tmp_path):
    src = make_video(tmp_path / "a.mp4", seconds=0.5)
    tagged = tmp_path / "t.mp4"
    with av.open(str(src)) as inp, av.open(str(tagged), "w", format="mp4") as out:
        out.metadata.update({"creation_time": "2024-05-01T10:00:00.000000Z", "title": "my holiday"})
        s = out.add_stream_from_template(inp.streams.video[0])
        for pkt in inp.demux(inp.streams.video[0]):
            if pkt.dts is not None:
                pkt.stream = s
                out.mux(pkt)
    raw = tagged.read_bytes()
    clean = tmp_path / "c.mp4"
    clean.write_bytes(scrub.clean(raw, "c.mp4"))
    with av.open(str(clean)) as c:
        assert "creation_time" not in c.metadata and "title" not in c.metadata
        assert sum(1 for _ in c.decode(video=0)) == 12
    kept = tmp_path / "k.mp4"
    kept.write_bytes(scrub.clean(raw, "k.mp4", keep_tags=True))
    with av.open(str(kept)) as c:
        assert c.metadata.get("title") == "my holiday" and "creation_time" not in c.metadata


def test_webm_date_is_zeroed(tmp_path):
    p = tmp_path / "a.webm"
    with av.open(str(p), "w", format="webm") as c:
        c.metadata["creation_time"] = "2024-05-01T10:00:00.000000Z"
        s = c.add_stream("libvpx", rate=12)
        s.width, s.height, s.pix_fmt = 64, 48, "yuv420p"
        for _ in range(6):
            for pkt in s.encode(av.VideoFrame.from_ndarray(np.zeros((48, 64, 3), np.uint8), format="rgb24")):
                c.mux(pkt)
        for pkt in s.encode():
            c.mux(pkt)
    out = tmp_path / "b.webm"
    out.write_bytes(scrub.clean(p.read_bytes(), "b.webm"))
    with av.open(str(p)) as c:
        assert "creation_time" in c.metadata
    with av.open(str(out)) as c:
        assert "2024" not in c.metadata.get("creation_time", "")
        assert sum(1 for _ in c.decode(video=0)) == 6


def test_wav_mp3_and_flac_lose_their_tags():
    wav = b"RIFF" + struct.pack("<I", 4 + 24 + 8 + 4 + 8 + 12) + b"WAVE" \
        + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 8000, 16000, 2, 16) \
        + b"data" + struct.pack("<I", 4) + b"\x00\x01\x00\x01" \
        + b"LIST" + struct.pack("<I", 12) + b"INFOICRD2024"
    out = scrub.clean(wav, "a.wav")
    assert b"2024" not in out and b"data" in out and struct.unpack("<I", out[4:8])[0] == len(out) - 8
    tag = b"ID3\x04\x00\x00" + bytes([0, 0, 0, 10]) + b"TDRC2024--"
    assert scrub.clean(tag + b"\xff\xfbAUDIO" + b"TAG" + bytes(125), "a.mp3") == b"\xff\xfbAUDIO"
    flac = b"fLaC" + bytes([0x00]) + (34).to_bytes(3, "big") + bytes(34) \
        + bytes([0x84]) + (8).to_bytes(3, "big") + b"DATE2024" + b"FRAMES"
    out = scrub.clean(flac, "a.flac")
    assert out == b"fLaC" + bytes([0x80]) + (34).to_bytes(3, "big") + bytes(34) + b"FRAMES"


def test_a_file_that_isnt_its_type_goes_through_untouched():
    for name in ("a.jpg", "a.png", "a.webp", "a.mp4", "a.webm", "a.flac", "a.ogg", "a.json"):
        assert scrub.clean(b"not media at all", name) == b"not media at all"


@pytest.mark.usefixtures("fresh_templates")
def test_a_template_goes_out_as_it_is():
    t = engines.duplicate_template(HAT)
    data, _ = template_pack.export(t.id)
    z = zipfile.ZipFile(io.BytesIO(data))
    head = json.loads(z.read("illusion.json"))
    assert "created" not in head
    assert all(i.date_time == archive.UNDATED for i in z.infolist())
    assert not {"draft", "added"} & set(json.loads(z.read("template.json")))
    for n in z.namelist():
        if n.startswith(("media/", "cover/")):
            assert scrub.clean(z.read(n), n) == z.read(n)


def test_a_generation_goes_out_without_its_history(tmp_path):
    sid = sc.new_id()
    f = store.folder(sid)
    (f / "refs").mkdir(parents=True)
    (f / "result").mkdir()
    (f / "refs" / "ref-01.jpg").write_bytes(photo("JPEG", exif=exif()))
    make_video(f / "result" / "preview.mp4", seconds=0.5)
    m = sc.Manifest(id=sid, title="Take", mode="edit", engine=sc.Engine(model=HAT), status="done", starred=True, outcome="worked",
                    inputs=[sc.InputItem(slot="image:1", file="refs/ref-01.jpg", license="generated", sha256=sc.sha256_file(f / "refs" / "ref-01.jpg"))],
                    lineage=sc.Lineage(forked_from="01ABCDEFGHJKMNPQRSTVWXYZ00"),
                    result=sc.Result(file="result/preview.mp4", kind="video", output_file="C:/Users/me/out.mp4"))
    store.save(m, shelf="mine")
    out = bundle.export(m.id, "full", False, {"sfw": True, "rights": True}, dest_dir=tmp_path / "x")
    z = zipfile.ZipFile(out)
    assert all(i.date_time == archive.UNDATED for i in z.infolist())
    d = json.loads(z.read("generation.json"))
    assert not set(sc.PRIVATE) & set(d) and d["id"] == sc.share_id(m.id) and "output_file" not in d["result"]
    assert b"2024:05:01" not in z.read("refs/ref-01.jpg")
    assert bundle.recipe_only(store.get(m.id))["id"] == sc.share_id(m.id)
    review = bundle.inspect(out.read_bytes(), out.name)
    assert review["exists"] is True and any(c["text"] == "File hashes verified" for c in review["checks"])
    m2 = bundle.commit(review["token"])
    assert m2.id not in (m.id, d["id"]) and m2.lineage.forked_from == m.id


@pytest.mark.usefixtures("fresh_templates")
def test_a_backup_carries_template_use_and_merges_it(tmp_path):
    usage.note(HAT, at=1000.0)
    usage.note(HAT, at=2000.0)
    out = backup.create(dest_dir=tmp_path / "b")
    assert "library/usage.json" in zipfile.ZipFile(out["file"]).namelist()
    paths.configure(tmp_path / "new", tmp_path / "new-out")
    store._conn = None
    settings.remember(key="")
    engines.reload_templates()
    usage.note(HAT, at=500.0)
    usage.note("cloud/other", at=3000.0)
    backup.restore(paths.Path(out["file"]), tmp_path / "stage")
    assert usage.load()[HAT] == {"n": 2, "at": 2000.0} and usage.load()["cloud/other"]["n"] == 1


@pytest.mark.usefixtures("fresh_templates")
def test_newest_knows_when_your_templates_landed():
    shipped = [e for e in engines.ENGINES.values() if e.origin != "user" and e.data]
    assert shipped and all(engines.describe(e)["added"] for e in shipped)  # the day each shipped
    t = engines.duplicate_template(HAT)
    first = engines.describe(t)["added"]
    data, _ = template_pack.export(t.id)
    back = template_pack.install(data)
    assert first and engines.describe(back)["added"] >= first
