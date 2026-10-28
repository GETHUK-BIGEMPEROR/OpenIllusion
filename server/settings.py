"""User settings, including the Comfy API key.

The key and the optional bearer token of a local comfy-api-proxy are never
written to disk by the server. The browser keeps them (localStorage) and sends them
with each request (``X-Comfy-Key``, ``X-Comfy-Proxy-Token``); the server holds them in
memory until it stops, so a restart forgets them until the browser sends them again.
They are never sent back to the browser (``public`` masks them), never in a
backup and never written into a generation.
"""

from __future__ import annotations

import json
import os
import threading

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
    # Character Lab saves RefMods here; a template's RefMod input lists what's in it. Empty: <home>/refmods.
    "refmod_folder": "",
    "max_parallel": 2,
    "community_indexes": [],
    "strip_exif": True,
    # Photos run at up to 3 MP and videos at up to 1.5 MP unless this lifts the cap (see prep.py).
    "uncap_size": False,
    "confirm_unknown_cost": True,
    "onboarded": False,
}

SECRETS = ("api_key", "local_token")

_lock = threading.Lock()
_session: dict[str, str] = {k: "" for k in SECRETS}  # in memory only


def _read(f) -> dict:
    try:
        d = json.loads(f.read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def load() -> dict:
    data = dict(DEFAULTS)
    data.update({k: v for k, v in _read(paths.settings_file()).items() if k not in SECRETS})
    data.update(_session)
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
    """Take the secrets the browser sent; True when one changed. Empty clears it."""
    changed = False
    with _lock:
        for k, v in (("api_key", key), ("local_token", token)):
            if v is not None and _session[k] != v.strip():
                _session[k] = v.strip()
                changed = True
    return changed


def save(changes: dict) -> dict:
    with _lock:
        data = load()
        for k, v in changes.items():
            if k in SECRETS:
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
    data["key_source"] = "browser" if key else ("env" if env_key else None)
    data["key_hint"] = f"…{shown[-4:]}" if len(shown) >= 8 else ("set" if shown else "")
    data["has_local_token"] = bool(token or os.environ.get("COMFY_PROXY_TOKEN"))
    return data
