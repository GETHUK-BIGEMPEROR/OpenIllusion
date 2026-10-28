"""What the app itself guards: cross-site writes, the page's headers, the key off the server's disk."""

import asyncio

from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from server import paths, routes, server, settings


def call(fn):
    async def go():
        app = web.Application(middlewares=[server._headers, server._same_origin, server._secrets])
        table = web.RouteTableDef()
        routes.register(table)
        app.add_routes(table)
        async with TestClient(TestServer(app)) as c:
            return await fn(c)
    return asyncio.run(go())


def test_a_write_from_another_site_is_refused():
    async def go(c):
        foreign = await c.post("/api/onboarded", headers={"Origin": "http://evil.example"})
        cross = await c.post("/api/onboarded", headers={"Sec-Fetch-Site": "cross-site"})
        mine = await c.post("/api/onboarded")
        return foreign.status, cross.status, mine.status
    assert call(go) == (403, 403, 200)


def test_every_response_carries_the_safety_headers():
    async def go(c):
        r = await c.get("/api/settings")
        return dict(r.headers)
    h = call(go)
    assert h["X-Content-Type-Options"] == "nosniff" and h["X-Frame-Options"] == "DENY"
    assert "frame-ancestors 'none'" in h["Content-Security-Policy"] and "script-src 'self'" in h["Content-Security-Policy"]


def test_the_key_arrives_with_a_request_and_never_goes_back():
    async def go(c):
        r = await c.get("/api/settings", headers={"X-Comfy-Key": "comfyui-header-key-4321"})
        return r.status, await r.text()
    status, text = call(go)
    assert status == 200 and '"has_key": true' in text and "comfyui-header-key-4321" not in text
    assert settings.api_key() == "comfyui-header-key-4321"
    assert not paths.secrets_file().exists()
