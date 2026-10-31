"""The standalone OpenIllusion server: ``python -m server`` or ``openillusion``.

Serves the web app and its API on one port. Cloud runs go to Comfy Router
with the user's key; local runs go to Comfy API v2 (comfy-api-proxy) in
front of the user's own ComfyUI.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import webbrowser
from pathlib import Path
from urllib.parse import urlparse

from aiohttp import web

from . import __version__, jobs, local, paths, proxy, routes, settings, storage, store

log = logging.getLogger("openillusion")


async def _startup(app: web.Application) -> None:
    jobs.MANAGER.listeners.append(routes.broadcast)
    try:
        settings.migrate()
        store.purge_trash()
        store.reindex()
    except Exception:
        log.exception("OpenIllusion: library check failed")
    n = jobs.MANAGER.resume()
    if n:
        log.info("OpenIllusion: resumed %d run(s)", n)
    app["proxy_keeper"] = asyncio.ensure_future(_keep_proxy())
    app["janitor"] = asyncio.ensure_future(_keep_clean())


async def _keep_clean(every: float = 6 * 3600) -> None:
    """Empty old trash and scratch now and then, so the home folder doesn't only grow."""
    while True:
        try:
            gone = await asyncio.to_thread(storage.auto_clean)
            purged = await asyncio.to_thread(store.purge_trash)
            if gone["files"] or purged:
                log.info("OpenIllusion: cleaned %d scratch file(s), %.1f MB; %d generation(s) out of the trash",
                         gone["files"], gone["bytes"] / 1e6, purged)
        except Exception:
            log.exception("OpenIllusion: cleaning failed")
        await asyncio.sleep(every)


async def _keep_proxy(every: float = 15.0) -> None:
    """Keep Comfy API v2 up while ComfyUI is, so local runs never wait on it or warn about it."""
    while True:
        try:
            if settings.load().get("local_autostart_proxy") and proxy.available():
                await local.ComfyUI().system_stats()  # only start the proxy in front of a live ComfyUI
                await proxy.ensure()
        except Exception:
            pass  # ComfyUI down or the proxy refused; the status dots and the precheck say so
        await asyncio.sleep(every)


async def _cleanup(app: web.Application) -> None:
    for task in (app.get("proxy_keeper"), app.get("janitor")):
        if task:
            task.cancel()
    # A process stop is not the same as the user cancelling a generation.
    # Leave active jobs in jobs.json so startup can resume/collect them.
    await jobs.MANAGER.shutdown()
    for ws in list(routes._sockets):
        await ws.close()
    proxy.stop()


@web.middleware
async def _same_origin(request: web.Request, handler):
    """Refuse cross-site writes, so a web page can't spend the user's credits.

    The app is same-origin (the Vite dev server proxies), so a browser request
    from anywhere else carries a foreign Origin and is turned away.
    """
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("Origin")
        if origin and urlparse(origin).netloc != request.host:
            return web.json_response({"error": "Cross-origin request refused"}, status=403)
        if request.headers.get("Sec-Fetch-Site") == "cross-site":
            return web.json_response({"error": "Cross-origin request refused"}, status=403)
    return await handler(request)


# The page runs only its own bundle: an injected script couldn't load or send anything
# elsewhere, and no other site can frame the app.
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; font-src 'self' data:; "
       "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")


@web.middleware
async def _headers(request: web.Request, handler):
    resp = await handler(request)
    if isinstance(resp, web.StreamResponse) and not isinstance(resp, web.WebSocketResponse) and not resp.prepared:
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Content-Security-Policy", CSP)
    return resp


@web.middleware
async def _secrets(request: web.Request, handler):
    """Take the key and proxy token the browser holds; the server keeps them in memory only."""
    key, token = request.headers.get("X-Comfy-Key"), request.headers.get("X-Comfy-Proxy-Token")
    if key or token:
        settings.remember(key=key or None, token=token or None)
    return await handler(request)


def make_app() -> web.Application:
    app = web.Application(client_max_size=600 * 1024 * 1024, middlewares=[_headers, _same_origin, _secrets])
    table = web.RouteTableDef()
    routes.register(table)
    app.add_routes(table)
    app.on_startup.append(_startup)
    app.on_cleanup.append(_cleanup)
    return app


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="openillusion", description="Motion + Edit studio for Comfy")
    ap.add_argument("--host", default="127.0.0.1", help="Address to listen on (default 127.0.0.1)")
    ap.add_argument("--port", type=int, default=7870, help="Port (default 7870)")
    ap.add_argument("--open", action="store_true", help="Open the app in a browser")
    ap.add_argument("--version", action="version", version=f"openillusion {__version__}")
    a = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)  # one line per poll otherwise
    if Path("/.dockerenv").exists():
        # Inside a container 0.0.0.0 is the norm; who reaches it is decided by the published port.
        log.info("OpenIllusion: in a container. Anyone who can reach the published port can spend your Comfy credits;"
                 " docker-compose.yml publishes it on the host's 127.0.0.1 only.")
    elif a.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("OpenIllusion: listening on %s. Anyone who can reach it can spend your Comfy credits.", a.host)
    url = f"http://{'127.0.0.1' if a.host in ('0.0.0.0', '::') else a.host}:{a.port}/"
    try:
        paths.claim_home(url)
    except paths.HomeInUse as e:
        if a.open and str(e).startswith("http"):
            # Started again (start.bat twice): bring up the one that's running.
            log.info("OpenIllusion is already running at %s; opening it.", e)
            webbrowser.open(str(e))
            raise SystemExit(0) from None
        log.error("OpenIllusion: another server is already using %s%s. Use that one, or give this one "
                  "its own home folder with OPENILLUSION_HOME.", paths.user_root(), f" ({e})" if str(e) else "")
        raise SystemExit(1) from None
    log.info("OpenIllusion %s at %s (home %s)", __version__, url, paths.user_root())
    if a.open:
        webbrowser.open(url)
    web.run_app(make_app(), host=a.host, port=a.port, print=None)


if __name__ == "__main__":
    main()
