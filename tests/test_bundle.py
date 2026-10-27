import dataclasses
import io
import json
import zipfile

import pytest

from server import bundle, engines, media, store
from server import generation as sc

from conftest import make_image, make_video


def library_generation(tmp_path, with_video=True, person=True):
    sid = sc.new_id()
    f = store.folder(sid)
    (f / "refs").mkdir(parents=True)
    (f / "result").mkdir()
    make_image(f / "refs" / "ref-01.png", size=(1400, 1000))
    inputs = [sc.InputItem(slot="image:1", role="character", file="refs/ref-01.png", license="generated",
                           sha256=sc.sha256_file(f / "refs" / "ref-01.png"))]
    if with_video:
        (f / "driving").mkdir()
        make_video(f / "driving" / "driving.mp4")
        inputs.insert(0, sc.InputItem(slot="video:1", role="motion", file="driving/driving.mp4", license="own-footage",
                                      contains_person=person, sha256=sc.sha256_file(f / "driving" / "driving.mp4")))
    make_video(f / "result" / "preview.mp4")
    media.poster(f / "result" / "preview.mp4", f / "result" / "poster.webp")
    m = sc.Manifest(id=sid, title="Hallway take", mode="motion", engine=sc.Engine(model="minimax/minimax-h3"),
                    inputs=inputs, prompt="Image 1 is the character.", status="done",
                    result=sc.Result(file="result/preview.mp4", poster="result/poster.webp", kind="video"))
    store.save(m, shelf="mine")
    return m


OK = {"sfw": True, "rights": True, "consent": {"video:1": True}}


def test_export_requires_attestation_and_consent(tmp_path):
    m = library_generation(tmp_path)
    with pytest.raises(ValueError, match="safe for work"):
        bundle.export(m.id, "full", False, {"rights": True, "consent": {"video:1": True}})
    with pytest.raises(ValueError, match="consent for video:1"):
        bundle.export(m.id, "full", False, {"sfw": True, "rights": True})
    # Light strips the driving video, so no consent is needed for it.
    bundle.export(m.id, "light", False, {"sfw": True, "rights": True})


def test_full_roundtrip_keeps_everything(tmp_path, monkeypatch):
    m = library_generation(tmp_path)
    swap = dataclasses.replace(engines.get("local/minimax-h3-character-swap"), id=m.engine.model)
    monkeypatch.setitem(engines.ENGINES, m.engine.model, swap)  # a template for it is installed
    out = bundle.export(m.id, "full", False, OK, dest_dir=tmp_path / "x")
    names = set(zipfile.ZipFile(out).namelist())
    assert {"generation.json", "refs/ref-01.png", "driving/driving.mp4", "result/preview.mp4", "result/poster.webp", "LICENSES.md"} <= names
    review = bundle.inspect(out.read_bytes(), out.name)
    assert review["exists"] is True
    assert review["has_driving"] is True
    assert all(c["level"] == "pass" for c in review["checks"]), review["checks"]
    m2 = bundle.commit(review["token"])
    assert m2.id != m.id and m2.lineage.forked_from == m.id  # already in library → fork
    assert store.shelf_of(m2.id) == "imported"
    assert (store.folder(m2.id) / "driving" / "driving.mp4").exists()


def test_light_downsizes_and_strips_video(tmp_path):
    m = library_generation(tmp_path)
    out = bundle.export(m.id, "light", False, OK, dest_dir=tmp_path / "x")
    z = zipfile.ZipFile(out)
    assert "driving/driving.mp4" not in z.namelist()
    man = json.loads(z.read("generation.json"))
    ref = next(i for i in man["inputs"] if i["slot"] == "image:1")
    img = media.open_image(z.read(ref["file"]))
    assert max(img.size) == 768 and ref["file"].endswith(".webp")
    review = bundle.inspect(out.read_bytes(), out.name)
    assert any(c["text"] == "No driving video in this generation" for c in review["checks"])


