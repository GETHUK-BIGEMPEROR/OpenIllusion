"""Character Lab: characters on disk, making a RefMod on ComfyUI into the RefMod folder, picking one in a run, backups."""

import asyncio
import json
import zipfile

import httpx
import pytest

from server import backup, characters, engines, local, paths, staging, store
from server import generation as sc

from conftest import make_image

REFMOD_TPL = "local/minimax-h3-character-refmod"
FAKE_MOD = b"\x10\x00\x00\x00\x00\x00\x00\x00" + b'{"__metadata__":{}}' + b"\x00" * 64


def a_character(tmp_path, photos=2, name="Mara"):
    c = characters.create(name)
    for n in range(photos):
        c = characters.add_photo(c["id"], make_image(tmp_path / f"p{n}.png", color=(40 * n, 90, 160)))
    return c


def fake_comfyui(fail: str | None = None):
    """A ComfyUI that knows the RefMod nodes, takes uploads and prompts, and has the file in output/refmods."""
    seen = {"uploads": [], "prompts": []}

    def handle(req: httpx.Request) -> httpx.Response:
        path = req.url.path
        if path == "/object_info":
            return httpx.Response(200, json={k: {"input": {"required": {}}} for k in ("VAELoader", "LoadImage", "MiniMaxH3RefModExtract")})
        if path == "/upload/image":
            body = req.content.decode("latin-1")
            name = body.split('filename="')[1].split('"')[0]
            sub = body.split('name="subfolder"\r\n\r\n')[1].split("\r\n")[0]
            seen["uploads"].append(f"{sub}/{name}")
            return httpx.Response(200, json={"name": name, "subfolder": sub, "type": "input"})
        if path == "/prompt":
            seen["prompts"].append(json.loads(req.content)["prompt"])
            return httpx.Response(200, json={"prompt_id": "p1"})
        if path == "/history/p1":
            status = {"status_str": "error" if fail else "success", "completed": True,
                      "messages": [["execution_error", {"exception_message": fail}]] if fail else []}
            return httpx.Response(200, json={"p1": {"status": status, "outputs": {"3": {"text": [json.dumps({"tokens": 1536})]}}}})
        if path == "/view":
            q = req.url.params
            ok = q["type"] == "output" and q["subfolder"] == "refmods/openillusion"
            return httpx.Response(200 if ok else 404, content=FAKE_MOD if ok else b"")
        return httpx.Response(404)

    return local.ComfyUI("http://comfy.test", transport=httpx.MockTransport(handle)), seen


def test_a_character_is_a_folder_of_photos(tmp_path):
    c = a_character(tmp_path)
    assert c["photos"] == ["p-01.jpg", "p-02.jpg"] and c["cover"] == "p-01.jpg" and c["refmod"] is None
    assert (paths.user_root() / "characters" / c["id"] / "photos" / "p-02.jpg").is_file()
    c = characters.update(c["id"], cover="p-02.jpg", name="  Mara Vale ")
    assert c["cover"] == "p-02.jpg" and c["name"] == "Mara Vale"
    c = characters.remove_photo(c["id"], "p-02.jpg")
    assert c["photos"] == ["p-01.jpg"] and c["cover"] == "p-01.jpg"
    with pytest.raises(ValueError):
        characters.update(c["id"], name=" ")
    with pytest.raises(FileNotFoundError):
        characters.get("../../etc")
    characters.delete(c["id"])
    assert characters.list_all() == []


def test_the_lab_workflow_takes_one_loader_per_photo(tmp_path):
    wf = characters.refmod_workflow("ABC", ["openillusion/a.jpg", "openillusion/b.jpg"])
    make = wf["3"]["inputs"]
    assert make["name"] == "ABC" and make["subfolder"] == "openillusion" and make["save"] is True
    assert make["refs_image.ref_image_0"] == ["10", 0] and make["refs_image.ref_image_1"] == ["11", 0]
    assert wf["10"]["inputs"]["image"] == "openillusion/a.jpg" and wf["11"]["inputs"]["image"] == "openillusion/b.jpg"


