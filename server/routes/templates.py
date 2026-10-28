"""Templates as the app sees them: the list, covers, text edits, duplicate and reset."""

from __future__ import annotations

import asyncio

from aiohttp import web

from .. import engines, store
from .common import API, err, body


def register(routes: web.RouteTableDef) -> None:
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
        q = request.query
        f = (engines.cover_before(e) if q.get("before") else engines.cover_file(e, video=bool(q.get("video")))) if e else None
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
        # A photo's cover is the full result, not its 960 px poster: it sits beside its full-size input.
        src = store.folder(m.id) / (m.result.file if m.result.kind == "image" and m.result.file else m.result.poster)
        loop = store.folder(m.id) / m.result.file if m.result.kind == "video" and m.result.file else None
        lead = next((i for i in m.inputs if i.slot == engines.lead_slot(e) and i.file), None)
        before = store.folder(m.id) / lead.file if lead else None  # shown beside the cover
        try:
            await asyncio.to_thread(engines.set_cover, e.id, src, loop, before)
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

    @routes.post(API + "/templates/hide")
    async def hide_template(request):
        b = await body(request)
        try:
            engines.hide_template(str(b.get("engine", "")), bool(b.get("hidden", True)))
        except KeyError:
            return err(404, "No such template")
        return web.json_response({"ok": True})

    @routes.delete(API + "/templates")
    async def reset_template(request):
        try:
            e = engines.reset_template(request.query.get("engine", ""))
        except KeyError:
            return err(409, "This template has no edits to undo")
        return web.json_response(engines.describe(e))
