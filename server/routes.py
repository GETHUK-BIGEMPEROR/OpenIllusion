"""OpenIllusion's HTTP API, under /api, plus the built web app at /.

The browser only ever talks to these. The API key and the proxy token stay
on this side.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import random
import time
from pathlib import Path

import httpx
from aiohttp import web

from . import __version__, adapters, builder, bundle, engines, jobs, local, media, paths, proxy, settings, storage, store
from . import generation as sc
from .router import Router, RouterError

API = "/api"
APP_DIR = paths.package_root() / "static"
UPLOAD_EXT = {".png", ".jpg", ".jpeg", ".webp", ".mp4", ".mov", ".webm", ".m4v", *media.AUDIO_EXT}
MAX_UPLOAD = 500 * 1024 * 1024

_status_cache: dict = {"at": 0.0, "data": None}
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


def register(routes: web.RouteTableDef) -> None:
    # ---- the app -----------------------------------------------------------

    @routes.get("/")
    async def app_index(request):
        return _index()

    @routes.get("/assets/{path:.+}")
    async def app_assets(request):
        return _safe_file(APP_DIR / "assets", request.match_info["path"], cache=True)

    @routes.get("/static/{path:.+}")
    async def app_static(request):
        return _safe_file(APP_DIR / "static", request.match_info["path"], cache=True)

    @routes.get("/favicon.svg")
    async def favicon(request):
        return _safe_file(APP_DIR, "favicon.svg")

    @routes.get(API + "/ws")
    async def socket(request):
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        _sockets.add(ws)
        try:
            await ws.send_str(json.dumps({"type": "hello", "data": {"jobs": jobs.MANAGER.list()}}))
            async for _ in ws:
                pass  # the app only listens
        finally:
            _sockets.discard(ws)
        return ws

    # ---- status and settings ----------------------------------------------

    @routes.get(API + "/status")
    async def status(request):
        s = settings.public()
        router_state = {"ok": None, "reason": "no_key"}
        fresh = bool(request.query.get("fresh"))
        if s["has_key"]:
            now = time.time()
            if _status_cache["data"] and now - _status_cache["at"] < 60 and not fresh:
                router_state = _status_cache["data"]
            else:
                router_state = await _probe_router(Router())
                _status_cache.update(at=now, data=router_state)
        return web.json_response({
            "version": __version__, "has_key": s["has_key"], "router": router_state,
            "local": await _probe_local(),
            "onboarded": bool(settings.load().get("onboarded")),
        })

    @routes.post(API + "/local/proxy/start")
    async def local_proxy_start(request):
        return web.json_response({**await proxy.ensure(), "local": await _probe_local()})

    @routes.post(API + "/local/check")
    async def local_check(request):
        """What the user's ComfyUI lacks for this spec (or raw workflow)."""
        spec = _norm_spec(await body(request))
        try:
            e = engines.get(spec["engine"])
        except KeyError as ex:
            return err(404, str(ex))
        if e.kind != "local":
            return err(400, "Only local templates are checked against ComfyUI")
        workflow = spec.get("raw") or engines.compose(spec)["template"]
        try:
            info = await local.ComfyUI().object_info(fresh=bool(spec.get("fresh")))
        except httpx.HTTPError as ex:
            return web.json_response({"ok": False, "reachable": False, "message": f"ComfyUI unreachable: {ex.__class__.__name__}"})
        return web.json_response({"reachable": True, **local.check(workflow, info, e.hints)})

    @routes.post(API + "/key/test")
    async def key_test(request):
        b = await body(request)
        key = (b.get("key") or "").strip() or settings.api_key()
        if not key:
            return err(400, "Paste a Comfy API key first")
        state = await _probe_router(Router(key=key))
        if state["ok"] and b.get("save") and b.get("key"):
            settings.save({"api_key": key})
            _status_cache.update(at=time.time(), data=state)
        return web.json_response(state)

    @routes.get(API + "/settings")
    async def get_settings(request):
        return web.json_response(settings.public())

    @routes.post(API + "/settings")
    async def set_settings(request):
        b = await body(request)
        if "api_key" in b and not b["api_key"]:
            b.pop("api_key")  # an empty field means "unchanged"; use /key/forget to remove
        if "local_token" in b and not b["local_token"] and not b.get("clear_local_token"):
            b.pop("local_token")
        b.pop("clear_local_token", None)
        settings.save(b)
        _status_cache.update(at=0, data=None)
        out = settings.public()
        if b.get("local_v2_url") and "local_comfyui_url" not in b:
            # Pointed at an existing v2 server: its health names the ComfyUI behind it.
            try:
                upstream = (await local.ComfyV2().health()).get("upstream")
            except (httpx.HTTPError, local.V2Error, ValueError):
                upstream = None
            s = settings.load()
            if upstream and local.upstream_match(upstream, s["local_v2_url"], s["local_comfyui_url"]) is False:
                settings.save({"local_comfyui_url": local.upstream_seen_from_here(upstream, s["local_v2_url"])})
                out = {**settings.public(), "comfyui_from_upstream": True}
        return web.json_response(out)

    @routes.post(API + "/key/forget")
    async def key_forget(request):
        settings.save({"api_key": ""})
        _status_cache.update(at=0, data=None)
        return web.json_response(settings.public())

    @routes.post(API + "/onboarded")
    async def onboarded(request):
        settings.save({"onboarded": True})
        return web.json_response({"ok": True})

    # ---- engines ----------------------------------------------------------

    @routes.get(API + "/engines")
    async def list_engines(request):
        if request.query.get("reload"):
            engines.reload_templates()
        mode = request.query.get("mode")
        out = [engines.describe(e) for e in engines.ENGINES.values() if not mode or e.mode == mode]
        return web.json_response(out)

    # A template's card image: GET serves it, PUT sets it from a finished run of
    # that template (a cover always shows what it really makes), DELETE goes back
    # to the one it ships with. A built template's first cover publishes it.

    @routes.get(API + "/cover")
    async def get_cover(request):
        e = engines.ENGINES.get(request.query.get("engine", ""))
        f = engines.cover_file(e, video=bool(request.query.get("video"))) if e else None
        if f is None:
            return err(404, "No cover")
        return web.FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @routes.get(API + "/templates/input")
    async def template_input(request):
        get = engines.default_poster if request.query.get("poster") else engines.default_input
        try:
            f = get(request.query.get("engine", ""), request.query.get("slot", ""))
        except FileNotFoundError:
            return err(404, "No sample")
        return web.FileResponse(f, headers={"Cache-Control": "public, max-age=31536000, immutable"})

    @routes.put(API + "/cover")
    async def put_cover(request):
        b = await body(request)
        e = engines.ENGINES.get(b.get("engine", ""))
        if e is None:
            return err(404, "No such template")
        if not b.get("generation"):
            return err(400, "Send the generation whose result becomes the cover")
        try:
            m = store.get(b["generation"])
        except (FileNotFoundError, ValueError):
            return err(404, "Generation not found")
        if m.engine.model != e.id:
            return err(409, "Only a run of this template can be its cover")
        if m.status != "done" or not (m.result and m.result.poster):
            return err(409, "This run has no finished result to use yet")
        src = store.folder(m.id) / m.result.poster
        loop = store.folder(m.id) / m.result.file if m.result.kind == "video" and m.result.file else None
        try:
            await asyncio.to_thread(engines.set_cover, e.id, src, loop)
        except Exception as ex:
            return err(422, f"Couldn't make a cover from that file: {ex}")
        return web.json_response(engines.describe(e))

    @routes.delete(API + "/cover")
    async def delete_cover(request):
        e = engines.ENGINES.get(request.query.get("engine", ""))
        if e is None:
            return err(404, "No such template")
        engines.clear_cover(e.id)
        return web.json_response(engines.describe(e))

    # Editing a template's text: saved as an override in the user's templates
    # folder, so the shipped file never changes. DELETE goes back to it.

    @routes.patch(API + "/templates")
    async def patch_template(request):
        b = await body(request)
        try:
            e = engines.edit_template(str(b.pop("engine", "")), b)
        except KeyError:
            return err(404, "No such template")
        except ValueError as ex:
            return err(422, str(ex))
        return web.json_response(engines.describe(e))

    @routes.post(API + "/templates/duplicate")
    async def duplicate_template(request):
        try:
            e = await asyncio.to_thread(engines.duplicate_template, str((await body(request)).get("engine", "")))
        except KeyError:
            return err(404, "No such template")
        return web.json_response(engines.describe(e))

    @routes.delete(API + "/templates")
    async def reset_template(request):
        try:
            e = engines.reset_template(request.query.get("engine", ""))
        except KeyError:
            return err(409, "This template has no edits to undo")
        return web.json_response(engines.describe(e))

    # ---- template builder ----------------------------------------------------

    @routes.post(API + "/builder/workflow")
    async def builder_workflow(request):
        """Read a dropped workflow and list what a template could expose."""
        if request.content_type.startswith("multipart/"):
            part = await (await request.multipart()).next()
            if part is None or part.name != "file":
                return err(400, "Send the workflow as multipart field 'file'")
            name, data = part.filename or "workflow.json", await part.read(decode=False)
        else:
            b = await body(request)
            name, data = "workflow.json", str(b.get("text") or "").encode()
        if len(data) > 200 * 1024 * 1024:
            return err(413, "That file is too large to be a workflow")
        try:
            api_wf, ui_wf = await asyncio.to_thread(builder.read_workflow, name, data)
        except builder.BuildError as e:
            return err(422, str(e))
        comfy = local.ComfyUI()
        try:
            info = await comfy.object_info(fresh=True)
        except httpx.HTTPError:
            return err(503, f"ComfyUI isn't reachable at {comfy.base}. The builder reads node definitions from it, so start ComfyUI and drop the file again.")
        notes: list[str] = []
        fmt = "api" if api_wf is not None else "ui"
        try:
            if api_wf is None:
                api_wf, notes = builder.ui_to_api(ui_wf, info)
            a = builder.analyze(api_wf, info, notes)
        except builder.BuildError as e:
            return err(422, str(e))
        token = builder.put_draft(a["workflow"], name)
        # The sample each loader points at, when ComfyUI has it, opens as the template's default.
        for m in a["media"]:
            m["sample"] = None
            if not m.get("value") or Path(str(m["value"])).suffix.lower() not in UPLOAD_EXT:
                continue
            try:
                raw = await comfy.input_file(str(m["value"]))
            except httpx.HTTPError:
                raw = None
            if raw:
                ext = Path(str(m["value"])).suffix.lower()
                asset = hashlib.sha256(raw).hexdigest()[:24] + ext
                dst = paths.uploads_dir() / asset
                if not dst.exists():
                    dst.write_bytes(raw)
                try:
                    m["sample"] = {"asset": asset, "name": Path(str(m["value"])).name, **await asyncio.to_thread(asset_info, dst)}
                except Exception:
                    m["sample"] = None
        a.pop("workflow")
        return web.json_response({"token": token, "source": name, "format": fmt, **a})

    @routes.post(API + "/builder/from-template")
    async def builder_from_template(request):
        """Open a local template in the builder: its workflow read like a dropped one, plus how the template set it up."""
        b = await body(request)
        e = engines.ENGINES.get(str(b.get("engine") or ""))
        if e is None or e.kind != "local" or not e.workflow:
            return err(404, "Only local templates have a workflow to build from")
        comfy = local.ComfyUI()
        try:
            info = await comfy.object_info(fresh=True)
        except httpx.HTTPError:
            return err(503, f"ComfyUI isn't reachable at {comfy.base}. The builder reads node definitions from it, so start ComfyUI and try again.")
        wf = engines.defaults_workflow(e, every_input=True)
        engines.fill_media(wf, {i["slot"]: (e.default_inputs[i["slot"]].name if i["slot"] in e.default_inputs else "example.png") for i in e.inputs})
        try:
            a = builder.analyze(wf, info)
        except builder.BuildError as ex:
            return err(422, str(ex))
        slug = e.id.split("/", 1)[-1]
        token = builder.put_draft(a["workflow"], f"{slug}.json")
        # Each loader opens with the template's sample.
        where = {(str(t[0]), t[1]): slot for slot, binds in e.bindings.items() if ":" in slot for t in binds}
        for m in a["media"]:
            slot = where.get((m["node"], m["input"]))
            src = e.default_inputs.get(slot) if slot else None
            m["sample"] = None
            if src and src.is_file():
                raw = src.read_bytes()
                asset = hashlib.sha256(raw).hexdigest()[:24] + src.suffix.lower()
                dst = paths.uploads_dir() / asset
                if not dst.exists():
                    dst.write_bytes(raw)
                m["sample"] = {"asset": asset, "name": src.name, **await asyncio.to_thread(asset_info, dst)}
        a.pop("workflow")
        return web.json_response({"token": token, "source": f"{slug}.json", "format": "api", **a, "preset": builder.preset(e)})

    @routes.get(API + "/templates/workflow")
    async def template_workflow(request):
        """A local template as a ComfyUI workflow (API format) with its defaults. Its samples are put in
        ComfyUI's input folder, so the file runs as is when dropped into ComfyUI."""
        e = engines.ENGINES.get(request.query.get("engine", ""))
        if e is None or e.kind != "local" or not e.workflow:
            return err(404, "Only local templates have a workflow")
        slug = e.id.split("/", 1)[-1]
        wf = engines.defaults_workflow(e)
        comfy, names = local.ComfyUI(), {}
        for slot, src in e.default_inputs.items():
            if not src.is_file():
                continue
            names[slot] = f"openillusion_{slug}_{slot.replace(':', '')}{src.suffix.lower()}"
            try:
                names[slot] = await comfy.upload_input(src, names[slot])
            except (httpx.HTTPError, KeyError, ValueError):
                pass  # still a valid file; ComfyUI points at the missing input when it's opened
        engines.fill_media(wf, names)
        return web.Response(text=json.dumps(wf, indent=2, ensure_ascii=False), content_type="application/json",
                            headers={"Content-Disposition": f'attachment; filename="{slug}.json"', "Cache-Control": "no-store"})

    @routes.get(API + "/builder/models")
    async def builder_models(request):
        """The Router models a template can be built from: the ones with an adapter."""
        return web.json_response([adapters.describe(a) for a in adapters.all_adapters().values()])

    @routes.post(API + "/builder/save")
    async def builder_save(request):
        b = await body(request)
        replace = b.get("replace") or None
        if replace:
            old = engines.ENGINES.get(replace)
            if old is None or not old.built or old.origin != "user":
                return err(404, "Only templates you built can be replaced")
        try:
            if b.get("kind") == "cloud":
                data = builder.assemble_cloud(b)
            else:
                draft = builder.get_draft(str(b.get("token") or ""))
                try:
                    info = await local.ComfyUI().object_info()
                except httpx.HTTPError:
                    return err(503, "ComfyUI isn't reachable, so the workflow can't be checked. Start it and save again.")
                data = builder.assemble_local(b, draft, info)
                base = engines.ENGINES.get(str(b.get("base") or ""))
                if base is not None and base.data:
                    builder.inherit(data, base.data, base.label)
            samples = {}
            for m in builder._media_rows(b.get("media") or []):
                if m.get("sample"):
                    samples[m["slot"]] = jobs.resolve_asset(str(m["sample"]))
            tid = builder.save(data, samples, replace=replace, taken=set(engines.ENGINES))
        except (builder.BuildError, KeyError, ValueError) as e:
            return err(422, str(e))
        engines.reload_templates()
        return web.json_response(engines.describe(engines.ENGINES[tid]))

    @routes.delete(API + "/builder/template")
    async def builder_delete(request):
        try:
            engines.delete_template(request.query.get("engine", ""))
        except KeyError:
            return err(409, "Only templates you built can be deleted")
        return web.json_response({"ok": True})

    # ---- uploads -------------------------------------------------------------

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

    # ---- compose, estimate, run -------------------------------------------------

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

    # ---- library ---------------------------------------------------------------

    @routes.get(API + "/generations")
    async def list_generations(request):
        q = request.query
        hd = q.get("has_driving")
        rows = store.query(
            shelf=q.get("shelf") or None, q=q.get("q") or None, mode=q.get("mode") or None,
            model=q.get("model") or None, outcome=q.get("outcome") or None, tag=q.get("tag") or None,
            has_driving=None if hd in (None, "") else hd == "1",
            limit=min(20000, int(q["limit"])) if q.get("limit", "").isdigit() and int(q["limit"]) > 0 else 200,
        )
        return web.json_response(rows)

    @routes.get(API + "/facets")
    async def facets(request):
        return web.json_response(store.facets())

    @routes.get(API + "/generations/{id}")
    async def get_generation(request):
        sid = request.match_info["id"]
        try:
            m = store.get(sid)
        except (FileNotFoundError, ValueError):
            return err(404, "Generation not found")
        d = sc.dump(m)
        d["_shelf"] = store.shelf_of(sid)
        d["_variants"] = store.variants(m.lineage.parent) if m.lineage.parent else []
        return web.json_response(d)

    @routes.patch(API + "/generations/{id}")
    async def patch_generation(request):
        b = await body(request)
        allowed = {k: v for k, v in b.items() if k in ("title", "outcome", "notes", "tags", "starred")}
        try:
            m = store.update(request.match_info["id"], **allowed)
        except FileNotFoundError:
            return err(404, "Generation not found")
        except sc.ManifestError as e:
            return err(422, str(e))
        library_changed(m.id)
        return web.json_response(sc.dump(m))

    @routes.delete(API + "/generations/{id}")
    async def delete_generation(request):
        gid = request.match_info["id"]
        if gid in jobs.MANAGER.active_ids():
            return err(409, "This run is still going. Cancel it first.")
        try:
            store.delete(gid)
        except ValueError:
            return err(404, "Generation not found")
        library_changed(gid)
        return web.json_response({"ok": True, "trash_days": store.TRASH_DAYS})

    # Bulk: Clear all, clear a day, and Select → Move to trash. Runs still going are kept.
    @routes.post(API + "/generations/trash")
    async def trash_many(request):
        ids = [str(i) for i in (await body(request)).get("ids") or []]
        active = jobs.MANAGER.active_ids()
        moved = await asyncio.to_thread(store.delete_many, [i for i in ids if i not in active])
        if moved:
            library_changed(*moved)
        return web.json_response({"moved": moved, "kept": [i for i in ids if i in active], "trash_days": store.TRASH_DAYS})

    @routes.get(API + "/trash")
    async def list_trash(request):
        return web.json_response(await asyncio.to_thread(store.trash))

    @routes.post(API + "/trash/{id}/restore")
    async def restore(request):
        try:
            m = store.restore(request.match_info["id"])
        except (FileNotFoundError, ValueError):
            return err(404, "Not in the trash")
        library_changed(m.id)
        return web.json_response(sc.dump(m))

    @routes.post(API + "/trash/restore")
    async def restore_many(request):
        ids = [str(i) for i in (await body(request)).get("ids") or []]
        back = []
        for i in ids:
            try:
                back.append(store.restore(i).id)
            except (FileNotFoundError, ValueError, OSError):
                continue
        if back:
            library_changed(*back)
        return web.json_response({"restored": back})

    @routes.delete(API + "/trash/{id}")
    async def purge_one(request):
        try:
            ok = await asyncio.to_thread(store.purge, request.match_info["id"])
        except ValueError:
            ok = False
        return web.json_response({"ok": ok}) if ok else err(404, "Not in the trash")

    @routes.delete(API + "/trash")
    async def empty_trash(request):
        return web.json_response({"removed": await asyncio.to_thread(store.empty_trash)})

    @routes.get(API + "/trash/{id}/file/{path:.+}")
    async def trash_file(request):
        try:
            base = store.trash_folder(request.match_info["id"])
        except ValueError:
            return err(404, "Not found")
        return _safe_file(base, request.match_info["path"])

    # ---- storage -----------------------------------------------------------------

    @routes.get(API + "/storage")
    async def storage_usage(request):
        return web.json_response(await asyncio.to_thread(storage.usage))

    @routes.post(API + "/storage/clean")
    async def storage_clean(request):
        try:
            out = await asyncio.to_thread(storage.clean, str((await body(request)).get("bucket", "")))
        except ValueError as e:
            return err(422, str(e))
        return web.json_response(out)

    @routes.get(API + "/generations/{id}/file/{path:.+}")
    async def generation_file(request):
        try:
            base = store.folder(request.match_info["id"])
        except ValueError:
            return err(404, "Generation not found")
        return _safe_file(base, request.match_info["path"])

    @routes.get(API + "/generations/{id}/output")
    async def generation_output(request):
        """The full-resolution output file, with its recipe embedded."""
        try:
            m = store.get(request.match_info["id"])
        except (FileNotFoundError, ValueError):
            return err(404, "Generation not found")
        p = Path(m.result.output_file) if m.result and m.result.output_file else None
        if not p or not p.is_file():
            return err(404, "Output file not on this machine")
        return web.FileResponse(p, headers={"Content-Disposition": f'attachment; filename="{p.name}"'})

    @routes.get(API + "/generations/{id}/workflow")
    async def generation_workflow(request):
        try:
            base = store.folder(request.match_info["id"])
        except ValueError:
            return err(404, "Generation not found")
        return _safe_file(base, "comfy/workflow.json")

    @routes.post(API + "/generations/{id}/rerun")
    async def rerun(request):
        sid = request.match_info["id"]
        try:
            m = store.get(sid)
        except FileNotFoundError:
            return err(404, "Generation not found")
        b = await body(request)
        spec = spec_from_generation(m)
        if b.get("engine"):
            spec["engine"] = b["engine"]
            spec.pop("raw", None)
        else:
            raw = json.loads(json.dumps(m.request_template))
            if "seed" in raw or "seed" in spec["params"]:
                seed = random.randint(0, 2**31 - 1)
                spec["params"]["seed"] = seed
                if "seed" in raw:
                    raw["seed"] = seed
                try:
                    e = engines.get(m.engine.model)
                except KeyError:
                    e = None
                for t in (e.bindings.get("params.seed", []) if e and e.kind == "local" else []):
                    if str(t[0]) in raw:  # the seed lives inside a workflow node
                        raw[str(t[0])]["inputs"][t[1]] = seed
            spec["raw"] = raw
        missing = [i["slot"] for i in spec["inputs"] if not i.get("asset") and not i.get("url")]
        if missing:
            return err(409, "This generation is missing media: " + ", ".join(missing) + ". Remix it and add your own.", missing=missing)
        try:
            ids = await jobs.MANAGER.start(spec)
        except (FileNotFoundError, ValueError) as e:
            return err(400, str(e))
        return web.json_response({"ids": ids})

    # ---- share -------------------------------------------------------------------

    @routes.get(API + "/generations/{id}/export/sizes")
    async def export_sizes(request):
        try:
            return web.json_response(bundle.estimate_sizes(request.match_info["id"]))
        except FileNotFoundError:
            return err(404, "Generation not found")

    @routes.get(API + "/generations/{id}/recipe")
    async def recipe(request):
        try:
            m = store.get(request.match_info["id"])
        except FileNotFoundError:
            return err(404, "Generation not found")
        r = bundle.recipe_only(m)
        return web.json_response({"recipe": r, "link": bundle.link(r), "bytes": len(json.dumps(r).encode())})

    @routes.post(API + "/generations/{id}/export")
    async def export(request):
        b = await body(request)
        try:
            out = await asyncio.to_thread(
                bundle.export, request.match_info["id"], b.get("variant", "light"),
                bool(b.get("strip_driving")), b.get("attest") or {}, None, b.get("embed_recipe", True) is not False,
            )
        except ValueError as e:
            return err(422, str(e))
        except FileNotFoundError:
            return err(404, "Generation not found")
        return web.json_response({
            "path": str(out), "name": out.name, "bytes": out.stat().st_size,
            "download": f"{API}/exports/{out.name}",
        })

    @routes.get(API + "/exports/{name}")
    async def get_export(request):
        name = request.match_info["name"]
        resp = _safe_file(paths.output_root() / "generations", name)
        if isinstance(resp, web.FileResponse):
            resp.headers["Content-Disposition"] = f'attachment; filename="{name}"'
        return resp

    # ---- import ------------------------------------------------------------------

    @routes.post(API + "/import")
    async def import_inspect(request):
        bundle.cleanup_staging()
        name = ""
        if request.content_type.startswith("multipart/"):
            reader = await request.multipart()
            part = await reader.next()
            if part is None:
                return err(400, "No file")
            name = part.filename or ""
            data = bytearray()
            while chunk := await part.read_chunk(1 << 20):
                data += chunk
                if len(data) > bundle.MAX_TOTAL:
                    return err(413, "Bundle over 300 MB")
            data = bytes(data)
        elif request.content_type == "application/json":
            b = await body(request)
            if b.get("url"):
                try:
                    data, name = await _fetch_remote(b["url"])
                except (httpx.HTTPError, ValueError) as e:
                    return err(502, f"Couldn't fetch that link: {e}")
            else:
                data = (b.get("text") or "").encode()
        else:
            data = await request.read()
        try:
            review = await asyncio.to_thread(bundle.inspect, data, name)
        except bundle.ImportRefused as e:
            return err(422, str(e))
        return web.json_response(review)

    @routes.get(API + "/import/{token}/file/{path:.+}")
    async def import_file(request):
        token = request.match_info["token"]
        if not token.isdigit():
            return err(404, "Not found")
        return _safe_file(bundle.staging_dir() / token, request.match_info["path"])

    @routes.post(API + "/import/{token}/commit")
    async def import_commit(request):
        try:
            m = await asyncio.to_thread(bundle.commit, request.match_info["token"])
        except (FileNotFoundError, ValueError) as e:
            return err(410, str(e))
        library_changed(m.id)
        return web.json_response(sc.dump(m))

    @routes.get(API + "/community")
    async def community(request):
        """Read a public index.json. Fetched here to dodge CORS; nothing is hosted."""
        url = request.query.get("url", "")
        try:
            data, _ = await _fetch_remote(url, limit=2 * 1024 * 1024)
            idx = json.loads(data)
        except (httpx.HTTPError, ValueError) as e:
            return err(502, f"Couldn't read that index: {e}")
        items = idx.get("generations", idx) if isinstance(idx, dict) else idx
        if not isinstance(items, list):
            return err(422, "index.json should list generations")
        out = []
        for it in items[:500]:
            if isinstance(it, str):
                it = {"url": it}
            if isinstance(it, dict) and isinstance(it.get("url"), str):
                out.append({k: it.get(k) for k in ("url", "title", "mode", "model", "poster", "author", "tags")})
        return web.json_response({"name": idx.get("name") if isinstance(idx, dict) else None, "generations": out})


