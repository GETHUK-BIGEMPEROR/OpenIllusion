"""One template as a .illusion: export, add, and what adding refuses."""

import io
import json
import zipfile

import pytest

from server import engines, paths, template_pack

HAT = "local/qwen21-add-hat"


def _rewrite(data: bytes, change) -> bytes:
    """The package with ``change(files)`` applied, checksums left as they were."""
    src = zipfile.ZipFile(io.BytesIO(data))
    files = {n: src.read(n) for n in src.namelist()}
    change(files)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for n, b in files.items():
            z.writestr(n, b)
    return buf.getvalue()


@pytest.mark.usefixtures("fresh_templates")
def test_a_template_goes_out_with_its_samples_and_comes_back_as_yours():
    data, name = template_pack.export(HAT)
    assert name == "add-a-hat.illusion"
    z = zipfile.ZipFile(io.BytesIO(data))
    head = json.loads(z.read("illusion.json"))
    assert head["format"] == template_pack.FORMAT and head["id"] == HAT
    tpl = json.loads(z.read("template.json"))
    assert tpl["cover"].startswith("media/") and tpl["cover"] in z.namelist()
    assert template_pack.is_pack(data)

    e = template_pack.install(data)
    # Its id is taken by the shipped one, so it's added beside it, as yours.
    assert e.id == HAT + "-2" and e.origin == "user" and e.built
    assert e.label == engines.ENGINES[HAT].label
    assert e.cover and e.cover.is_file() and e.cover.is_relative_to(paths.user_root() / "templates" / "media")
    assert all(p.is_file() for p in e.default_inputs.values())
    assert not (paths.user_root() / "templates" / ".adding").exists()
    # Yours, so it deletes for real, media and all.
    engines.delete_template(e.id)
    assert e.id not in engines.ENGINES and not e.cover.exists()


@pytest.mark.usefixtures("fresh_templates")
def test_your_cover_travels_with_it():
    src = engines.ENGINES[HAT].cover
    own = engines.user_cover(HAT)
    own.parent.mkdir(parents=True, exist_ok=True)
    own.write_bytes(src.read_bytes())
    data, _ = template_pack.export(HAT)
    assert "cover/cover.webp" in zipfile.ZipFile(io.BytesIO(data)).namelist()
    e = template_pack.install(data)
    assert engines.user_cover(e.id).read_bytes() == src.read_bytes()


def test_a_generation_illusion_is_not_a_template():
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("generation.json", "{}")
    assert not template_pack.is_pack(buf.getvalue())
    assert not template_pack.is_pack(b"not a zip")


@pytest.mark.usefixtures("fresh_templates")
@pytest.mark.parametrize("change, says", [
    (lambda f: f.update({"template.json": f["template.json"].replace(b"Add a hat", b"Add a cap")}), "checksum"),
    (lambda f: f.update({"../evil.json": b"{}"}), "Unsafe path"),
    (lambda f: f.update({"media/run.exe": b"MZ"}), "not allowed"),
    (lambda f: f.update({"notes/readme.json": b"{}"}), "Not part of a template"),
])
def test_adding_refuses_a_package_that_is_off(change, says):
    data, _ = template_pack.export(HAT)
    before = set(engines.ENGINES)
    with pytest.raises(template_pack.archive.Refused, match=says):
        template_pack.install(_rewrite(data, change))
    assert set(engines.ENGINES) == before


@pytest.mark.usefixtures("fresh_templates")
def test_a_template_cannot_name_a_file_outside_its_package():
    data, _ = template_pack.export(HAT)
    z = zipfile.ZipFile(io.BytesIO(data))
    head, tpl = json.loads(z.read("illusion.json")), json.loads(z.read("template.json"))
    tpl["cover"] = "../../settings.json"
    body = json.dumps(tpl).encode()

    def change(f):
        import hashlib
        f["template.json"] = body
        head["files"]["template.json"] = {"size": len(body), "sha256": hashlib.sha256(body).hexdigest()}
        f["illusion.json"] = json.dumps(head).encode()

    with pytest.raises(template_pack.archive.Refused, match="doesn't include"):
        template_pack.install(_rewrite(data, change))