def test_making_a_refmod_fetches_it_like_a_result(tmp_path):
    c = a_character(tmp_path)
    comfy, seen = fake_comfyui()
    asyncio.run(characters._make(c["id"], comfy, poll=0))
    c = characters.get(c["id"])
    assert c["making"] is None and c["refmod"]["tokens"] == 1536 and c["refmod"]["photos"] == ["p-01.jpg", "p-02.jpg"]
    assert c["refmod"]["file"] == "Mara.safetensors" and not c["refmod_stale"]
    assert (paths.refmods_dir() / "Mara.safetensors").read_bytes() == FAKE_MOD
    assert characters.list_refmods()[0] | {"modified": 0} == {"name": "Mara.safetensors", "label": "Mara", "bytes": len(FAKE_MOD), "modified": 0,
                                                              "character": {"id": c["id"], "name": "Mara", "cover": "p-01.jpg", "face": c["photo_urls"]["p-01.jpg"]}}
    assert seen["uploads"] == [f"openillusion/{c['id']}-p-01.jpg", f"openillusion/{c['id']}-p-02.jpg"]
    # A photo added since: the RefMod still works, and says it doesn't show it.
    c = characters.add_photo(c["id"], make_image(tmp_path / "late.png"))
    assert c["refmod_stale"]
    # Made again, it overwrites its own file, even renamed; another Mara's gets a name of its own.
    characters.update(c["id"], name="Mara Vale")
    asyncio.run(characters._make(c["id"], comfy, poll=0))
    other = a_character(tmp_path, name="Mara")
    asyncio.run(characters._make(other["id"], comfy, poll=0))
    assert sorted(r["name"] for r in characters.list_refmods()) == ["Mara 2.safetensors", "Mara.safetensors"]


def test_the_refmod_folder_lists_any_refmod_and_nothing_else(tmp_path):
    (paths.refmods_dir() / "found.safetensors").write_bytes(FAKE_MOD)
    (paths.refmods_dir() / "notes.txt").write_text("x")
    assert [(r["name"], r["character"]) for r in characters.list_refmods()] == [("found.safetensors", None)]
    assert characters.refmod_file("found.safetensors").read_bytes() == FAKE_MOD
    for bad in ("notes.txt", "../characters", "missing.safetensors", ""):
        with pytest.raises(FileNotFoundError):
            characters.refmod_file(bad)
    # Settings can point it anywhere.
    from server import settings

    settings.save({"refmod_folder": str(tmp_path / "elsewhere")})
    assert paths.refmods_dir() == tmp_path / "elsewhere" and characters.list_refmods() == []
    settings.save({"refmod_folder": ""})


def test_a_failed_refmod_says_why_and_keeps_the_old_one(tmp_path):
    c = a_character(tmp_path)
    comfy, _ = fake_comfyui(fail="CUDA out of memory")
    asyncio.run(characters._make(c["id"], comfy, poll=0))
    c = characters.get(c["id"])
    assert c["making"]["state"] == "failed" and "CUDA out of memory" in c["making"]["detail"] and c["refmod"] is None


def test_no_comfyui_is_said_plainly(tmp_path):
    c = a_character(tmp_path)

    def down(req):
        raise httpx.ConnectError("refused")

    asyncio.run(characters._make(c["id"], local.ComfyUI("http://comfy.test", transport=httpx.MockTransport(down)), poll=0))
    assert "Nothing answers at http://comfy.test" in characters.get(c["id"])["making"]["detail"]


def with_refmod(tmp_path):
    c = a_character(tmp_path)
    (paths.refmods_dir() / "Mara.safetensors").write_bytes(FAKE_MOD)
    raw = json.loads((characters.folder(c["id"]) / "character.json").read_text("utf-8"))
    raw["refmod"] = {"file": "Mara.safetensors", "sha256": sc.sha256_file(paths.refmods_dir() / "Mara.safetensors"), "photos": raw["photos"]}
    (characters.folder(c["id"]) / "character.json").write_text(json.dumps(raw), "utf-8")
    return characters.get(c["id"])


def refmod_spec(c, refmod="Mara.safetensors", **kw):
    e = engines.get(REFMOD_TPL)
    return {"engine": REFMOD_TPL, "prompt": e.default_prompt, "params": {}, "inputs": [
        {"slot": "video:1", "asset": f"tpl:{REFMOD_TPL}|video:1"},
        {"slot": "refmod:1", "refmod": refmod, "label": c["name"]},
        {"slot": "image:1", "asset": f"char:{c['id']}/{c['cover']}"}], **kw}


def test_a_refmod_not_in_the_folder_cant_run(tmp_path):
    c = a_character(tmp_path)
    errors = [w["text"] for w in engines.compose(refmod_spec(c))["warnings"] if w["level"] == "error"]
    assert errors == ["Mara.safetensors isn't in your RefMod folder any more. Pick another."]
    with pytest.raises(ValueError, match="RefMod folder"):
        staging.prepare_generation(refmod_spec(c))
    spec = refmod_spec(c)
    spec["inputs"] = [i for i in spec["inputs"] if i["slot"] != "refmod:1"]
    assert [w["text"] for w in engines.compose(spec)["warnings"] if w["level"] == "error"] == ["Pick RefMod 1"]


