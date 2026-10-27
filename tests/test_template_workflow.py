"""A template as a ComfyUI workflow, and building a new template from one."""

import asyncio
import json

import httpx
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import builder, engines, local, routes

HAT = "local/qwen21-add-hat"
CREATE = "local/qwen21-create"


def call(fn):
    async def go():
        app = web.Application()
        table = web.RouteTableDef()
        routes.register(table)
        app.add_routes(table)
        async with TestClient(TestServer(app)) as c:
            return await fn(c)
    return asyncio.run(go())


def test_defaults_workflow_writes_the_defaults_in():
    e = engines.ENGINES[HAT]
    wf = engines.fill_media(engines.defaults_workflow(e), {"image:1": "hat.png"})
    text = json.dumps(wf)
    assert "{{" not in text  # no tokens left for ComfyUI to choke on
    assert wf["11"]["inputs"]["image"] == "hat.png"
    assert wf["5"]["inputs"]["prompt"] == e.default_prompt
    seed = wf["7"]["inputs"]["seed"]
    assert isinstance(seed, int) and seed >= 0


def test_download_still_works_when_comfyui_is_down(monkeypatch):
    async def down(self, path, name):
        raise httpx.ConnectError("down")
    monkeypatch.setattr(local.ComfyUI, "upload_input", down)

    async def go(c):
        r = await c.get("/api/templates/workflow", params={"engine": HAT})
        assert r.status == 200 and 'filename="qwen21-add-hat.json"' in r.headers["Content-Disposition"]
        wf = json.loads(await r.text())
        assert wf["11"]["inputs"]["image"] == "openillusion_qwen21-add-hat_image1" + engines.ENGINES[HAT].default_inputs["image:1"].suffix.lower()
        assert (await c.get("/api/templates/workflow", params={"engine": "local/nope"})).status == 404
        return True

    assert call(go)


def test_preset_mirrors_the_template():
    p = builder.preset(engines.ENGINES[HAT])
    assert p["base"] == HAT and p["label"].startswith("Add a hat (copy) · ")
    assert p["media"] == [{"node": "11", "input": "image", "slot": "image:1", **{k: v for k, v in p["media"][0].items() if k in ("label", "hint", "required")}}]
    assert p["prompt"]["node"] == "5" and p["prompt"]["input"] == "prompt" and p["prompt"]["default"] == engines.ENGINES[HAT].default_prompt
    assert p["params"] == [] and p["size"] is None


def test_inherit_keeps_the_multiple_and_nothing_hidden():
    hat = engines.ENGINES[HAT]
    data = {"inputs": [{"key": "image:1", "type": "image"}, {"key": "prompt", "type": "text"}], "workflow": hat.workflow}
    builder.inherit(data, hat.data, hat.label)
    assert data["size"] == {"multiple": 32} and "size" not in data["inputs"][0] and "tips" not in data
    assert data["source"].endswith(hat.label)
