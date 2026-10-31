"""Explore checks requirements in one read-only request, never by submitting jobs."""

import asyncio
from dataclasses import replace

import httpx
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import engines, local, routes


def call():
    async def get():
        app = web.Application()
        table = web.RouteTableDef()
        routes.register(table)
        app.add_routes(table)
        async with TestClient(TestServer(app)) as client:
            response = await client.get("/api/local/readiness")
            assert response.status == 200
            return await response.json()
    return asyncio.run(get())


def test_readiness_uses_one_snapshot_and_skips_cloud_drafts_and_hidden(monkeypatch):
    base = next(e for e in engines.ENGINES.values() if e.kind == "local")
    copies = {name: replace(base, id=name, draft=name == "draft", kind="cloud" if name == "cloud" else "local")
              for name in ("ready", "missing", "draft", "hidden", "cloud")}
    monkeypatch.setattr(engines, "ENGINES", copies)
    monkeypatch.setattr(engines, "hidden_templates", lambda: {"hidden"})
    snapshots = []

    async def snapshot(self, fresh=False):
        snapshots.append(fresh)
        return {"snapshot": True}

    def workflow(e, every_input=False):
        assert every_input
        return {"id": e.id}

    def check(wf, info, hints):
        assert info == {"snapshot": True}
        return {"ok": wf["id"] == "ready", "missing_nodes": [], "missing_models": [], "bad_values": []}

    monkeypatch.setattr(local.ComfyUI, "object_info", snapshot)
    monkeypatch.setattr(engines, "defaults_workflow", workflow)
    monkeypatch.setattr(local, "check", check)
    result = call()
    assert snapshots == [False]
    assert set(result["templates"]) == {"ready", "missing"}
    assert result["templates"]["ready"]["ok"]
    assert not result["templates"]["missing"]["ok"]


def test_readiness_reports_an_unreachable_comfyui(monkeypatch):
    async def offline(self, fresh=False):
        raise httpx.ConnectError("offline")
    monkeypatch.setattr(local.ComfyUI, "object_info", offline)
    result = call()
    assert result["reachable"] is False
    assert result["templates"] == {}


def test_readiness_isolates_a_broken_template(monkeypatch):
    base = next(e for e in engines.ENGINES.values() if e.kind == "local")
    monkeypatch.setattr(engines, "ENGINES", {"broken": replace(base, id="broken"), "good": base})

    async def snapshot(self, fresh=False):
        return {}

    def workflow(e, every_input=False):
        if e.id == "broken":
            raise ValueError("invalid binding")
        return {}

    monkeypatch.setattr(local.ComfyUI, "object_info", snapshot)
    monkeypatch.setattr(engines, "defaults_workflow", workflow)
    monkeypatch.setattr(local, "check", lambda *args: {"ok": True})
    result = call()
    assert result["templates"][base.id]["ok"]
    assert not result["templates"]["broken"]["ok"]


def test_readiness_checks_real_shipped_workflows(monkeypatch):
    async def snapshot(self, fresh=False):
        return {}  # No nodes installed: every local workflow must need setup.
    monkeypatch.setattr(local.ComfyUI, "object_info", snapshot)
    result = call()
    assert result["templates"]
    assert all(not entry["ok"] and entry["missing_nodes"] for entry in result["templates"].values())
