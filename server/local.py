"""Local runs: Comfy API v2 (served by comfy-api-proxy) in front of ComfyUI.

Two clients live here:

- ``ComfyV2`` speaks the v2 contract the proxy serves: upload assets, submit
  an API-format workflow, follow the job, download outputs. Comfy Cloud serves
  the same contract, so ``cloud_assets()`` reuses it to give Router a link to a
  file (``share``).
- ``ComfyUI`` reads ComfyUI's own ``/object_info``. v2 has no node or model
  introspection, and ComfyUI's validation stops at the first missing node, so
  ``check`` compares a workflow against object_info up front and reports
  every missing node and model at once. Installing them is left to the user.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator
from urllib.parse import urljoin, urlparse

import httpx

from . import settings

TIMEOUT = httpx.Timeout(connect=10.0, read=600.0, write=600.0, pool=30.0)
MODEL_EXT = (".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".onnx")


@dataclass
class V2Error(Exception):
    status: int
    code: str = "upstream_error"
    message: str = ""
    details: dict = field(default_factory=dict)
    retry_after: float | None = None

    def __str__(self) -> str:
        return f"{self.status} {self.code}: {self.message}"

    def to_dict(self) -> dict:
        return {"status": self.status, "error_type": self.code, "message": self.message,
                "details": self.details, "validation": [], "request_id": None}


def read_error(resp: httpx.Response) -> V2Error:
    try:
        body = resp.json()
    except ValueError:
        body = None
    e = body.get("error") if isinstance(body, dict) and isinstance(body.get("error"), dict) else {}
    msg = e.get("message") or (body.get("message") if isinstance(body, dict) else None) or resp.text[:300] or f"HTTP {resp.status_code}"
    ra = resp.headers.get("Retry-After")
    try:
        retry = float(ra) if ra is not None else None
    except ValueError:
        retry = None
    return V2Error(resp.status_code, e.get("code") or "upstream_error", msg, e.get("details") or {}, retry)


class ComfyV2:
    def __init__(self, base: str | None = None, token: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        s = settings.load()
        self.base = (base or s.get("local_v2_url") or "http://127.0.0.1:8189").rstrip("/")
        self.token = token if token is not None else settings.local_token()
        self._transport = transport

    def _client(self, timeout: httpx.Timeout | float = TIMEOUT) -> httpx.AsyncClient:
        headers = {"User-Agent": "OpenIllusion/0.2"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return httpx.AsyncClient(base_url=self.base, headers=headers, timeout=timeout, transport=self._transport, follow_redirects=True)

    def link(self, url: str) -> str:
        """Follow-up links may be host-relative; resolve them against the base."""
        return urljoin(self.base + "/", url)

    async def _json(self, method: str, url: str, **kw) -> Any:
        async with self._client() as c:
            resp = await c.request(method, url, **kw)
        if resp.status_code >= 400:
            raise read_error(resp)
        return resp.json() if resp.content else None

    async def health(self) -> dict:
        async with self._client(timeout=4.0) as c:
            resp = await c.get("/api/v2/health")
        if resp.status_code >= 400:
            raise read_error(resp)
        return resp.json()

    async def upload(self, path: Path, file_path: str | None = None, content_type: str | None = None) -> dict:
        ctype = content_type or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        data = {"content_type": ctype, "file_path": file_path or path.name}
        with open(path, "rb") as f:
            files = {"file": (path.name, f, ctype)}
            return await self._json("POST", "/api/v2/assets", data=data, files=files)

    async def share(self, path: Path) -> str:
        """Upload a file and return a link anyone can read for a while: the signed URL
        the asset's content redirects to (Comfy Cloud), else the asset's own ``url``."""
        asset = await self.upload(path)
        if not isinstance(asset, dict) or not asset.get("id"):
            raise V2Error(502, "upload_failed", "The upload gave no asset id")
        async with self._client() as c:
            resp = await c.send(c.build_request("GET", f"/api/v2/assets/{asset['id']}/content"), follow_redirects=False, stream=True)
            await resp.aclose()
        if resp.is_redirect and resp.headers.get("Location"):
            return resp.headers["Location"]
        if resp.status_code >= 400:
            raise read_error(resp)
        if asset.get("url"):
            return str(asset["url"])
        raise V2Error(502, "no_link", "Comfy Cloud gave no link for the upload")

    async def submit(self, workflow: dict, idempotency_key: str, extra_data: dict | None = None) -> dict:
        body: dict[str, Any] = {"workflow": workflow}
        if extra_data:
            body["extra_data"] = extra_data
        return await self._json("POST", "/api/v2/jobs", json=body, headers={"Idempotency-Key": idempotency_key})

    async def job(self, job_id: str) -> dict:
        return await self._json("GET", f"/api/v2/jobs/{job_id}")

    async def cancel(self, job_id: str) -> dict:
        return await self._json("POST", f"/api/v2/jobs/{job_id}/cancel")

    async def events(self, url: str) -> AsyncIterator[tuple[str, Any]]:
        """Server-sent events as (event, data). Live only; poll for the truth."""
        timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=30.0)
        async with self._client(timeout) as c:
            async with c.stream("GET", self.link(url), headers={"Accept": "text/event-stream"}) as resp:
                if resp.status_code >= 400:
                    await resp.aread()
                    raise read_error(resp)
                event, data = "message", []
                async for line in resp.aiter_lines():
                    if line == "":
                        if data:
                            raw = "\n".join(data)
                            try:
                                yield event, json.loads(raw)
                            except ValueError:
                                yield event, raw
                        event, data = "message", []
                    elif line.startswith("event:"):
                        event = line[6:].strip()
                    elif line.startswith("data:"):
                        data.append(line[5:].lstrip())

    async def download(self, url: str) -> tuple[bytes, str]:
        async with self._client() as c:
            resp = await c.get(self.link(url))
        if resp.status_code >= 400:
            raise read_error(resp)
        return resp.content, resp.headers.get("content-type", "")


# ---- ComfyUI's own API (introspection only) ----------------------------------


_info_cache: dict[str, tuple[float, dict]] = {}


def cloud_assets() -> ComfyV2:
    """Comfy Cloud's asset store, signed in with the Comfy API key."""
    return ComfyV2(base=settings.load().get("cloud_base") or settings.DEFAULTS["cloud_base"], token=settings.api_key())