def test_recipe_only_is_small_and_linkable(tmp_path):
    m = library_generation(tmp_path)
    out = bundle.export(m.id, "recipe", False, OK, dest_dir=tmp_path / "x")
    assert out.stat().st_size < bundle.RECIPE_MAX
    link = bundle.link(store.get(m.id))
    review = bundle.inspect(("https://example.com/open" + link).encode())
    assert review["source"]["kind"] == "link"
    assert review["manifest"]["prompt"] == m.prompt


def zip_with(entries):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, d in entries.items():
            z.writestr(n, d)
    return buf.getvalue()


MAN = json.dumps({"format": "openillusion.generation", "version": 1, "id": "01JB8Z0000000000000000000A", "mode": "edit",
                  "engine": {"model": "bfl/flux-3-image"}})


@pytest.mark.parametrize("name", ["../evil.json", "/abs.json", "C:/x.json", "refs/../../b.json"])
def test_import_refuses_unsafe_paths(name):
    with pytest.raises(bundle.ImportRefused, match="Unsafe path"):
        bundle.inspect(zip_with({"generation.json": MAN, name: "{}"}))


def test_import_refuses_executables_and_floods():
    with pytest.raises(bundle.ImportRefused, match="not allowed"):
        bundle.inspect(zip_with({"generation.json": MAN, "run.py": "print(1)"}))
    with pytest.raises(bundle.ImportRefused, match="limit is 200"):
        bundle.inspect(zip_with({"generation.json": MAN, **{f"refs/{n}.png": b"x" for n in range(201)}}))


def test_import_refuses_bad_manifest():
    with pytest.raises(bundle.ImportRefused, match="schema"):
        bundle.inspect(zip_with({"generation.json": json.dumps({"format": "openillusion.generation", "version": 1})}))


def test_hash_mismatch_drops_file():
    man = json.loads(MAN)
    man["inputs"] = [{"slot": "image:1", "file": "refs/ref-01.png", "sha256": "0" * 64}]
    buf = io.BytesIO()
    make_image_bytes = io.BytesIO()
    from PIL import Image

    Image.new("RGB", (300, 300)).save(make_image_bytes, "PNG")
    review = bundle.inspect(zip_with({"generation.json": json.dumps(man), "refs/ref-01.png": make_image_bytes.getvalue()}))
    assert any("hashes" in c["text"] for c in review["checks"])
    assert review["manifest"]["inputs"][0]["file"] is None


def test_png_and_mp4_carry_their_recipe(tmp_path):
    m = library_generation(tmp_path)
    from server.jobs import recipe_manifest

    recipe = recipe_manifest(store.get(m.id))
    png = media.png_with_recipe(media.open_image(store.folder(m.id) / "refs" / "ref-01.png"), tmp_path / "o.png", recipe)
    assert media.read_png_recipe(png)["id"] == m.id
    mp4 = tmp_path / "o.mp4"
    media.write_mp4_recipe(store.folder(m.id) / "result" / "preview.mp4", mp4, recipe)
    assert media.read_mp4_recipe(mp4)["id"] == m.id
    review = bundle.inspect(mp4.read_bytes(), "o.mp4")
    assert review["source"]["kind"] == "mp4"
    m2 = bundle.commit(review["token"])
    assert m2.result.file == "result/preview.mp4"
    assert (store.folder(m2.id) / "result" / "preview.mp4").exists()


def test_plain_png_is_refused(tmp_path, image):
    with pytest.raises(bundle.ImportRefused, match="no OpenIllusion recipe"):
        bundle.inspect(image.read_bytes(), "ref.png")


def test_search_and_trash(tmp_path):
    m = library_generation(tmp_path)
    store.update(m.id, notes="explicit role sentences fixed drift", tags=["rain"], outcome="worked")
    assert [r["id"] for r in store.query(q="drift")] == [m.id]
    assert [r["id"] for r in store.query(tag="rain", outcome="worked")] == [m.id]
    assert store.query(q='bad "quote') == []
    store.delete(m.id)
    assert store.query() == []
    assert store.trash()[0]["id"] == m.id
    store.restore(m.id)
    assert store.query()[0]["id"] == m.id
