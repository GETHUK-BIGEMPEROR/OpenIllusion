"""Backing up the whole library and restoring it: ``.illusionbackup``."""

from __future__ import annotations

import asyncio
import json
import shutil
import time

from aiohttp import web

from .. import backup, bundle, jobs, paths, storage
from ..archive import Refused, fmt_bytes
from .common import API, _push, _safe_file, body, err, library_changed

_busy: set[str] = set()  # one backup or restore at a time


def _reporter(kind: str):
    """Progress from a worker thread to every open tab, about once per percent."""
    loop = asyncio.get_running_loop()
    last = [-1]

    def report(done: int, total: int) -> None:
        pct = int(done * 100 / total) if total else 100
        if pct != last[0]:
            last[0] = pct
            loop.call_soon_threadsafe(_push, json.dumps({"type": kind, "data": {"done": done, "total": total}}))

    return report


def register(routes: web.RouteTableDef) -> None:
    @routes.post(API + "/backup")
    async def make_backup(request):
        """Write a backup to <output folder>/backups. Runs still being written are left out and listed."""
        b = await body(request)
        if _busy:
            return err(409, "A backup or restore is already running")
        _busy.add("backup")
        try:
            out = await asyncio.to_thread(backup.create, trash=bool(b.get("trash")),
                                          skip_ids=jobs.MANAGER.active_ids(), progress=_reporter("backup"))
        except OSError as e:
            return err(507, f"Couldn't write the backup: {e}")
        finally:
            _busy.discard("backup")
        return web.json_response({**out, "url": f"{API}/backup/file/{out['name']}"})

    @routes.get(API + "/backup/file/{name}")
    async def backup_file(request):
        name = request.match_info["name"]
        resp = _safe_file(storage.backups_dir(), name)
        if isinstance(resp, web.FileResponse):
            resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
        return resp

    @routes.post(API + "/restore")
    async def restore_inspect(request):
        """Receive a backup (streamed to disk, any size the disk can hold) and say what restoring it would do."""
        bundle.cleanup_staging()
        token = str(time.time_ns())
        folder = bundle.staging_dir() / token
        folder.mkdir()
        dst = folder / f"upload{backup.EXT}"
        room = shutil.disk_usage(paths.user_root()).free * 0.45  # the file, then what it unpacks to
        size = 0
        try:
            with open(dst, "wb") as f:
                while chunk := await request.content.read(1 << 20):
                    size += len(chunk)
                    if size > room:
                        raise Refused(f"Not enough free disk space for a backup this size ({fmt_bytes(size)} so far).")
                    f.write(chunk)
            review = await asyncio.to_thread(backup.inspect, dst, token)
        except Refused as e:
            shutil.rmtree(folder, ignore_errors=True)
            return err(422, str(e))
        return web.json_response(review)

    @routes.post(API + "/restore/{token}")
    async def restore_commit(request):
        token = request.match_info["token"]
        folder = bundle.staging_dir() / token
        src = folder / f"upload{backup.EXT}"
        if not token.isdigit() or not src.is_file():
            return err(404, "This restore expired. Drop the backup again.")
        if jobs.MANAGER.active_ids():
            return err(409, "Wait for the runs in progress to finish, then restore.")
        if _busy:
            return err(409, "A backup or restore is already running")
        _busy.add("restore")
        try:
            res = await asyncio.to_thread(backup.restore, src, folder / "unpack", progress=_reporter("restore"))
        except Refused as e:
            return err(422, str(e))
        finally:
            _busy.discard("restore")
            shutil.rmtree(folder, ignore_errors=True)
        library_changed()
        return web.json_response(res)
