"""Starts comfy-api-proxy for the user when Local is pointed at loopback.

The proxy is Comfy's own v2 server for a self-hosted ComfyUI. OpenIllusion only
launches it (as a child process, with its job state kept in OpenIllusion's home)
when the configured v2 address is local and nothing answers there yet.
"""

from __future__ import annotations

import asyncio
import logging
import subprocess
import sys
from urllib.parse import urlparse

from . import local, paths, settings

log = logging.getLogger("openillusion")

_proc: subprocess.Popen | None = None
_lock = asyncio.Lock()


def available() -> bool:
    try:
        import comfy_api_proxy  # noqa: F401
    except ImportError:
        return False
    return True


def running() -> bool:
    return _proc is not None and _proc.poll() is None


def _loopback(url: str) -> tuple[str, int] | None:
    u = urlparse(url)
    if u.hostname in ("127.0.0.1", "localhost", "::1") and u.scheme == "http":
        return u.hostname, u.port or 80
    return None


async def ensure() -> dict:
    """Make sure something serves v2 at the configured address."""
    s = settings.load()
    v2 = local.ComfyV2()
    try:
        health = await v2.health()
    except Exception:
        health = None
    if health is not None:
        upstream = health.get("upstream")
        if local.upstream_match(upstream, s["local_v2_url"], s["local_comfyui_url"]) is not False:
            return {"ok": True, "started": False, "managed": running(), "upstream": upstream}
        if not running():  # someone else's proxy, in front of another ComfyUI
            return {"ok": False, "reason": "upstream_mismatch", "managed": False, "upstream": upstream}
        log.info("OpenIllusion: ComfyUI address changed; restarting comfy-api-proxy")
        stop()  # ours, started for an earlier ComfyUI address
    target = _loopback(s["local_v2_url"])
    if not s.get("local_autostart_proxy") or not target:
        return {"ok": False, "reason": "proxy_down", "managed": False}
    if not available():
        return {"ok": False, "reason": "proxy_not_installed", "managed": False}
    async with _lock:
        global _proc
        if not running():
            state = paths.user_root() / "proxy-state"
            state.mkdir(exist_ok=True)
            cmd = [
                sys.executable, "-c", "from comfy_api_proxy.cli import main; main()",
                "--comfyui", s["local_comfyui_url"], "--port", str(target[1]),
                "--state-dir", str(state),
            ]
            if settings.local_token():
                cmd += ["--token", settings.local_token()]
            logf = open(paths.user_root() / "proxy.log", "ab")
            flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
            _proc = subprocess.Popen(cmd, stdout=logf, stderr=subprocess.STDOUT, creationflags=flags)
            log.info("OpenIllusion: started comfy-api-proxy on :%s (pid %s)", target[1], _proc.pid)
    ok = await local.wait_until_up(v2, 10.0)
    return {"ok": ok, "started": True, "managed": True, "reason": None if ok else "proxy_failed"}


def stop() -> None:
    global _proc
    if running():
        _proc.terminate()
        try:
            _proc.wait(5)
        except subprocess.TimeoutExpired:
            _proc.kill()
    _proc = None
