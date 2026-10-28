"""Whole-library backups: what goes in, what stays out, restoring by merging, refusing bad files."""

import io
import json
import zipfile

import pytest

from server import archive, backup, engines, paths, settings, store
from server import generation as sc

from conftest import make_image

HAT = "local/qwen21-add-hat"
KEY = "comfyui-backup-test-key-5678"


def a_generation(status="done"):
    sid = sc.new_id()
    f = store.folder(sid)
    (f / "refs").mkdir(parents=True)
    make_image(f / "refs" / "ref-01.png")
    m = sc.Manifest(id=sid, title="Kept", mode="edit", engine=sc.Engine(model=HAT), status=status,
                    inputs=[sc.InputItem(slot="image:1", file="refs/ref-01.png", sha256=sc.sha256_file(f / "refs" / "ref-01.png"))])
    store.save(m, shelf="mine")
    return m


def a_library():
    settings.save({"api_key": KEY, "max_parallel": 4})
    m = a_generation()
    t = engines.duplicate_template(HAT)  # a template of their own, with its media copied alongside
    return m, t


def fresh_home(tmp_path, name):
    paths.configure(tmp_path / name, tmp_path / f"{name}-out")
    store._conn = None
    settings.remember(key="")  # a new install starts with no key in memory
    engines.reload_templates()


@pytest.mark.usefixtures("fresh_templates")
def test_a_backup_holds_the_library_and_no_secrets(tmp_path):
    m, t = a_library()
    running = a_generation(status="running")
    out = backup.create(dest_dir=tmp_path / "b")
    z = zipfile.ZipFile(out["file"])
    names = z.namelist()
    assert f"library/generations/{m.id}/generation.json" in names
    assert f"library/generations/{m.id}/.shelf" in names
    assert not any(running.id in n for n in names)
    assert {"id": running.id, "why": "running"} in out["skipped"]
    assert any(n.startswith("library/templates/media/") for n in names)
    assert not any(n.endswith(("secrets.json", "index.sqlite", "jobs.json")) for n in names)
    assert all(KEY.encode() not in z.read(n) for n in names)  # the key is nowhere in the file
    man = json.loads(z.read("backup.json"))
    assert man["format"] == "openillusion.backup" and man["counts"]["generations"] == 1 and man["counts"]["templates"] == 1
    assert set(man["files"]) == set(names) - {"backup.json"}
    assert z.getinfo(f"library/generations/{m.id}/refs/ref-01.png").compress_type == zipfile.ZIP_STORED


@pytest.mark.usefixtures("fresh_templates")
def test_restore_into_a_fresh_install_brings_everything_back(tmp_path):
    m, t = a_library()
    out = backup.create(dest_dir=tmp_path / "b")
    fresh_home(tmp_path, "new")
    review = backup.inspect(paths.Path(out["file"]), "1")
    assert review["generations"] == {"total": 1, "new": 1} and review["templates"]["new"] == 1
    res = backup.restore(paths.Path(out["file"]), tmp_path / "stage")
    assert res["generations"] == 1 and res["templates"] == 1 and res["damaged"] == []
    assert store.get(m.id).title == "Kept" and [r["id"] for r in store.query()] == [m.id]
    assert store.shelf_of(m.id) == "mine"
    e = engines.ENGINES[t.id]
    assert e.origin == "user" and e.default_inputs["image:1"].is_file()
    assert settings.load()["max_parallel"] == 4 and "max_parallel" in res["settings"]
    assert settings.api_key() == ""  # the key never travels
    assert not (tmp_path / "stage").exists()


@pytest.mark.usefixtures("fresh_templates")
def test_restoring_merges_and_keeps_what_you_have(tmp_path):
    m, t = a_library()
    out = paths.Path(backup.create(dest_dir=tmp_path / "b")["file"])
    engines.edit_template(t.id, {"blurb": "Mine now"})
    settings.save({"max_parallel": 6})
    res = backup.restore(out, tmp_path / "stage")
    assert res["generations"] == 0 and res["templates"] == 0
    assert res["kept"] == [t.path.stem]
    assert engines.ENGINES[t.id].blurb == "Mine now" and settings.load()["max_parallel"] == 6
    assert res["settings"] == []


def tampered(src, fn):
    """A copy of a backup with its entries passed through fn(name, data) -> (name, data) | None."""
    buf = io.BytesIO()
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(buf, "w") as zout:
        for n in zin.namelist():
            r = fn(n, zin.read(n))
            if r:
                zout.writestr(*r)
    return buf


@pytest.mark.usefixtures("fresh_templates")
@pytest.mark.parametrize("change, match", [
    (lambda n, d: (n, d) if n != "backup.json" else (n, json.dumps({**json.loads(d), "version": 99})), "newer OpenIllusion"),
    (lambda n, d: (n.replace("library/generations/", "library/generations/../../"), d), "Unsafe path"),
    (lambda n, d: ("library/secrets.json", b"{}") if n == "library/settings.json" else (n, d), "Not part of a library"),
    (lambda n, d: (n.replace(".png", ".exe"), d), "not allowed"),
    (lambda n, d: (n, d) if n != "backup.json" else None, "no readable backup.json"),
])
def test_restore_refuses_bad_backups(tmp_path, change, match):
    a_library()
    src = backup.create(dest_dir=tmp_path / "b")["file"]
    bad = tmp_path / "bad.illusionbackup"
    bad.write_bytes(tampered(src, change).getvalue())
    with pytest.raises(archive.Refused, match=match):
        backup.inspect(bad, "1")


@pytest.mark.usefixtures("fresh_templates")
def test_a_damaged_generation_is_left_out(tmp_path):
    m, _ = a_library()
    src = backup.create(dest_dir=tmp_path / "b")["file"]
    bad = tmp_path / "bad.illusionbackup"
    bad.write_bytes(tampered(src, lambda n, d: (n, d + b"x") if n.endswith("ref-01.png") else (n, d)).getvalue())
    fresh_home(tmp_path, "new")
    res = backup.restore(bad, tmp_path / "stage")
    assert res["generations"] == 0 and res["damaged"][0]["id"] == m.id
    assert not store.folder(m.id).exists() and store.query() == []
