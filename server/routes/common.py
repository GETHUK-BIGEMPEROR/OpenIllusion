"""Shared by the route modules: constants, the WebSocket push, request/response helpers."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
from aiohttp import web

from .. import bundle, edit, engines, media, paths, store, usage
from .. import generation as sc


API = "/api"
APP_DIR = paths.package_root() / "static"
# Taken as they are, plus formats turned into PNG, MP4 or MP3 on arrival (edit.normalize).
UPLOAD_EXT = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".webm", ".m4v", *media.AUDIO_EXT, *edit.CONVERTED}
MAX_UPLOAD = 500 * 1024 * 1024

_sockets: set[web.WebSocketResponse] = set()


def broadcast(job: dict) -> None:
    """Push a job update to every open app tab."""
    _push(json.dumps({"type": "job", "data": job}))


def library_changed(*ids: str) -> None:
    """Tell open tabs the library changed, so no tab shows a generation that's gone."""
    _push(json.dumps({"type": "library", "data": {"ids": list(ids)}}))


def _push(msg: str) -> None:
    for ws in list(_sockets):
        if ws.closed:
            _sockets.discard(ws)
            continue
        asyncio.ensure_future(_send(ws, msg))


async def _send(ws: web.WebSocketResponse, msg: str) -> None:
    try:
        await ws.send_str(msg)
    except (ConnectionError, RuntimeError):
        _sockets.discard(ws)


def err(status: int, message: str, **extra) -> web.Response:
    return web.json_response({"error": message, **extra}, status=status)



async def body(request: web.Request) -> dict:
    try:
        return await request.json()
    except (json.JSONDecodeError, ValueError):
        return {}


def _safe_file(base: Path, rel: str, cache: bool = False):
    base = base.resolve()
    p = (base / rel).resolve()
    if base not in p.parents or not p.is_file():
        return err(404, "Not found")
    headers = {"Cache-Control": "public, max-age=31536000, immutable" if cache else "no-cache"}
    return web.FileResponse(p, headers=headers)


async def _fetch_remote(url: str, limit: int = bundle.MAX_TOTAL) -> tuple[bytes, str]:
    if not url.startswith("https://") and not url.startswith("http://"):
        if url.startswith(bundle.LINK_PREFIX) or bundle.LINK_PREFIX in url:
            return url.encode(), "link"
        raise ValueError("Use an http(s) URL")
    if bundle.LINK_PREFIX in url:
        return url.encode(), "link"
    async with httpx.AsyncClient(timeout=60, follow_redirects=True) as c:
        async with c.stream("GET", url) as resp:
            resp.raise_for_status()
            data = bytearray()
            async for chunk in resp.aiter_bytes():
                data += chunk
                if len(data) > limit:
                    raise ValueError("file too large")
    return bytes(data), url.rsplit("/", 1)[-1].split("?")[0]


def asset_info(p: Path) -> dict:
    ext = p.suffix.lower()
    if ext in (".mp4", ".mov", ".webm", ".m4v"):
        info = media.probe(p)
        poster = p.with_suffix(p.suffix + ".poster.webp")
        if not poster.exists():
            try:
                media.poster(p, poster)
            except Exception:
                poster = None
        return {"kind": "video", **info, "bytes": p.stat().st_size,
                "url": f"{API}/uploads/{p.name}", "poster": f"{API}/uploads/{poster.name}" if poster else None}
    if ext in media.AUDIO_EXT:
        return {"kind": "audio", **media.audio_info(p), "bytes": p.stat().st_size, "url": f"{API}/uploads/{p.name}", "poster": None}
    img = media.open_image(p)
    return {"kind": "image", "width": img.width, "height": img.height, "bytes": p.stat().st_size,
            "url": f"{API}/uploads/{p.name}", "poster": f"{API}/uploads/{p.name}"}


def _norm_spec(spec: dict) -> dict:
    spec.setdefault("inputs", [])
    spec.setdefault("params", {})
    spec.setdefault("prompt", "")
    if "engine" not in spec:
        raise KeyError("engine")
    for i in spec["inputs"]:
        if i.get("trim") and i.get("duration"):
            a, b = float(i["trim"][0] or 0), float(i["trim"][1] or 0) or float(i["duration"])
            i["trimmed_duration"] = max(0.0, b - a)
    return spec




def spec_from_generation(m: sc.Manifest) -> dict:
    inputs = []
    for i in m.inputs:
        d = {
            "slot": i.slot, "role": i.role, "license": i.license, "contains_person": i.contains_person,
            "consent": i.consent, "url": i.url, "label": i.label,
        }
        if i.file and (store.folder(m.id) / i.file).exists():
            d["asset"] = f"gen:{m.id}/{i.file}"
        inputs.append(d)
    return {
        "engine": m.engine.model, "mode": m.mode, "title": m.title, "inputs": inputs, "prompt": m.prompt,
        "params": dict(m.params), "forked_from": m.id, "tags": m.tags,
    }


def template_info(e: engines.Engine, used: dict | None = None) -> dict:
    """A template as the app shows it, with when it last ran and how often. Every route that hands one
    back sends this, so the page's copy never loses its place in Recently used."""
    u = (usage.load() if used is None else used).get(e.id, {})
    return {**engines.describe(e), "used_at": u.get("at"), "uses": u.get("n", 0)}
