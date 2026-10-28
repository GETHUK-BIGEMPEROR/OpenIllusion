"""OpenIllusion's HTTP API, under /api, plus the built web app at /.

The browser only ever talks to these. The API key and the proxy token stay
on this side. One module per area; each adds its routes in `register`.
"""

from __future__ import annotations

from aiohttp import web

from . import backup, builder, generations, library, system, templates
from .common import _sockets, broadcast, library_changed

__all__ = ["register", "broadcast", "library_changed", "_sockets"]


def register(routes: web.RouteTableDef) -> None:
    for m in (system, templates, builder, generations, library, backup):
        m.register(routes)
