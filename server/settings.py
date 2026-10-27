"""User settings, including the Comfy API key.

The key and the optional bearer token of a local comfy-api-proxy live in
``secrets.json``, apart from the other settings: owner-only on Linux and macOS,
and never in a backup. They are never sent back to the browser (``public`` masks
them) and never written into a generation.
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


def _read(f) -> dict:
    try:
        d = json.loads(f.read_text("utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def load() -> dict:
    data = dict(DEFAULTS)
    data.update(_read(paths.settings_file()))  # a settings.json from before secrets.json may still hold them
    data.update({k: v for k, v in _read(paths.secrets_file()).items() if k in SECRETS})
    return data


def _write(data: dict) -> None:
    paths.write_atomic(paths.settings_file(), json.dumps({k: v for k, v in data.items() if k not in SECRETS}, indent=2))
    paths.write_atomic(paths.secrets_file(), json.dumps({k: data.get(k) or "" for k in SECRETS}, indent=2), private=True)


def migrate() -> None:
    """Move the secrets out of a settings.json written before secrets.json existed."""
    with _lock:
        if any(k in _read(paths.settings_file()) for k in SECRETS):
            _write(load())


def save(changes: dict) -> dict:
    with _lock:
        data = load()
        for k, v in changes.items():
            if k in DEFAULTS:
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
    data["key_source"] = "settings" if key else ("env" if env_key else None)
    data["key_hint"] = f"…{shown[-4:]}" if len(shown) >= 8 else ("set" if shown else "")
    data["has_local_token"] = bool(token or os.environ.get("COMFY_PROXY_TOKEN"))
    return data
