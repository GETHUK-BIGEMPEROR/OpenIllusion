"""The template builder: read a workflow, list models, save and delete built templates."""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import httpx
from aiohttp import web

from .. import adapters, builder, engines, local, paths, staging
from .common import API, UPLOAD_EXT, err, body, asset_info, template_info


def register(routes: web.RouteTableDef) -> None:
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

    async def _sample(src):
        """A template's sample as an upload the builder can show and save with."""
        raw = src.read_bytes()
        asset = hashlib.sha256(raw).hexdigest()[:24] + src.suffix.lower()
        dst = paths.uploads_dir() / asset
        if not dst.exists():
            dst.write_bytes(raw)
        return {"asset": asset, "name": src.name, **await asyncio.to_thread(asset_info, dst)}

    @routes.post(API + "/builder/from-template")
    async def builder_from_template(request):
        """Open a template in the builder. Local: its workflow read like a dropped one, plus how the template set it up.
        Cloud: its Router model with the inputs, prompt and settings the template has."""
        b = await body(request)
        e = engines.ENGINES.get(str(b.get("engine") or ""))
        if e is not None and e.kind == "cloud":
            try:
                p = builder.cloud_preset(e)
            except builder.BuildError as ex:
                return err(422, str(ex))
            for m in p["media"]:
                src = e.default_inputs.get(m["slot"])
                m["sample"] = await _sample(src) if src and src.is_file() else None
            return web.json_response(p)
        if e is None or e.kind != "local" or not e.workflow:
            return err(404, "That template has nothing to build from")
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
            m["sample"] = await _sample(src) if src and src.is_file() else None
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
            for m in builder.media_rows(b.get("media") or []):
                if m.get("sample"):
                    samples[m["slot"]] = staging.resolve_asset(str(m["sample"]))
            tid = builder.save(data, samples, replace=replace, taken=set(engines.ENGINES))
        except (builder.BuildError, KeyError, ValueError) as e:
            return err(422, str(e))
        engines.reload_templates()
        return web.json_response(template_info(engines.ENGINES[tid]))

    @routes.delete(API + "/builder/template")
    async def builder_delete(request):
        try:
            engines.delete_template(request.query.get("engine", ""))
        except KeyError:
            return err(409, "Only templates you built can be deleted")
        return web.json_response({"ok": True})
