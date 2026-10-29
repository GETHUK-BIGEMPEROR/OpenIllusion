"""Templates as the app sees them: the list, covers, text edits, duplicate, reset and export."""

from __future__ import annotations

import asyncio

from aiohttp import web

from .. import engines, store, template_pack, usage
from .common import API, err, body, template_info


def register(routes: web.RouteTableDef) -> None:
    @routes.get(API + "/templates/export")
    async def export_template(request):
        """One template as a .illusion: its samples and cover inside. Adding it is /import."""
        try:
            data, name = await asyncio.to_thread(template_pack.export, request.query.get("engine", ""))
        except KeyError:
            return err(404, "No such template")
        return web.Response(body=data, content_type="application/zip",
                            headers={"Content-Disposition": f'attachment; filename="{name}"', "Cache-Control": "no-store"})

    @routes.get(API + "/engines")
    async def list_engines(request):
        if request.query.get("reload"):
            engines.reload_templates()
        mode = request.query.get("mode")
        used = usage.load()
        out = [template_info(e, used) for e in engines.ENGINES.values() if not mode or e.mode == mode]
        return web.json_response(out)

    # A template's card image: GET serves it, PUT sets it from a finished run of
    # that template (a cover always shows what it really makes), DELETE goes back
    # to the one it ships with.

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
        run = finished_run(e, b["generation"])
        if isinstance(run, web.Response):
            return run
        # A run made with other inputs than the template opens with: say which, and let the caller choose
        # between keeping them as the template's own (reuse) and taking only the result (reuse: false).
        reuse = b.get("reuse")
        if reuse is None and (differs := await asyncio.to_thread(engines.run_differs, e, run, store.folder(run.id))):
            return err(409, "This run used other inputs than the template", differs=differs)
        if reuse:
            try:
                e = await asyncio.to_thread(engines.adopt_run, e.id, run, store.folder(run.id))
            except (OSError, ValueError) as ex:
                return err(422, f"Couldn't keep this run's inputs: {ex}")
        return await cover_from(e, run) or web.json_response(template_info(e))

    def finished_run(e, generation: str):
        """A finished run of this template, else the error response saying why not."""
        try:
            m = store.get(generation)
        except (FileNotFoundError, ValueError):
            return err(404, "Generation not found")
        if m.engine.model != e.id:
            return err(409, "Only a run of this template can be its cover")
        if m.status != "done" or not (m.result and m.result.poster):
            return err(409, "This run has no finished result to use yet")
        return m

    async def cover_from(e, m):
        """Make this run's result the template's cover; an error response if it can't be."""
        # A photo's cover is the full result, not its 960 px poster: it sits beside its full-size input.
        src = store.folder(m.id) / (m.result.file if m.result.kind == "image" and m.result.file else m.result.poster)
        loop = store.folder(m.id) / m.result.file if m.result.kind == "video" and m.result.file else None
        lead = next((i for i in m.inputs if i.slot == engines.lead_slot(e) and i.file), None)
        before = store.folder(m.id) / lead.file if lead else None  # shown beside the cover
        try:
            await asyncio.to_thread(engines.set_cover, e.id, src, loop, before)
        except Exception as ex:
            return err(422, f"Couldn't make a cover from that file: {ex}")
        return None

    # A template saved in the Builder is a draft: in Create, off Explore. Publishing takes a finished run
    # of it (it has been tested), which becomes its cover when it has none yet.
    @routes.post(API + "/templates/publish")
    async def publish_template(request):
        b = await body(request)
        e = engines.ENGINES.get(str(b.get("engine", "")))
        if e is None or not e.draft:
            return err(404, "No draft with that id")
        run = finished_run(e, str(b.get("generation") or ""))
        if isinstance(run, web.Response):
            return run
        if not any(engines.cover_files(e)):
            if (bad := await cover_from(e, run)) is not None:
                return bad
        return web.json_response(template_info(engines.publish_template(e.id)))

    @routes.delete(API + "/cover")
    async def delete_cover(request):
        e = engines.ENGINES.get(request.query.get("engine", ""))
        if e is None:
            return err(404, "No such template")
        engines.clear_cover(e.id)
        return web.json_response(template_info(e))

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
        return web.json_response(template_info(e))

    @routes.post(API + "/templates/duplicate")
    async def duplicate_template(request):
        try:
            e = await asyncio.to_thread(engines.duplicate_template, str((await body(request)).get("engine", "")))
        except KeyError:
            return err(404, "No such template")
        return web.json_response(template_info(e))

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
        return web.json_response(template_info(e))
