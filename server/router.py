"""A small async client for Comfy Router.

Covers what OpenIllusion needs: the catalog, per-model schemas (cached with
ETags), pre-flight estimates, and queued delivery (submit, status, collect,
cancel). Plain HTTP over httpx so the pack has no SDK pin to fight with.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

import httpx

from . import paths, settings

TIMEOUT = httpx.Timeout(connect=15.0, read=660.0, write=300.0, pool=30.0)


@dataclass
class RouterError(Exception):
    status: int
    error_type: str = "internal_error"
    message: str = ""
    validation: list = field(default_factory=list)
    request_id: str | None = None
    retry_after: float | None = None

    def __str__(self) -> str:
        return f"{self.status} {self.error_type}: {self.message}"

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "error_type": self.error_type,
            "message": self.message,
            "validation": self.validation,
            "request_id": self.request_id,
            "retry_after": self.retry_after,
        }


def read_error(resp: httpx.Response) -> RouterError:
    body: Any = None
    if resp.headers.get("content-type", "").startswith("application/json"):
        try:
            body = resp.json()
        except ValueError:
            body = None
    detail = body.get("detail") if isinstance(body, dict) else None
    message = body.get("message") if isinstance(body, dict) and isinstance(body.get("message"), str) else None
    error_type = resp.headers.get("X-Comfy-Error-Type") or (
        body.get("error_type") if isinstance(body, dict) else None
    )
    return RouterError(
        status=resp.status_code,
        error_type=error_type or "internal_error",
        message=detail if isinstance(detail, str) else (message or f"HTTP {resp.status_code}"),
        validation=detail if isinstance(detail, list) else [],
        request_id=resp.headers.get("X-Comfy-Request-Id"),
        retry_after=_retry_after(resp),
    )


def _retry_after(resp: httpx.Response) -> float | None:
    v = resp.headers.get("Retry-After")
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def split_id(model_id: str) -> tuple[str, str]:
    provider, _, model = model_id.partition("/")
    if not provider or not model:
        raise ValueError(f"model id must look like provider/model, got {model_id!r}")
    return provider, model


class Router:
    def __init__(self, key: str | None = None, base: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        s = settings.load()
        self.key = key if key is not None else settings.api_key()
        self.base = (base or s.get("router_base") or "https://api.comfy.org").rstrip("/")
        self._transport = transport

    def _client(self) -> httpx.AsyncClient:
        headers = {"X-API-Key": self.key, "User-Agent": "ComfyUI-OpenIllusion/0.1"}
        return httpx.AsyncClient(base_url=self.base, headers=headers, timeout=TIMEOUT, transport=self._transport)

    async def _json(self, method: str, url: str, **kw) -> tuple[Any, httpx.Response]:
        async with self._client() as c:
            resp = await c.request(method, url, **kw)
        if resp.status_code >= 400:
            raise read_error(resp)
        try:
            return resp.json(), resp
        except ValueError:
            return None, resp

    # ---- catalog -------------------------------------------------------

    async def list_models(self) -> list[dict]:
        out: list[dict] = []
        cursor = None
        for _ in range(50):
            params = {"limit": 100}
            if cursor:
                params["cursor"] = cursor
            data, _ = await self._json("GET", "/v2/models", params=params)
            out.extend(data.get("data", []))
            if not data.get("has_more"):
                break
            cursor = data.get("next_cursor")
        return out

    async def get_model(self, model_id: str) -> dict:
        p, m = split_id(model_id)
        data, _ = await self._json("GET", f"/v2/models/{p}/{m}")
        return data

    async def get_schema(self, model_id: str) -> dict:
        """The model's OpenAPI document, revalidated with If-None-Match."""
        p, m = split_id(model_id)
        cache = paths.cache_dir() / "schemas"
        cache.mkdir(exist_ok=True)
        f = cache / (hashlib.sha1(model_id.encode()).hexdigest() + ".json")
        cached = None
        if f.exists():
            try:
                cached = json.loads(f.read_text("utf-8"))
            except ValueError:
                cached = None
        headers = {}
        if cached and cached.get("etag"):
            headers["If-None-Match"] = cached["etag"]
        async with self._client() as c:
            resp = await c.get(f"/v2/models/{p}/{m}/openapi.json", headers=headers)
        if resp.status_code == 304 and cached:
            return cached["doc"]
        if resp.status_code >= 400:
            if cached:
                return cached["doc"]
            raise read_error(resp)
        doc = resp.json()
        f.write_text(json.dumps({"etag": resp.headers.get("ETag"), "doc": doc}), "utf-8")
        return doc

    # ---- pricing -------------------------------------------------------

    async def estimate(self, model_id: str, body: dict) -> dict:
        p, m = split_id(model_id)
        try:
            data, _ = await self._json("POST", f"/v2/models/{p}/{m}/estimate", json=body)
            return data or {"source": "unknown", "reason": "empty_response"}
        except RouterError as e:
            if e.status == 403 and e.error_type == "not_enabled":
                return {"source": "unknown", "reason": "not_enabled"}
            raise

    # ---- queued delivery ----------------------------------------------

    async def submit(self, model_id: str, body: dict, idempotency_key: str) -> dict:
        p, m = split_id(model_id)
        data, resp = await self._json(
            "POST", f"/v2/models/{p}/{m}/requests", json=body, headers={"Idempotency-Key": idempotency_key}
        )
        data = data or {}
        data["_replayed"] = resp.headers.get("Idempotent-Replayed") == "true"
        return data

    async def status(self, model_id: str, request_id: str) -> tuple[dict, float | None]:
        p, m = split_id(model_id)
        data, resp = await self._json("GET", f"/v2/models/{p}/{m}/requests/{request_id}/status")
        return data or {}, _retry_after(resp)

    async def collect(self, model_id: str, request_id: str) -> tuple[Any, dict]:
        """The model's native output. Raises RouterError for failed runs."""
        p, m = split_id(model_id)
        async with self._client() as c:
            resp = await c.get(f"/v2/models/{p}/{m}/requests/{request_id}")
        if resp.status_code >= 400:
            raise read_error(resp)
        meta = {
            "status_code": resp.status_code,
            "content_type": resp.headers.get("content-type", ""),
            "credits_used": resp.headers.get("X-Comfy-Credits-Used"),
            "provider": resp.headers.get("X-Comfy-Provider") or resp.headers.get("X-Comfy-Served-By"),
            "request_id": resp.headers.get("X-Comfy-Request-Id"),
        }
        if meta["content_type"].startswith("application/json"):
            return resp.json(), meta
        return resp.content, meta

    async def run_sync(self, model_id: str, body: dict, idempotency_key: str) -> tuple[Any, dict]:
        """Synchronous route, for keys the queue refuses (403 not_enabled).
        Bounded by Router's 10-minute deadline; same Idempotency-Key semantics."""
        p, m = split_id(model_id)
        async with self._client() as c:
            resp = await c.post(f"/v2/models/{p}/{m}", json=body, headers={"Idempotency-Key": idempotency_key})
        if resp.status_code >= 400:
            raise read_error(resp)
        meta = {
            "status_code": resp.status_code,
            "content_type": resp.headers.get("content-type", ""),
            "credits_used": resp.headers.get("X-Comfy-Credits-Used"),
            "provider": resp.headers.get("X-Comfy-Provider") or resp.headers.get("X-Comfy-Served-By"),
            "request_id": resp.headers.get("X-Comfy-Request-Id"),
        }
        if meta["content_type"].startswith("application/json"):
            return resp.json(), meta
        return resp.content, meta

    async def cancel(self, model_id: str, request_id: str) -> bool:
        p, m = split_id(model_id)
        async with self._client() as c:
            resp = await c.put(f"/v2/models/{p}/{m}/requests/{request_id}/cancel")
        return resp.status_code == 202

    async def download(self, url: str) -> tuple[bytes, str]:
        # Asset URLs are signed and live off the API host, so no key header.
        async with httpx.AsyncClient(timeout=TIMEOUT, follow_redirects=True, transport=self._transport) as c:
            resp = await c.get(url)
        resp.raise_for_status()
        return resp.content, resp.headers.get("content-type", "")