# ---- helpers ------------------------------------------------------------------------


def _index():
    index = APP_DIR / "index.html"
    if not index.exists():
        return web.Response(
            text="OpenIllusion's web app isn't built yet. Run `npm install && npm run build` in ui/.",
            content_type="text/plain", status=503,
        )
    return web.FileResponse(index, headers={"Cache-Control": "no-cache"})


async def _probe_local() -> dict:
    """Is Comfy API v2 up, and is ComfyUI behind it?"""
    s = settings.load()
    out = {
        "v2_url": s["local_v2_url"], "comfyui_url": s["local_comfyui_url"],
        "v2": False, "comfyui": False, "managed": proxy.running(), "proxy_installed": proxy.available(),
        "autostart": bool(s.get("local_autostart_proxy")),
    }
    try:
        h = await local.ComfyV2().health()
        out["v2"] = True
        out["upstream"] = h.get("upstream")
        out["upstream_match"] = local.upstream_match(out["upstream"], s["local_v2_url"], s["local_comfyui_url"])
        if out["upstream"]:
            out["upstream_seen"] = local.upstream_seen_from_here(out["upstream"], s["local_v2_url"])
        if out["upstream_match"] is False:
            out["reason"] = "upstream_mismatch"
    except local.V2Error as e:
        out["reason"] = "bad_token" if e.status == 401 else e.code
    except httpx.HTTPError:
        out["reason"] = "v2_down"
    try:
        st = await local.ComfyUI().system_stats()
        out["comfyui"] = True
        dev = (st.get("devices") or [{}])[0]
        out["gpu"] = dev.get("name")
        out["vram_total"] = dev.get("vram_total")
        out["vram_free"] = dev.get("vram_free")
        out["comfyui_version"] = (st.get("system") or {}).get("comfyui_version")
    except (httpx.HTTPError, ValueError):
        out["reason"] = out.get("reason") or "comfyui_down"
    out["ok"] = out["v2"] and out["comfyui"] and out.get("upstream_match") is not False
    return out


