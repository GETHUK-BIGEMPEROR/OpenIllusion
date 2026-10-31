"""User settings, including the Comfy API key.

The key and the optional bearer token of a local comfy-api-proxy are never
written to disk by the server. The browser keeps them (localStorage) and sends them
with each request (``X-Comfy-Key``, ``X-Comfy-Proxy-Token``).

The key belongs to the browser that sent it: it lives for that request only
(``use_key``, a context variable), so another browser on the same server has no key
until it is given one. A run takes the key of the request that started it and keeps
it in memory until it ends (``jobs``). The proxy token is the machine's, held in
memory until the server stops. Neither is sent back to the browser (``public``
masks them), in a backup or written into a generation.
"""

from __future__ import annotations

import json
import os
import threading
from contextlib import contextmanager
from contextvars import ContextVar

from . import paths

DEFAULTS: dict = {
    "api_key": "",
    "router_base": "https://api.comfy.org",
    # Comfy Cloud's asset store: files a Router model only takes as a link are uploaded here.
    "cloud_base": "https://cloud.comfy.org",
    # Local: Comfy API v2 served by comfy-api-proxy in front of ComfyUI.
    "local_v2_url": "http://127.0.0.1:8189",
    "local_comfyui_url": "http://127.0.0.1:8188",
    "local_token": "",
    "local_autostart_proxy": True,
    "output_folder": "",
    "max_parallel": 2,
    "community_indexes": [],
    "strip_exif": True,
    # Photos run at up to 3 MP and videos at up to 1.5 MP unless this lifts the cap (see prep.py).
    "uncap_size": False,
    # Shipped templates taken off Explore (their files stay; Settings puts them back).
    "hidden_templates": [],
    "onboarded": False,
}

SECRETS = ("api_key", "local_token")

_lock = threading.Lock()
_session: dict[str, str] = {k: "" for k in SECRETS}  # the proxy token, in memory only
_key: ContextVar[str] = ContextVar("comfy_api_key", default="")  # this request's (or run's) key
_last = {"key": ""}  # the last key a browser sent: only for runs a restart left waiting


def use_key(key: str | None) -> None:
    """The key for this request, and every task it starts (a task copies it)."""
    key = (key or "").strip()
    _key.set(key)
    if key:
        _last["key"] = key


@contextmanager
def using_key(key: str):
    """Run a block with another key (a run's own), then go back to this request's."""
    t = _key.set((key or "").strip())
    try:
        yield
    finally:
        _key.reset(t)


def resume_key() -> str:
    """The key the latest browser sent, for a run resumed after a restart that has none of its own."""
    return _last["key"]


def _read(f) -> dict:
    try:
        d = json.loads(f.read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def load() -> dict:
    data = dict(DEFAULTS)
    # Where ComfyUI is when nothing's been saved yet: a container sets it to the host's address.
    if env := os.environ.get("OPENILLUSION_COMFYUI_URL", "").strip().rstrip("/"):
        data["local_comfyui_url"] = env
    data.update({k: v for k, v in _read(paths.settings_file()).items() if k not in SECRETS})
    data.update(_session)
    data["api_key"] = _key.get()
    return data


def _write(data: dict) -> None:
    paths.write_atomic(paths.settings_file(), json.dumps({k: v for k, v in data.items() if k not in SECRETS}, indent=2))


def migrate() -> None:
    """Delete secrets an older version wrote to disk (``secrets.json``, or ``settings.json`` before it)."""
    with _lock:
        if any(k in _read(paths.settings_file()) for k in SECRETS):
            _write(load())
        paths.secrets_file().unlink(missing_ok=True)


def remember(key: str | None = None, token: str | None = None) -> bool:
    """Take the secrets a request sent: the key for this request only, the token for the server.
    True when the token changed. Empty clears it."""
    use_key(key)
    with _lock:
        if token is not None and _session["local_token"] != token.strip():
            _session["local_token"] = token.strip()
            return True
    return False


def save(changes: dict) -> dict:
    with _lock:
        data = load()
        for k, v in changes.items():
            if k == "api_key":
                use_key(v)
                data[k] = _key.get()
            elif k in SECRETS:
                _session[k] = (v or "").strip()
                data[k] = _session[k]
            elif k in DEFAULTS:
                data[k] = v
        data["max_parallel"] = max(1, min(8, int(data.get("max_parallel") or 1)))
        for k in ("local_v2_url", "local_comfyui_url", "router_base", "cloud_base"):
            data[k] = (data.get(k) or DEFAULTS[k]).strip().rstrip("/")
        _write(data)
        return data


def api_key() -> str:
    return load().get("api_key") or os.environ.get("COMFY_API_KEY", "")


def local_token() -> str:
    return load().get("local_token") or os.environ.get("COMFY_PROXY_TOKEN", "")


def public() -> dict:
    data = load()
    key = data.pop("api_key", "") or ""
    token = data.pop("local_token", "") or ""
    env_key = os.environ.get("COMFY_API_KEY", "")
    shown = key or env_key
    data["has_key"] = bool(shown)
    data["key_source"] = "browser" if key else ("env" if env_key else None)  # browser: the one asking
    data["key_hint"] = f"…{shown[-4:]}" if len(shown) >= 8 else ("set" if shown else "")
    data["has_local_token"] = bool(token or os.environ.get("COMFY_PROXY_TOKEN"))
    return data