def test_a_run_carries_the_characters_refmod(tmp_path):
    c = with_refmod(tmp_path)
    out = engines.compose(refmod_spec(c))
    assert not [w for w in out["warnings"] if w["level"] == "error"]
    assert out["template"]["201"]["inputs"]["mod_1"] == "{{refmod:1}}" and out["template"]["126"]["inputs"]["conditioning"] == ["202", 0]
    m = staging.prepare_generation(refmod_spec(c))
    item = next(i for i in m.inputs if i.slot == "refmod:1")
    assert item.file == "refs/refmod-1.safetensors" and item.label == "Mara" and item.role == "character"
    assert (store.folder(m.id) / item.file).read_bytes() == FAKE_MOD
    # The workflow saved beside it names the RefMod as a run uploads it.
    wf = json.loads((store.folder(m.id) / "comfy" / "workflow.json").read_text("utf-8"))
    assert wf["201"]["inputs"]["mod_1"] == characters.mod_name(item.sha256) and wf["137"]["inputs"]["image"].startswith("ref-")
    # A rerun takes the generation's own copy, even once the RefMod is gone from the folder.
    characters.delete(c["id"])
    (paths.refmods_dir() / "Mara.safetensors").unlink()
    from server.routes.common import spec_from_generation

    again = staging.prepare_generation(spec_from_generation(m))
    assert (store.folder(again.id) / "refs" / "refmod-1.safetensors").read_bytes() == FAKE_MOD


def test_the_refmod_alone_is_the_character(tmp_path):
    """No photo: the photo loader goes, and the reference node keeps only the clip; the RefMod brings the person."""
    c = with_refmod(tmp_path)
    spec = refmod_spec(c)
    spec["inputs"] = [i for i in spec["inputs"] if i["slot"] != "image:1"]
    out = engines.compose(spec)
    assert not [w for w in out["warnings"] if w["level"] == "error"]
    wf = out["template"]
    assert "137" not in wf and "ref_images.ref_image_0" not in wf["136"]["inputs"] and wf["136"]["inputs"]["ref_videos.ref_video_0"] == ["148", 0]
    assert wf["202"]["inputs"]["conditioning"] == ["136", 0] and wf["201"]["inputs"]["mod_1"] == "{{refmod:1}}"
    # Nothing in the template points at a photo it may not have.
    assert "<Picture 1>" not in engines.get(REFMOD_TPL).default_prompt


def test_a_run_uploads_the_refmod_where_the_loader_looks(tmp_path):
    comfy, seen = fake_comfyui()
    p = tmp_path / "m.safetensors"
    p.write_bytes(FAKE_MOD)
    name = asyncio.run(characters.stage(comfy, p, "ab" * 32))
    assert name == "openillusion/abababababababab" and seen["uploads"] == ["refmods/openillusion/abababababababab.safetensors"]
    wf = engines.fill_refmods({"1": {"class_type": "X", "inputs": {"mod_1": "{{refmod:1}}", "n": 2}}}, {"refmod:1": name})
    assert wf["1"]["inputs"] == {"mod_1": name, "n": 2}


def test_characters_and_refmods_are_backed_up_and_restored(tmp_path):
    c = with_refmod(tmp_path)
    (paths.refmods_dir() / "found.safetensors").write_bytes(FAKE_MOD)
    out = backup.create(dest_dir=tmp_path / "b")
    names = zipfile.ZipFile(out["file"]).namelist()
    assert f"library/characters/{c['id']}/photos/p-01.jpg" in names and "library/refmods/Mara.safetensors" in names
    assert out["counts"]["characters"] == 1 and out["counts"]["refmods"] == 2
    paths.configure(tmp_path / "new", tmp_path / "new-out")
    store._conn = None
    seen = backup.inspect(paths.Path(out["file"]), "1")
    assert seen["characters"] == {"total": 1, "new": 1} and seen["refmods"] == {"total": 2, "new": 2}
    (paths.refmods_dir() / "found.safetensors").write_bytes(b"mine")  # one you have stays yours
    res = backup.restore(paths.Path(out["file"]), tmp_path / "stage")
    assert res["characters"] == 1 and res["refmods"] == 1 and res["damaged"] == []
    assert (paths.refmods_dir() / "found.safetensors").read_bytes() == b"mine"
    back = characters.get(c["id"])
    assert back["name"] == "Mara" and back["refmod"]["sha256"] == c["refmod"]["sha256"] and back["photos"] == c["photos"]


def test_a_refmod_gone_from_the_folder_is_made_under_its_name_again(tmp_path):
    c = a_character(tmp_path)
    comfy, _ = fake_comfyui()
    asyncio.run(characters._make(c["id"], comfy, poll=0))
    (paths.refmods_dir() / "Mara.safetensors").unlink()
    assert characters.get(c["id"])["refmod"] is None
    characters.update(c["id"], name="Mara Vale")
    asyncio.run(characters._make(c["id"], comfy, poll=0))
    assert characters.get(c["id"])["refmod"]["file"] == "Mara Vale.safetensors"
