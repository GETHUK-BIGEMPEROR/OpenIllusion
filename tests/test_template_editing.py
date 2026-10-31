"""Editing updates one template, not past recipes or the shipped original."""

import asyncio
import copy
import json
from unittest.mock import AsyncMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import builder, engines, jobs, local, paths, routes, store
from test_builder import INFO, _local_spec, ui_graph
from conftest import make_image


def call(fn):
    async def run():
        app = web.Application()
        table = web.RouteTableDef()
        routes.register(table)
        app.add_routes(table)
        async with TestClient(TestServer(app)) as client:
            return await fn(client)
    return asyncio.run(run())


@pytest.fixture
def editable(monkeypatch, tmp_path, fresh_templates):
    api, _ = builder.ui_to_api(ui_graph(), INFO)
    data = builder.assemble_local(_local_spec(), {"workflow": api}, INFO)
    tid = builder.save(data, {"image:1": make_image(tmp_path / "sample.png")})
    engines.reload_templates()
    monkeypatch.setattr(local.ComfyUI, "object_info", AsyncMock(return_value=INFO))
    monkeypatch.setattr(jobs, "MANAGER", jobs.Manager())
    return tid, api


def test_edit_prefill_retains_name_while_build_from_this_names_a_copy(editable):
    tid, _ = editable

    async def run(client):
        original = await (await client.post("/api/builder/from-template", json={"engine": tid, "edit": True})).json()
        copied = await (await client.post("/api/builder/from-template", json={"engine": tid})).json()
        return original, copied

    original, copied = call(run)
    assert original["preset"]["label"] == "Red hat"
    assert copied["preset"]["label"] == "Red hat (copy)"
    assert original["preset"]["base"] == tid


def test_save_changes_preserves_id_cover_publication_and_history(editable, tmp_path):
    from server import generation as sc
    tid, api = editable
    e = engines.get(tid)
    engines.set_cover(tid, make_image(tmp_path / "cover.png"))
    engines.publish_template(tid)
    original = json.loads(e.path.read_text("utf-8"))
    m = sc.Manifest(id=sc.new_id(), title="Earlier result", mode="edit", engine=sc.Engine(model=tid), prompt="Original prompt", params={"steps": 8}, status="done")
    store.save(m)
    saved_recipe = (store.folder(m.id) / "generation.json").read_bytes()

    async def run(client):
        payload = {"kind": "local", "replace": tid, "token": builder.put_draft(api, "edit.json"),
                   **_local_spec(label="Blue hat", prompt={"node": "12:2", "input": "text", "default": "Add a blue hat."})}
        response = await client.post("/api/builder/save", json=payload)
        assert response.status == 200, await response.text()
        return await response.json()

    updated = call(run)
    assert updated["id"] == tid and updated["label"] == "Blue hat" and not updated["draft"]
    assert updated["cover"]
    assert engines.get(tid).default_prompt == "Add a blue hat."
    assert json.loads(e.path.read_text("utf-8"))["added"] == original["added"]
    assert (store.folder(m.id) / "generation.json").read_bytes() == saved_recipe
    assert jobs.MANAGER.list() == []  # Saving itself never generates.


def test_cannot_replace_an_unknown_template_or_change_backend(editable):
    tid, _ = editable

    async def run(client):
        a = await client.post("/api/builder/save", json={"replace": "local/no-such-template", "kind": "local"})
        b = await client.post("/api/builder/save", json={"replace": tid, "kind": "cloud"})
        return a.status, b.status
    assert call(run) == (404, 422)


def test_shipped_template_saves_as_a_resettable_override_without_changing_bundled_files(editable):
    e = engines.get("cloud/character-swap")
    original = e.path.read_bytes()
    media = {p: p.read_bytes() for p in [e.cover, e.cover_video, *e.default_inputs.values()] if p and p.is_file()}

    async def run(client):
        response = await client.post("/api/builder/from-template", json={"engine": e.id, "edit": True})
        preset = await response.json()
        assert preset["label"] == e.label
        payload = {"kind": "cloud", "replace": e.id, "base": e.id, "model": preset["model"], "label": "My character defaults", "blurb": e.blurb, "mode": e.mode,
                   "prompt": {"default": preset["prompt"]["default"], "required": True}, "params": [],
                   "media": [{"input": m["input"], "kind": m["kind"], "sample": m["sample"]["asset"], "required": True} for m in preset["media"]],
                   "settings": [{"key": key, **value} for key, value in preset["settings"].items()]}
        response = await client.post("/api/builder/save", json=payload)
        assert response.status == 200, await response.text()
        return await response.json()

    updated = call(run)
    assert updated["id"] == e.id and updated["edited"] and not updated["draft"]
    override = engines.get(e.id)
    assert override.origin == "user" and override.path.parent == paths.user_root() / "templates"
    assert override.cover == e.cover and override.cover_video == e.cover_video
    assert all(p.is_file() for p in override.default_inputs.values())
    assert e.path.read_bytes() == original
    assert all(p.read_bytes() == content for p, content in media.items())
    assert jobs.MANAGER.list() == []
    restored = engines.reset_template(e.id)
    assert restored.origin == "shipped" and restored.label == e.label
    assert restored.path.read_bytes() == original


