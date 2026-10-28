"""The built app, the WebSocket, status, settings, the API key and the local check."""

from __future__ import annotations

import json
import time

import httpx
from aiohttp import web

from .. import __version__, engines, jobs, local, proxy, settings
from ..router import Router
from .common import API, APP_DIR, _sockets, err, body, _safe_file, _norm_spec


_status_cache: dict = {"at": 0.0, "data": None}


def register(routes: web.RouteTableDef) -> None:
    # ---- the app -----------------------------------------------------------------
    @routes.get("/")
    async def app_index(request):
        return _index()

    @routes.get("/assets/{path:.+}")
    async def app_assets(request):
        return _safe_file(APP_DIR / "assets", request.match_info["path"], cache=True)

    @routes.get("/static/{path:.+}")
    async def app_static(request):
        return _safe_file(APP_DIR / "static", request.match_info["path"], cache=True)

    @routes.get("/favicon.svg")
    async def favicon(request):
        return _safe_file(APP_DIR, "favicon.svg")

    @routes.get(API + "/ws")
    async def socket(request):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        _sockets.add(ws)
        try:
            await ws.send_str(json.dumps({"type": "hello", "data": {"jobs": jobs.MANAGER.list()}}))
            async for _ in ws:
                pass  # the app only listens
        finally:
            _sockets.discard(ws)
        return ws

    # ---- status and settings -----------------------------------------------------
    @routes.get(API + "/status")
    async def status(request):
        s = settings.public()
        router_state = {"ok": None, "reason": "no_key"}
        fresh = bool(request.query.get("fresh"))
        if s["has_key"]:
            now = time.time()
            if _status_cache["data"] and now - _status_cache["at"] < 60 and not fresh and _status_cache.get("key") == settings.api_key():
                router_state = _status_cache["data"]
            else:
                router_state = await _probe_router(Router())
                _status_cache.update(at=now, data=router_state, key=settings.api_key())
        return web.json_response({
            "version": __version__, "has_key": s["has_key"], "router": router_state,
            "local": await _probe_local(),
            "onboarded": bool(settings.load().get("onboarded")),
        })

    @routes.post(API + "/local/proxy/start")
    async def local_proxy_start(request):
        return web.json_response({**await proxy.ensure(), "local": await _probe_local()})

    @routes.post(API + "/local/check")
    async def local_check(request):
        """What the user's ComfyUI lacks for this spec (or raw workflow)."""
        spec = _norm_spec(await body(request))
        try:
            e = engines.get(spec["engine"])
        except KeyError as ex:
            return err(404, str(ex))
        if e.kind != "local":
            return err(400, "Only local templates are checked against ComfyUI")
        workflow = spec.get("raw") or engines.compose(spec)["template"]
        try:
            info = await local.ComfyUI().object_info(fresh=bool(spec.get("fresh")))
        except httpx.HTTPError as ex:
            return web.json_response({"ok": False, "reachable": False, "message": f"ComfyUI unreachable: {ex.__class__.__name__}"})
        return web.json_response({"reachable": True, **local.check(workflow, info, e.hints)})

    @routes.post(API + "/key/test")
    async def key_test(request):
        b = await body(request)
        key = (b.get("key") or "").strip() or settings.api_key()
        if not key:
            return err(400, "Paste a Comfy API key first")
        state = await _probe_router(Router(key=key))
        if state["ok"] and b.get("save") and b.get("key"):
            settings.save({"api_key": key})
            _status_cache.update(at=time.time(), data=state, key=key)
        return web.json_response(state)

    @routes.get(API + "/settings")
    async def get_settings(request):
        return web.json_response(settings.public())

    @routes.post(API + "/settings")
    async def set_settings(request):
        b = await body(request)
        if "api_key" in b and not b["api_key"]:
            b.pop("api_key")  # an empty field means "unchanged"; use /key/forget to remove
        if "local_token" in b and not b["local_token"] and not b.get("clear_local_token"):
            b.pop("local_token")
        b.pop("clear_local_token", None)
        settings.save(b)
        _status_cache.update(at=0, data=None)
        out = settings.public()
        if b.get("local_v2_url") and "local_comfyui_url" not in b:
            # Pointed at an existing v2 server: its health names the ComfyUI behind it.
            try:
                upstream = (await local.ComfyV2().health()).get("upstream")
            except (httpx.HTTPError, local.V2Error, ValueError):
                upstream = None
            s = settings.load()
            if upstream and local.upstream_match(upstream, s["local_v2_url"], s["local_comfyui_url"]) is False:
                settings.save({"local_comfyui_url": local.upstream_seen_from_here(upstream, s["local_v2_url"])})
                out = {**settings.public(), "comfyui_from_upstream": True}
        return web.json_response(out)

    @routes.post(API + "/key/forget")
    async def key_forget(request):
        settings.save({"api_key": ""})
        _status_cache.update(at=0, data=None)
        return web.json_response(settings.public())

    @routes.post(API + "/onboarded")
    async def onboarded(request):
        settings.save({"onboarded": True})
        return web.json_response({"ok": True})


# ---- helpers ------------------------------------------------------------


def _index():
    index = APP_DIR / "index.html"
    if not index.exists():
        return web.Response(
            text="OpenIllusion's web app isn't built yet. Run `npm install && npm run build` in ui/.",
            content_type="text/plain", status=503,
        )
    return web.FileResponse(index, headers={"Cache-Control": "no-cache"})


async def _probe_local() -> dict:
    """Is Comfy API v2 up, and is ComfyUI behind it?"""
    s = settings.load()
    out = {
        "v2_url": s["local_v2_url"], "comfyui_url": s["local_comfyui_url"],
        "v2": False, "comfyui": False, "managed": proxy.running(), "proxy_installed": proxy.available(),
        "autostart": bool(s.get("local_autostart_proxy")),
    }
    try:
        h = await local.ComfyV2().health()
        out["v2"] = True
        out["upstream"] = h.get("upstream")
        out["upstream_match"] = local.upstream_match(out["upstream"], s["local_v2_url"], s["local_comfyui_url"])
        if out["upstream"]:
            out["upstream_seen"] = local.upstream_seen_from_here(out["upstream"], s["local_v2_url"])
        if out["upstream_match"] is False:
            out["reason"] = "upstream_mismatch"
    except local.V2Error as e:
        out["reason"] = "bad_token" if e.status == 401 else e.code
    except httpx.HTTPError:
        out["reason"] = "v2_down"
    try:
        st = await local.ComfyUI().system_stats()
        out["comfyui"] = True
        dev = (st.get("devices") or [{}])[0]
        out["gpu"] = dev.get("name")
        out["vram_total"] = dev.get("vram_total")
        out["vram_free"] = dev.get("vram_free")
        out["comfyui_version"] = (st.get("system") or {}).get("comfyui_version")
    except (httpx.HTTPError, ValueError):
        out["reason"] = out.get("reason") or "comfyui_down"
    out["ok"] = out["v2"] and out["comfyui"] and out.get("upstream_match") is not False
    return out


async def _probe_router(r: Router) -> dict:
    try:
        async with r._client() as c:
            resp = await c.get("/v2/models", params={"limit": 1})
        if resp.status_code == 200:
            return {"ok": True, "reason": None}
        from .router import read_error

        e = read_error(resp)
        return {"ok": False, "reason": e.error_type, "message": e.message, "status": e.status}
    except httpx.HTTPError as e:
        return {"ok": False, "reason": "unreachable", "message": str(e)}
