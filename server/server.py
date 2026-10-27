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
from urllib.parse import urlparse

from aiohttp import web

from . import __version__, jobs, local, paths, proxy, routes, settings, store

log = logging.getLogger("openillusion")


async def _startup(app: web.Application) -> None:
    jobs.MANAGER.listeners.append(routes.broadcast)
    try:
        store.purge_trash()
        marker = paths.user_root() / ".starters"
        starters = paths.package_root() / "starters"
        if not marker.exists() and starters.is_dir():
            store.seed_starters(starters)
            marker.write_text("seeded", "utf-8")
        store.reindex()
    except Exception:
        log.exception("OpenIllusion: library check failed")
    n = jobs.MANAGER.resume()
    if n:
        log.info("OpenIllusion: resumed %d run(s)", n)
    app["proxy_keeper"] = asyncio.ensure_future(_keep_proxy())


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
    keeper = app.get("proxy_keeper")
    if keeper:
        keeper.cancel()
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


def make_app() -> web.Application:
    app = web.Application(client_max_size=600 * 1024 * 1024, middlewares=[_same_origin])
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
    if a.host not in ("127.0.0.1", "localhost", "::1"):
        log.warning("OpenIllusion: listening on %s. Anyone who can reach it can spend your Comfy credits.", a.host)
    url = f"http://{'127.0.0.1' if a.host in ('0.0.0.0', '::') else a.host}:{a.port}/"
    try:
        paths.claim_home(url)
    except paths.HomeInUse as e:
        log.error("OpenIllusion: another server is already using %s%s. Use that one, or give this one "
                  "its own home folder with OPENILLUSION_HOME.", paths.user_root(), f" ({e})" if str(e) else "")
        raise SystemExit(1) from None
    log.info("OpenIllusion %s at %s (home %s)", __version__, url, paths.user_root())
    if a.open:
        webbrowser.open(url)
    web.run_app(make_app(), host=a.host, port=a.port, print=None)


if __name__ == "__main__":
    main()
