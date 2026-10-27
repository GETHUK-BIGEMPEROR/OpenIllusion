"""Uploads, compose, estimate, run, and the job queue."""

from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path

import httpx
from aiohttp import web

from .. import engines, jobs, media, paths, settings
from ..router import Router, RouterError
from .common import API, UPLOAD_EXT, MAX_UPLOAD, err, body, _safe_file, asset_info, _norm_spec, _spec_resolver


def register(routes: web.RouteTableDef) -> None:
    # ---- uploads -----------------------------------------------------------------
    @routes.post(API + "/upload")
    async def upload(request):
        reader = await request.multipart()
        part = await reader.next()
        if part is None or part.name != "file":
            return err(400, "Send the file as multipart field 'file'")
        name = part.filename or "upload"
        ext = Path(name).suffix.lower()
        if ext not in UPLOAD_EXT:
            return err(415, f"{ext or 'This file type'} isn't supported. Use PNG, JPEG, WebP, MP4, MOV, WebM, or MP3, WAV, M4A for sound.")
        h = hashlib.sha256()
        tmp = paths.uploads_dir() / f"_incoming-{time.time_ns()}{ext}"
        size = 0
        with open(tmp, "wb") as f:
            while chunk := await part.read_chunk(1 << 20):
                size += len(chunk)
                if size > MAX_UPLOAD:
                    f.close()
                    tmp.unlink(missing_ok=True)
                    return err(413, "Upload over 500 MB")
                h.update(chunk)
                f.write(chunk)
        asset = h.hexdigest()[:24] + ext
        dst = paths.uploads_dir() / asset
        if dst.exists():
            tmp.unlink(missing_ok=True)
        else:
            tmp.replace(dst)
        try:
            info = await asyncio.to_thread(asset_info, dst)
        except Exception as e:
            return err(422, f"Couldn't read {name}: {e}")
        return web.json_response({"asset": asset, "name": name, **info})

    @routes.get(API + "/uploads/{asset}")
    async def get_upload(request):
        return _safe_file(paths.uploads_dir(), request.match_info["asset"])

    @routes.post(API + "/frame")
    async def frame(request):
        """Grab one frame of a video as a new image upload (Edit this frame)."""
        b = await body(request)
        try:
            src = jobs.resolve_asset(b["asset"])
        except (KeyError, ValueError, FileNotFoundError):
            return err(404, "Video not found")
        t = float(b.get("t") or 0)

        def grab():
            img = media.frame_at(src, t)
            import io

            buf = io.BytesIO()
            img.save(buf, "PNG")
            data = buf.getvalue()
            asset = hashlib.sha256(data).hexdigest()[:24] + ".png"
            (paths.uploads_dir() / asset).write_bytes(data)
            return asset, asset_info(paths.uploads_dir() / asset)

        asset, info = await asyncio.to_thread(grab)
        return web.json_response({"asset": asset, "name": f"frame-{t:.2f}s.png", **info})

    # ---- compose, estimate, run --------------------------------------------------
    @routes.post(API + "/compose")
    async def compose(request):
        spec = await body(request)
        try:
            spec = _norm_spec(spec)
            out = engines.compose(spec)
        except (KeyError, ValueError) as e:
            return err(400, str(e))
        try:  # what prep will do to each image; the studio shows it
            out["prep"] = {slot: pl.to_dict() for slot, pl in (await asyncio.to_thread(jobs.input_plans, spec)).items()}
        except (FileNotFoundError, ValueError, OSError):
            out["prep"] = {}
        return web.json_response(out)

    @routes.post(API + "/estimate")
    async def estimate(request):
        spec = _norm_spec(await body(request))
        if spec["engine"].startswith("local/"):
            return web.json_response({"source": "local"})
        try:
            comp = engines.compose(spec)
            if any(w["level"] == "error" for w in comp["warnings"]):
                return web.json_response({"source": "unknown", "reason": "incomplete"})
            resolver = _spec_resolver(spec)
            payload = await asyncio.to_thread(engines.materialize, comp["template"], resolver)
            est = await Router().estimate(engines.router_model(spec["engine"]), payload)
        except RouterError as e:
            if e.status == 422:
                return web.json_response({"source": "invalid", "router": e.to_dict()})
            return web.json_response({"source": "unknown", "reason": e.error_type})
        except (KeyError, FileNotFoundError, ValueError) as e:
            return web.json_response({"source": "unknown", "reason": str(e)})
        except httpx.HTTPError:
            return web.json_response({"source": "unknown", "reason": "router_unreachable"})
        return web.json_response(est)

    @routes.post(API + "/run")
    async def run(request):
        spec = _norm_spec(await body(request))
        try:
            e = engines.get(spec["engine"])
        except KeyError as ex:
            return err(404, str(ex))
        if e.kind == "cloud" and not settings.api_key():
            return err(401, "Add your Comfy API key in Settings to run cloud models")
        comp = engines.compose(spec)
        errors = [w for w in comp["warnings"] if w["level"] == "error"]
        if errors and not spec.get("raw"):
            return err(422, errors[0]["text"], warnings=errors)
        try:
            ids = await jobs.MANAGER.start(spec)
        except (FileNotFoundError, ValueError) as e:
            return err(400, str(e))
        return web.json_response({"ids": ids})

    @routes.get(API + "/jobs")
    async def list_jobs(request):
        return web.json_response(jobs.MANAGER.list())

    @routes.post(API + "/jobs/{id}/cancel")
    async def cancel_job(request):
        ok = await jobs.MANAGER.cancel(request.match_info["id"])
        return web.json_response({"ok": ok})

    @routes.post(API + "/jobs/{id}/dismiss")
    async def dismiss_job(request):
        jobs.MANAGER.dismiss(request.match_info["id"])
        return web.json_response(jobs.MANAGER.list())

    @routes.post(API + "/jobs/cancel")
    async def cancel_all_jobs(request):
        n = await jobs.MANAGER.cancel_all()
        return web.json_response({"cancelled": n, "jobs": jobs.MANAGER.list()})

    @routes.post(API + "/jobs/clear")
    async def clear_jobs(request):
        jobs.MANAGER.clear_finished()
        return web.json_response(jobs.MANAGER.list())
