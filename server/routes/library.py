"""The library: generations, trash, storage, files, re-run, export and import."""

from __future__ import annotations

import asyncio
import json
import random
from pathlib import Path

import httpx
from aiohttp import web

from .. import bundle, engines, jobs, paths, storage, store
from .. import generation as sc
from .common import API, library_changed, err, body, _safe_file, _fetch_remote, spec_from_generation


def register(routes: web.RouteTableDef) -> None:
    # ---- library -----------------------------------------------------------------
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

    @routes.post(API + "/trash/purge")
    async def purge_many(request):
        """Delete the picked trashed generations for good."""
        ids = [str(i) for i in (await body(request)).get("ids") or []]

        def run():
            gone = []
            for i in ids:
                try:
                    if store.purge(i):
                        gone.append(i)
                except (ValueError, OSError):
                    continue
            return gone

        return web.json_response({"removed": await asyncio.to_thread(run)})

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