class ComfyUI:
    def __init__(self, base: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
        self.base = (base or settings.load().get("local_comfyui_url") or "http://127.0.0.1:8188").rstrip("/")
        self._transport = transport

    async def object_info(self, fresh: bool = False) -> dict:
        hit = _info_cache.get(self.base)
        if hit and not fresh and time.time() - hit[0] < 30:
            return hit[1]
        async with httpx.AsyncClient(timeout=30.0, transport=self._transport) as c:
            resp = await c.get(self.base + "/object_info")
        resp.raise_for_status()
        info = resp.json()
        _info_cache[self.base] = (time.time(), info)
        return info

    async def input_file(self, name: str, limit: int = 200 * 1024 * 1024) -> bytes | None:
        """A file from ComfyUI's input folder, or None when it isn't there."""
        sub, _, fname = name.replace("\\", "/").rpartition("/")
        async with httpx.AsyncClient(timeout=30.0, transport=self._transport) as c:
            resp = await c.get(self.base + "/view", params={"filename": fname, "subfolder": sub, "type": "input"})
        if resp.status_code != 200 or len(resp.content) > limit:
            return None
        return resp.content

    async def upload_input(self, path: Path, name: str) -> str:
        """Put a file in ComfyUI's input folder under ``name``, replacing one with that name. Returns the name ComfyUI uses."""
        async with httpx.AsyncClient(timeout=60.0, transport=self._transport) as c:
            resp = await c.post(self.base + "/upload/image", data={"type": "input", "overwrite": "true"},
                                files={"image": (name, path.read_bytes())})
        resp.raise_for_status()
        d = resp.json()
        return f"{d['subfolder']}/{d['name']}" if d.get("subfolder") else d["name"]

    async def system_stats(self) -> dict:
        async with httpx.AsyncClient(timeout=4.0, transport=self._transport) as c:
            resp = await c.get(self.base + "/system_stats")
        resp.raise_for_status()
        return resp.json()


def _combo_options(spec: Any) -> list | None:
    """The allowed values of a COMBO input, in either object_info shape."""
    if not isinstance(spec, list) or not spec:
        return None
    if isinstance(spec[0], list):
        return spec[0]
    if spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        return spec[1].get("options")
    return None


def _is_media_token(v: Any) -> bool:
    return isinstance(v, str) and v.startswith("{{") and v.endswith("}}")


def check(workflow: dict, info: dict, hints: dict | None = None) -> dict:
    """Every missing node and model in an API-format workflow, at once.

    ``hints`` may map a class_type to its package and a model filename to a
    download URL; both come from a template and are only ever shown.
    """
    hints = hints or {}
    node_hints = hints.get("nodes") or {}
    model_hints = hints.get("models") or {}
    missing_nodes: dict[str, dict] = {}
    missing_models: list[dict] = []
    bad_values: list[dict] = []
    for nid, node in workflow.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        spec = info.get(ct)
        if spec is None:
            m = missing_nodes.setdefault(ct, {"class_type": ct, "node_ids": [], "package": node_hints.get(ct)})
            m["node_ids"].append(nid)
            continue
        inputs = {**(spec.get("input", {}).get("required") or {}), **(spec.get("input", {}).get("optional") or {})}
        for name, value in (node.get("inputs") or {}).items():
            if isinstance(value, (list, dict)) or _is_media_token(value):
                continue  # a link, an asset reference or a media slot
            opts = _combo_options(inputs.get(name))
            if opts is None or value in opts:
                continue
            row = {"node_id": nid, "class_type": ct, "input": name, "value": value}
            if isinstance(value, str) and value.lower().endswith(MODEL_EXT):
                hint = model_hints.get(value) or {}
                row.update(url=hint.get("url"), folder=hint.get("folder"), size=hint.get("size"))
                missing_models.append(row)
            else:
                row["options"] = [o for o in opts[:12] if not isinstance(o, dict)]
                bad_values.append(row)
    nodes = list(missing_nodes.values())
    return {
        "ok": not nodes and not missing_models and not bad_values,
        "missing_nodes": nodes,
        "missing_models": missing_models,
        "bad_values": bad_values,
    }


def check_message(c: dict) -> str:
    parts = []
    if c["missing_nodes"]:
        parts.append("missing nodes: " + ", ".join(n["class_type"] for n in c["missing_nodes"]))
    if c["missing_models"]:
        parts.append("missing models: " + ", ".join(m["value"] for m in c["missing_models"]))
    if c["bad_values"]:
        parts.append("invalid values: " + ", ".join(f"{b['class_type']}.{b['input']}={b['value']!r}" for b in c["bad_values"]))
    return "Your ComfyUI can't run this yet · " + "; ".join(parts)


def node_errors_message(details: dict) -> str:
    """Readable text for ComfyUI's per-node validation errors."""
    out = []
    for nid, ne in (details.get("node_errors") or {}).items():
        for e in ne.get("errors") or []:
            out.append(f"#{nid} {ne.get('class_type', '')}: {e.get('details') or e.get('message')}")
    return "; ".join(out)


# ---- which ComfyUI does the proxy run on? -----------------------------------------

LOOPBACK = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "::"}


