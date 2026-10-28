"""Character Lab: characters, their photos, making their RefMod, and the RefMod folder (server/characters.py)."""

from __future__ import annotations

from aiohttp import web

from .. import characters, paths, staging
from .common import API, err, body, _safe_file


def register(routes: web.RouteTableDef) -> None:
    @routes.get(API + "/characters")
    async def list_characters(request):
        return web.json_response(characters.list_all())

    @routes.get(API + "/refmods")
    async def list_refmods(request):
        """What a template's RefMod input picks from: every RefMod in the RefMod folder."""
        return web.json_response({"folder": str(paths.refmods_dir()), "refmods": characters.list_refmods()})

    @routes.post(API + "/characters")
    async def create_character(request):
        b = await body(request)
        try:
            return web.json_response(characters.create(b.get("name", ""), b.get("notes", "")))
        except ValueError as e:
            return err(422, str(e))

    @routes.get(API + "/characters/{id}")
    async def get_character(request):
        try:
            return web.json_response(characters.get(request.match_info["id"]))
        except FileNotFoundError:
            return err(404, "Character not found")

    @routes.patch(API + "/characters/{id}")
    async def patch_character(request):
        b = await body(request)
        try:
            return web.json_response(characters.update(request.match_info["id"], **{k: v for k, v in b.items() if k in ("name", "notes", "cover")}))
        except FileNotFoundError:
            return err(404, "Character not found")
        except ValueError as e:
            return err(422, str(e))

    @routes.delete(API + "/characters/{id}")
    async def delete_character(request):
        try:
            characters.delete(request.match_info["id"])
        except FileNotFoundError:
            return err(404, "Character not found")
        except ValueError as e:
            return err(409, str(e))
        return web.json_response({"ok": True})

    @routes.post(API + "/characters/{id}/photos")
    async def add_photo(request):
        """``{asset}``: an upload (or any input source ``staging.resolve_asset`` takes)."""
        b = await body(request)
        try:
            src = staging.resolve_asset(str(b.get("asset") or ""))
            return web.json_response(characters.add_photo(request.match_info["id"], src))
        except FileNotFoundError as e:
            return err(404, str(e) or "Not found")
        except (ValueError, OSError) as e:
            return err(422, str(e) or "That file isn't a photo")

    @routes.get(API + "/characters/{id}/photos/{name}")
    async def photo(request):
        try:
            base = characters.folder(request.match_info["id"]) / "photos"
        except FileNotFoundError:
            return err(404, "Not found")
        return _safe_file(base, request.match_info["name"], cache=True)

    @routes.delete(API + "/characters/{id}/photos/{name}")
    async def remove_photo(request):
        try:
            return web.json_response(characters.remove_photo(request.match_info["id"], request.match_info["name"]))
        except FileNotFoundError:
            return err(404, "Not found")

    @routes.post(API + "/characters/{id}/refmod")
    async def make_refmod(request):
        try:
            return web.json_response(characters.start_refmod(request.match_info["id"]))
        except FileNotFoundError:
            return err(404, "Character not found")
        except ValueError as e:
            return err(422, str(e))