def _safe_file(base: Path, rel: str, cache: bool = False):
    base = base.resolve()
    p = (base / rel).resolve()
    if base not in p.parents or not p.is_file():
        return err(404, "Not found")
    headers = {"Cache-Control": "public, max-age=31536000, immutable" if cache else "no-cache"}
    return web.FileResponse(p, headers=headers)


async def _probe_router(r: Router) -> dict:
    try:
        async with r._client() as c:
            resp = await c.get("/v2/models", params={"limit": 1})
        if resp.status_code == 200:
            return {"ok": True, "reason": None}
        from .router import read_error

        e = read_error(resp)
        return {"ok": False, "reason": e.error_type, "message": e.message, "status": e.status}
    except httpx.HTTPError as e:
        return {"ok": False, "reason": "unreachable", "message": str(e)}


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


def _spec_resolver(spec: dict):
    """Resolve tokens straight from uploads (for estimates, before a generation exists)."""
    by_slot = {i["slot"]: i for i in spec["inputs"]}

    def resolve(kind, n, form):
        item = by_slot.get(f"{kind}:{n}")
        if not item:
            raise KeyError(f"{kind}:{n}")
        if form == "url":
            return item.get("url") or ""
        if not item.get("asset"):
            raise KeyError(f"{kind}:{n} has no media yet")
        p = jobs.resolve_asset(item["asset"])
        if kind == "image":
            uri, b64 = media.image_payload(p)
            return b64 if form == "b64" else uri
        # A placeholder of roughly the right size is enough for pricing.
        return "data:video/mp4;base64," + "A" * 64

    return resolve


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