def _parts(url: str) -> tuple[str, str, int]:
    u = urlparse(url if "://" in url else "http://" + url)
    scheme = u.scheme or "http"
    host = (u.hostname or "").lower()
    return scheme, host, u.port or (443 if scheme == "https" else 80)


def upstream_seen_from_here(upstream: str, v2_url: str) -> str:
    """The proxy names its ComfyUI as *it* reaches it. On a proxy running on
    another machine, a loopback upstream means that machine, not this one."""
    scheme, host, port = _parts(upstream)
    _, v2_host, _ = _parts(v2_url)
    if host in LOOPBACK and v2_host not in LOOPBACK:
        host = v2_host
    if ":" in host:
        host = f"[{host}]"
    return f"{scheme}://{host}:{port}"


def same_endpoint(a: str, b: str) -> bool:
    (sa, ha, pa), (sb, hb, pb) = _parts(a), _parts(b)
    if ha in LOOPBACK and hb in LOOPBACK:
        ha = hb = "loopback"
    return (sa, ha, pa) == (sb, hb, pb)


def upstream_match(upstream: str | None, v2_url: str, comfyui_url: str) -> bool | None:
    """True or False when we can tell; None when we can't.

    A bare name such as ``comfyui`` (a Docker service) only resolves on the
    proxy's network, so it can't be compared with an address from here.
    """
    if not upstream:
        return None
    seen = upstream_seen_from_here(upstream, v2_url)
    if same_endpoint(seen, comfyui_url):
        return True
    host = _parts(seen)[1]
    if host not in LOOPBACK and "." not in host and ":" not in host:
        return None
    return False


async def wait_until_up(v2: ComfyV2, seconds: float = 8.0) -> bool:
    end = time.time() + seconds
    while time.time() < end:
        try:
            await v2.health()
            return True
        except (httpx.HTTPError, V2Error):
            await asyncio.sleep(0.4)
    return False
