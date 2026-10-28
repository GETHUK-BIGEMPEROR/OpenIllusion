"""Uploads, compose, run, and the job queue."""

from __future__ import annotations

import asyncio
import hashlib
import time
from pathlib import Path

import av
from aiohttp import web

from .. import edit, engines, jobs, media, paths, settings, staging, storage
from .common import API, UPLOAD_EXT, MAX_UPLOAD, err, body, _safe_file, asset_info, _norm_spec


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
            return err(415, f"{ext or 'This file type'} isn't supported. Photos: PNG, JPEG, WebP, GIF, TIFF, BMP, AVIF. "
                            "Clips: MP4, MOV, WebM, MKV, AVI, WMV, MPEG. Sound: MP3, WAV, M4A, AAC, OGG, FLAC, OPUS, WMA, AIFF.")
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
            if ext in edit.CONVERTED:  # TIFF, MKV, WMA...: turned into PNG, MP4, MP3 so browsers and models take it
                dst = await asyncio.to_thread(edit.normalize, dst)
                asset, name = dst.name, Path(name).stem + dst.suffix
            info = await asyncio.to_thread(asset_info, dst)
        except Exception as e:
            return err(422, f"Couldn't read {name}: {e}")
        return web.json_response({"asset": asset, "name": name, **info})

    @routes.post(API + "/media/edit")
    async def media_edit(request):
        """Crop, turn, resize, cut, resample or mute one photo, clip or sound: a new upload; the original stays."""
        b = await body(request)
        try:
            src = staging.resolve_asset(str(b["asset"]))
        except (KeyError, ValueError, FileNotFoundError):
            return err(404, "File not found")
        try:
            dst = await asyncio.to_thread(edit.edit, src, b.get("ops") or {})
            info = await asyncio.to_thread(asset_info, dst)
        except ValueError as e:
            return err(400, str(e))
        except (OSError, av.FFmpegError) as e:
            return err(422, f"Couldn't edit it: {e}")
        stem = Path(str(b.get("name") or src.name)).stem
        stem = stem[: -len("-edited")] if stem.endswith("-edited") else stem
        return web.json_response({"asset": dst.name, "name": f"{stem}-edited{dst.suffix}", **info})

    @routes.get(API + "/uploads/{asset}")
    async def get_upload(request):
        storage.touch(paths.uploads_dir() / Path(request.match_info["asset"]).name)  # shown on a page: still in use
        return _safe_file(paths.uploads_dir(), request.match_info["asset"])

    @routes.post(API + "/frame")
    async def frame(request):
        """Grab one frame of a video as a new image upload (Edit this frame)."""
        b = await body(request)
        try:
            src = staging.resolve_asset(b["asset"])
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

    # ---- compose, run --------------------------------------------------
    @routes.post(API + "/compose")
    async def compose(request):
        spec = await body(request)
        try:
            spec = _norm_spec(spec)
            out = engines.compose(spec)
        except (KeyError, ValueError) as e:
            return err(400, str(e))
        try:  # what the run will do to each input, fitted to the model; the studio shows it
            fx = await asyncio.to_thread(staging.fitted, spec, out["template"])
            out["prep"] = {slot: pl.to_dict() for slot, pl in fx.plans.items()}
            out["warnings"] += [n for n in fx.notes if (n["level"], n["text"]) not in {(w["level"], w["text"]) for w in out["warnings"]}]
        except (FileNotFoundError, ValueError, OSError, av.FFmpegError):
            out["prep"] = {}
        return web.json_response(out)

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
        if not errors:
            try:  # what can't be fitted to the model (a clip too short for it)
                errors = (await asyncio.to_thread(staging.fitted, spec, comp["template"])).errors
            except (FileNotFoundError, ValueError, OSError, av.FFmpegError) as ex:
                return err(400, str(ex))
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