def test_copying_a_shipped_template_creates_a_new_id_and_leaves_source_intact(editable):
    e = engines.get("cloud/text-to-image-seedream-5-0-pro")
    original = e.path.read_bytes()
    preset = builder.cloud_preset(e)

    async def run(client):
        response = await client.post("/api/builder/save", json={
            "kind": "cloud", "base": e.id, "model": preset["model"], "label": "My separate photo template", "mode": e.mode,
            "media": [], "prompt": {"default": "A mountain", "required": True}, "params": [],
            "settings": [{"key": key, **value} for key, value in preset["settings"].items()],
        })
        assert response.status == 200, await response.text()
        return await response.json()

    copied = call(run)
    assert copied["id"] != e.id and copied["draft"]
    assert engines.get(e.id).origin == "shipped" and e.path.read_bytes() == original


def test_save_as_copy_does_not_replace_the_source(editable):
    tid, api = editable
    original = engines.get(tid).path.read_bytes()
    data = builder.assemble_local(_local_spec(label="Red hat copy"), {"workflow": api}, INFO)
    new = builder.save(data, {}, taken=set(engines.ENGINES))
    assert new != tid
    assert engines.get(tid).path.read_bytes() == original
    assert data["draft"] is True


def test_failed_sample_copy_leaves_original_template_and_sample_unchanged(editable, tmp_path, monkeypatch):
    from server.builder import assemble
    tid, api = editable
    e = engines.get(tid)
    original = e.path.read_bytes()
    sample = e.default_inputs["image:1"]
    sample_bytes = sample.read_bytes()
    replacement = make_image(tmp_path / "replacement.png", color=(1, 2, 3))
    data = builder.assemble_local(_local_spec(), {"workflow": api}, INFO)

    def partial_copy(src, dst):
        dst.write_bytes(b"incomplete copy")
        raise OSError("disk full")

    monkeypatch.setattr(assemble.shutil, "copyfile", partial_copy)
    with pytest.raises(OSError, match="disk full"):
        builder.save(data, {"image:1": replacement}, replace=tid)
    assert e.path.read_bytes() == original
    assert sample.read_bytes() == sample_bytes
    assert not list(sample.parent.glob(".sample-*"))


def test_edit_keeps_advanced_metadata_shared_bindings_and_unbound_controls():
    base = {"source": "Original source", "size": {"multiple": 32, "inputs": {"image:1": "Original"}}, "inputs": [
        {"key": "steps", "type": "int", "advanced": True, "help": "Affects run time", "bind": [["1", "steps", "int"], ["2", "steps", "int"]]},
        {"key": "sound", "type": "bool", "default": True, "bind": []},
    ]}
    data = {"kind": "local", "inputs": [{"key": "steps", "type": "int", "default": 12, "bind": [["1", "steps", "int"]]}]}
    builder.inherit(data, copy.deepcopy(base), "Original", editing=True)
    assert data["inputs"][0]["advanced"] and data["inputs"][0]["help"] == "Affects run time"
    assert data["inputs"][0]["bind"] == base["inputs"][0]["bind"]
    assert data["inputs"][0]["default"] == 12 and data["inputs"][1]["key"] == "sound"
    assert data["size"] == base["size"] and data["source"] == "Original source"


def test_locking_a_shared_local_control_updates_every_destination(editable):
    tid, api = editable
    base = copy.deepcopy(engines.get(tid).data)
    api["second"] = copy.deepcopy(api["12:5"])
    base["workflow"]["second"] = copy.deepcopy(base["workflow"]["12:5"])
    steps = next(f for f in base["inputs"] if f["key"] == "steps")
    steps["bind"].append(["second", "steps", "int"])
    fixed = [{"node": "12:5", "input": "steps", "value": 20}]
    data = builder.assemble_local(_local_spec(params=[], fixed=fixed), {"workflow": api}, INFO)
    builder.inherit(data, base, "Original", editing=True, fixed=fixed)
    assert data["workflow"]["12:5"]["inputs"]["steps"] == 20
    assert data["workflow"]["second"]["inputs"]["steps"] == 20
