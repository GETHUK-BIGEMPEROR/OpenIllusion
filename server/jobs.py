"""The run engine: preflight, queued submit, poll, download, write the generation.

Each run is one generation and one job, on one of two backends:

- cloud: Comfy Router. Estimate, queued submit, poll, collect.
- local: Comfy API v2 in front of the user's ComfyUI. Check the workflow
  against ComfyUI's nodes and models, upload inputs as assets, submit,
  follow live progress, download outputs.

The generation id doubles as the Idempotency-Key, so a retry after a dropped
connection (or a restart) collects the original run instead of a second one.
"""

from __future__ import annotations

import asyncio
import json
import mimetypes
import random
import shutil
import time
import traceback
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable

import httpx
from PIL import Image

from . import engines, local, media, paths, prep, proxy, settings, store
from . import generation as sc
from .router import Router, RouterError

MAX_BODY = 100 * 1024 * 1024  # Router's request limit
TERMINAL = ("done", "failed", "moderated", "cancelled")


@dataclass
class Job:
    id: str  # = generation id
    title: str
    mode: str
    model: str
    provider: str
    state: str = "estimating"
    detail: str = ""
    created: float = field(default_factory=time.time)
    started: float | None = None
    finished: float | None = None
    request_id: str | None = None
    queue_position: int | None = None
    estimate: dict | None = None
    error: dict | None = None
    fixes: list[str] = field(default_factory=list)
    poster: str | None = None
    parent: str | None = None
    sync: bool = False
    kind: str = "cloud"
    progress: dict | None = None  # local: v2 progress snapshot
    preview: str | None = None  # local: latest in-progress frame, data URI

    def to_dict(self) -> dict:
        return asdict(self)


class Manager:
    def __init__(self):
        self.jobs: dict[str, Job] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.listeners: list[Callable[[dict], None]] = []
        self._sem: asyncio.Semaphore | None = None
        self._sem_size = 0
        self.router_factory: Callable[[], Router] = Router
        self.v2_factory: Callable[[], local.ComfyV2] = local.ComfyV2
        self.comfyui_factory: Callable[[], local.ComfyUI] = local.ComfyUI
        self.ensure_proxy: Callable[[], Any] = proxy.ensure

    # ---- plumbing ------------------------------------------------------

    def sem(self) -> asyncio.Semaphore:
        n = int(settings.load().get("max_parallel") or 2)
        if self._sem is None or n != self._sem_size:
            self._sem = asyncio.Semaphore(n)
            self._sem_size = n
        return self._sem

    def emit(self, job: Job) -> None:
        d = job.to_dict()
        for fn in list(self.listeners):
            try:
                fn(d)
            except Exception:
                pass
        self._persist()

    def _persist(self) -> None:
        try:
            keep = [j.to_dict() for j in self.jobs.values()]
            (paths.user_root() / "jobs.json").write_text(json.dumps(keep), "utf-8")
        except OSError:
            pass

    def set(self, job: Job, state: str, detail: str = "", **kw) -> None:
        job.state = state
        job.detail = detail
        for k, v in kw.items():
            setattr(job, k, v)
        if state in TERMINAL and not job.finished:
            job.finished = time.time()
        self.emit(job)

    def list(self) -> list[dict]:
        return [j.to_dict() for j in sorted(self.jobs.values(), key=lambda j: j.created, reverse=True)]

    def clear_finished(self) -> None:
        for k in [k for k, j in self.jobs.items() if j.state in TERMINAL]:
            self.jobs.pop(k, None)
        self._persist()

    def resume(self) -> int:
        """Pick up runs that were in flight when OpenIllusion stopped."""
        f = paths.user_root() / "jobs.json"
        if not f.exists():
            return 0
        try:
            saved = json.loads(f.read_text("utf-8"))
        except ValueError:
            return 0
        n = 0
        for d in saved:
            job = Job(**{k: v for k, v in d.items() if k in Job.__dataclass_fields__})
            self.jobs[job.id] = job
            if job.state not in TERMINAL:
                self.tasks[job.id] = asyncio.ensure_future(self._run(job))
                n += 1
        return n

    # ---- public ----------------------------------------------------------

    async def start(self, spec: dict) -> list[str]:
        """Create one generation per variant and queue them. Returns generation ids."""
        variants = max(1, min(4, int(spec.get("variants") or 1)))
        ids: list[str] = []
        parent = sc.new_id() if variants > 1 else None
        for n in range(variants):
            m = prepare_generation(spec, parent=parent, variant_no=n + 1 if variants > 1 else None)
            e = engines.get(m.engine.model)
            job = Job(
                id=m.id, title=m.title, mode=m.mode, model=m.engine.model, provider=e.provider,
                parent=parent, poster=_poster_url(m), kind=e.kind,
            )
            self.jobs[job.id] = job
            self.emit(job)
            self.tasks[job.id] = asyncio.ensure_future(self._run(job))
            ids.append(m.id)
        return ids

    async def cancel(self, job_id: str) -> bool:
        job = self.jobs.get(job_id)
        if not job or job.state in TERMINAL:
            return False
        if job.request_id and job.kind == "local":
            try:
                await self.v2_factory().cancel(job.request_id)
            except Exception:
                pass
            self.set(job, job.state, "Cancel requested. ComfyUI stops at the next node.")
            return True
        if job.request_id:
            try:
                await self.router_factory().cancel(job.model, job.request_id)
            except Exception:
                pass
            self.set(job, job.state, "Cancel requested. A run already at the provider may still finish.")
            return True
        t = self.tasks.get(job_id)
        if t:
            t.cancel()
        self._finish(job, "cancelled", "Cancelled before it was sent.")
        return True

    # ---- the run -------------------------------------------------------

    async def _run(self, job: Job) -> None:
        try:
            self.set(job, "waiting", "Waiting for a slot")
            async with self.sem():
                await self._run_inner(job)
        except asyncio.CancelledError:
            if job.state not in TERMINAL:
                self._finish(job, "cancelled", "Cancelled.")
        except RouterError as e:
            self._router_failure(job, e)
        except local.V2Error as e:
            self._v2_failure(job, e)
        except httpx.HTTPError as e:
            where = "your ComfyUI" if job.kind == "local" else "Comfy Router"
            self._finish(job, "failed", f"Couldn't reach {where}: {e.__class__.__name__}", error={"error_type": "unreachable", "message": str(e)}, fixes=["rerun"])
        except Exception as e:  # keep the generation; a failed recipe is worth sharing too
            traceback.print_exc()
            self._finish(job, "failed", str(e) or e.__class__.__name__, error={"error_type": "internal_error", "message": str(e)})

    async def _run_inner(self, job: Job) -> None:
        folder = store.folder(job.id)
        m = sc.read(folder)
        if engines.get(m.engine.model).kind == "local":
            await self._run_local(job, m, folder)
            return
        router = self.router_factory()
        inputs = [i.model_dump() for i in m.inputs]

        self.set(job, "estimating", "Building the request")
        resolve = engines.file_resolver(inputs, folder)
        body = await asyncio.to_thread(engines.materialize, m.request_template, resolve)
        size = len(json.dumps(body))
        if size > MAX_BODY:
            mb = size / 1024 / 1024
            self._finish(
                job, "failed", f"Request too large ({mb:.0f} MiB, over 100 MiB)",
                error={"error_type": "request_too_large", "message": f"{mb:.0f} MiB"},
                fixes=["trim", "downscale"],
            )
            return

        if not job.estimate:
            self.set(job, "estimating", f"Asking Router for a price…")
            try:
                job.estimate = await router.estimate(m.engine.model, body)
            except RouterError as e:
                if e.status == 422:
                    raise
                job.estimate = {"source": "unknown", "reason": e.error_type}

        job.started = job.started or time.time()
        if job.sync:
            await self._run_sync(job, router, body)
            return

        # Submit, retrying rate limits with the same key.
        while not job.request_id:
            try:
                sub = await router.submit(m.engine.model, body, idempotency_key=job.id)
            except RouterError as e:
                if e.status == 403 and e.error_type == "not_enabled":
                    job.sync = True
                    await self._run_sync(job, router, body)
                    return
                if e.status in (409, 429) and e.error_type in ("rate_limited", "concurrency_limit_exceeded"):
                    wait = e.retry_after or 10
                    self.set(job, "rate_limited", f"Rate limited · retrying by itself in {wait:.0f} s")
                    await asyncio.sleep(wait)
                    continue
                raise
            job.request_id = sub.get("request_id")
            if sub.get("estimate") and not job.estimate:
                job.estimate = sub["estimate"]
            self.set(job, "queued", "Queued at Router", queue_position=sub.get("queue_position"))

        # Poll. Router has no progress events; show elapsed time instead.
        while True:
            try:
                st, retry = await router.status(job.model, job.request_id)
            except RouterError as e:
                if e.status == 429:
                    await asyncio.sleep(e.retry_after or 10)
                    continue
                if e.status == 410:
                    self._finish(job, "failed", "Router no longer keeps this result (over 24 h old).")
                    return
                raise
            status = st.get("status")
            if status == "COMPLETED":
                if st.get("error_type"):
                    self._router_failure(job, RouterError(200, st["error_type"], st.get("message") or ""))
                    return
                break
            if status == "IN_QUEUE":
                self.set(job, "queued", "Queued at Router", queue_position=st.get("queue_position"))
            else:
                if job.state != "running":
                    self.set(job, "running", f"Running on {job.model}", queue_position=0)
            await asyncio.sleep(min(10.0, max(2.0, retry or 3.0)))

        self.set(job, "downloading", "Saving before the link expires")
        result, meta = await router.collect(job.model, job.request_id)
        await self._finish_result(job, result, meta)

    async def _run_sync(self, job: Job, router: Router, body: dict) -> None:
        self.set(job, "running", f"Running on {job.model} (synchronous route)")
        result, meta = await router.run_sync(job.model, body, idempotency_key=job.id)
        self.set(job, "downloading", "Saving before the link expires")
        await self._finish_result(job, result, meta)

    # ---- local: Comfy API v2 -------------------------------------------

    async def _run_local(self, job: Job, m: sc.Manifest, folder: Path) -> None:
        e = engines.get(m.engine.model)
        v2 = self.v2_factory()
        if not job.request_id:
            self.set(job, "estimating", "Connecting to your ComfyUI")
            up = await self.ensure_proxy()
            if not up.get("ok"):
                reason = up.get("reason")
                text = {
                    "proxy_not_installed": "comfy-api-proxy isn't installed. Run `pip install comfy-api-proxy`, or point Settings → Local at a running one.",
                    "proxy_down": "Nothing answers at the Comfy API v2 address in Settings → Local. Start comfy-api-proxy there.",
                    "upstream_mismatch": f"The Comfy API v2 at {settings.load()['local_v2_url']} runs on the ComfyUI at {up.get('upstream')}, not the one at {settings.load()['local_comfyui_url']}. Point both at the same ComfyUI in Settings → Local.",
                }.get(reason, "comfy-api-proxy didn't start. Is ComfyUI running at the address in Settings → Local?")
                self._finish(job, "failed", text, error={"error_type": reason or "proxy_failed", "message": text}, fixes=["rerun"])
                return

            self.set(job, "estimating", "Checking nodes and models")
            info = await self.comfyui_factory().object_info(fresh=True)
            check = local.check(m.request_template, info, e.hints)
            if not check["ok"]:
                self._finish(job, "failed", local.check_message(check), error={"error_type": "missing_requirements", "message": local.check_message(check), "check": check}, fixes=["check"])
                return

            self.set(job, "estimating", "Uploading inputs")
            by_slot = {i.slot: i for i in m.inputs}
            assets: dict[str, dict] = {}
            for kind, n, _form in engines.tokens_in(m.request_template):
                slot = f"{kind}:{n}"
                item = by_slot.get(slot)
                if not item or not item.file:
                    raise FileNotFoundError(f"{slot} is in the workflow but has no file")
                if slot not in assets:
                    a = await v2.upload(folder / item.file, file_path=f"openillusion_{m.id[-8:]}_{Path(item.file).name}")
                    assets[slot] = {"__type": "core/ASSET", "info": {"id": a["id"]}}
            workflow = engines.materialize(m.request_template, lambda k, n, f: assets[f"{k}:{n}"])

            extra = None
            if settings.api_key() and any((info.get(n.get("class_type")) or {}).get("api_node") for n in workflow.values()):
                extra = {"api_key_comfy_org": settings.api_key()}  # partner nodes inside a local workflow
            job.started = job.started or time.time()
            try:
                sub = await v2.submit(workflow, idempotency_key=job.id, extra_data=extra)
            except local.V2Error as ex:
                if ex.code == "invalid_workflow":
                    msg = local.node_errors_message(ex.details) or ex.message
                    self._finish(job, "failed", f"ComfyUI refused the workflow · {msg}", error=ex.to_dict(), fixes=["check"])
                    return
                raise
            job.request_id = sub["id"]
            self.set(job, "queued", "Queued in your ComfyUI", queue_position=sub.get("queue_position"))

        live = asyncio.ensure_future(self._follow_events(job, v2))
        try:
            while True:
                st = await v2.job(job.request_id)
                status = st.get("status")
                if status in ("succeeded", "failed", "canceled", "expired"):
                    break
                if status == "running" and job.state != "running":
                    job.started = job.started or time.time()
                    self.set(job, "running", "Running in your ComfyUI", queue_position=0)
                elif status == "queued" and st.get("queue_position") != job.queue_position:
                    self.set(job, "queued", "Queued in your ComfyUI", queue_position=st.get("queue_position"))
                await asyncio.sleep(1.5)
        finally:
            live.cancel()

        if status == "canceled":
            self._finish(job, "cancelled", "Cancelled in ComfyUI.")
            return
        if status != "succeeded":
            err = st.get("error") or {}
            where = f"#{err['node_id']} {err.get('class_type') or ''}: " if err.get("node_id") else ""
            text = f"{where}{(err.get('message') or status).strip()}"
            error = {"error_type": err.get("code") or status, "message": text, **err}
            if "out of memory" in text.lower():
                # Rerunning the same settings fails the same way; say what to change instead.
                self._finish(job, "failed", f"Your GPU ran out of memory at {where.rstrip(': ') or 'a node'}. Try a smaller size or one variant at a time, "
                             "and close other apps using the GPU.", error={**error, "error_type": "out_of_memory"}, fixes=["smaller"])
                return
            self._finish(job, "failed", f"ComfyUI failed · {text}", error=error, fixes=["rerun"])
            return

        outputs = st.get("outputs") or []
        want = "video/" if m.mode == "motion" else "image/"
        ranked = sorted(  # the template's output node first, then the mode's media kind
            [o for o in outputs if o.get("content_type", "").startswith(("video/", "image/"))],
            key=lambda o: (str(o.get("node_id")) not in e.outputs, not o.get("content_type", "").startswith(want)),
        )
        if not ranked:
            text = "ComfyUI finished but saved no image or video. A node it skipped may have had an invalid input."
            self._finish(job, "failed", text, error={"error_type": "no_output", "message": text}, fixes=["check"])
            return
        self.set(job, "downloading", "Saving the result", progress=None, preview=None)
        data, ctype = await v2.download(ranked[0]["url"])
        ctype = ranked[0].get("content_type") or ctype
        await self._save_media(job, data, ctype, {"v2_job": st}, {"provider": "local"})

    async def _follow_events(self, job: Job, v2: local.ComfyV2) -> None:
        """Live progress and previews. Best effort; polling decides the outcome."""
        last = 0.0
        try:
            async for event, data in v2.events(f"/api/v2/jobs/{job.request_id}/events"):
                if event == "progress" and isinstance(data, dict):
                    snap = {k: data.get(k) for k in ("value", "nodes_done", "nodes_total", "step", "steps", "message", "current_node_class")}
                    prev = (job.progress or {}).get("value")
                    if prev is not None and snap["value"] is not None:  # cached nodes can report done early; never go backwards
                        snap["value"] = max(prev, snap["value"])
                    job.progress = snap
                    if job.state != "running":
                        job.started = job.started or time.time()
                        job.state, job.detail = "running", "Running in your ComfyUI"
                elif event == "preview" and isinstance(data, dict) and data.get("data_base64"):
                    job.preview = f"data:{data.get('content_type', 'image/jpeg')};base64,{data['data_base64']}"
                else:
                    continue
                now = time.time()
                if now - last > 0.5:  # the stream is ~2/s already; keep the feed light
                    last = now
                    self.emit(job)
        except (asyncio.CancelledError, GeneratorExit):
            raise
        except Exception:
            pass  # e.g. too_many_streams; polling still works

    def _v2_failure(self, job: Job, e: local.V2Error) -> None:
        if e.status == 401:
            self._finish(job, "failed", "comfy-api-proxy refused the token. Check Settings → Local.", error=e.to_dict())
        elif e.code in ("queue_full", "rate_limited"):
            self._finish(job, "failed", "Your ComfyUI's queue is full. Try again in a moment.", error=e.to_dict(), fixes=["rerun"])
        elif e.code == "payload_too_large":
            self._finish(job, "failed", "An input is over the proxy's upload limit (100 MB by default).", error=e.to_dict(), fixes=["trim", "downscale"])
        else:
            self._finish(job, "failed", e.message or e.code, error=e.to_dict(), fixes=["rerun"])

    # ---- results -----------------------------------------------------------

    async def _finish_result(self, job: Job, result: Any, meta: dict) -> None:
        fail = engines.classify_failure(result)
        if fail:
            self._router_failure(job, RouterError(200, fail["error_type"], fail["message"]))
            return
        if isinstance(result, (bytes, bytearray)):
            data, ctype = bytes(result), meta.get("content_type", "")
        else:
            urls = engines.find_assets(result)
            if not urls:
                raise RuntimeError("The model finished but its result has no media URL")
            data, ctype = await self.router_factory().download(urls[0])
        native = result if not isinstance(result, (bytes, bytearray)) else {"binary": ctype}
        await self._save_media(job, data, ctype, native, meta)

    async def _save_media(self, job: Job, data: bytes, ctype: str, native: Any, meta: dict) -> None:
        folder = store.folder(job.id)
        m = sc.read(folder)
        out_dir = paths.output_root()
        (folder / "result").mkdir(exist_ok=True)
        (folder / "result" / "native.json").write_text(json.dumps(native, indent=2), "utf-8")

        is_video = ctype.startswith("video/") or data[4:8] == b"ftyp"
        elapsed = time.time() - (job.started or job.created)
        seed = engines.result_seed(native)
        if seed is None and isinstance(m.params.get("seed"), int) and m.params["seed"] >= 0:
            seed = m.params["seed"]
        res = sc.Result(
            kind="video" if is_video else "image",
            seed=seed,
            cost_reported=meta.get("credits_used"),
            elapsed=round(elapsed, 1),
            provider=meta.get("provider") or "comfy",
        )

        def write_files():
            recipe = recipe_manifest(m, res)
            if is_video:
                raw = folder / "result" / "_raw.mp4"
                raw.write_bytes(data)
                final = out_dir / f"{m.id}.mp4"
                try:
                    media.write_mp4_recipe(raw, final, recipe)
                except Exception:
                    shutil.copyfile(raw, final)
                media.preview(raw, folder / "result" / "preview.mp4")
                media.poster(raw, folder / "result" / "poster.webp")
                raw.unlink(missing_ok=True)
                res.file, res.poster = "result/preview.mp4", "result/poster.webp"
            else:
                img = media.open_image(data)
                final = out_dir / f"{m.id}.png"
                media.png_with_recipe(img, final, recipe)
                media.save_webp(img, folder / "result" / "image.webp", max_side=2048, quality=92)
                media.save_webp(img, folder / "result" / "poster.webp", max_side=960)
                res.file, res.poster = "result/image.webp", "result/poster.webp"
            res.output_file = str(final)

        await asyncio.to_thread(write_files)
        m.result = res
        m.status = "done"
        store.save(m)
        job.poster = _poster_url(m)
        where = "in your ComfyUI" if job.kind == "local" else "via Comfy"
        self._finish(job, "done", f"Ran on {job.model} {where} · {_fmt_elapsed(elapsed)}")

    def _router_failure(self, job: Job, e: RouterError) -> None:
        et = e.error_type
        if et in ("content_policy_violation", "moderated", "nsfw"):
            self._finish(job, "moderated", "The provider declined this request.", error=e.to_dict())
        elif et == "cancelled":
            self._finish(job, "cancelled", "Cancelled at Router.", error=e.to_dict())
        elif et == "insufficient_credits":
            self._finish(job, "failed", "Your Comfy workspace is out of credits. Nothing was charged.", error=e.to_dict())
        elif e.status == 413 or et == "request_too_large":
            self._finish(job, "failed", "Request too large (over 100 MiB)", error=e.to_dict(), fixes=["trim", "downscale"])
        elif e.status == 422 or et == "invalid_input":
            fields = [".".join(str(p) for p in v.get("loc", [])[1:]) for v in e.validation]
            msg = "; ".join(f"{f or 'body'}: {v.get('msg')}" for f, v in zip(fields, e.validation)) or e.message
            self._finish(job, "failed", f"Invalid input · {msg}", error=e.to_dict(), fixes=["edit"])
        elif et == "queue_timeout":
            self._finish(job, "failed", "Router's queue timed out before the run started. Nothing was charged.", error=e.to_dict(), fixes=["rerun"])
        elif e.status == 401:
            self._finish(job, "failed", "Router refused the API key. Check it in Settings.", error=e.to_dict())
        else:
            self._finish(job, "failed", e.message or et, error=e.to_dict(), fixes=["rerun"])

    def _finish(self, job: Job, state: str, detail: str, error: dict | None = None, fixes: list[str] | None = None) -> None:
        try:
            m = store.get(job.id)
            m.status = state if state in ("done", "failed", "moderated", "cancelled") else m.status
            if error or state != "done":
                m.result = m.result or sc.Result()
                m.result.error = error or {"message": detail}
                m.result.elapsed = round(time.time() - (job.started or job.created), 1)
            store.save(m)
        except Exception:
            pass
        self.set(job, state, detail, error=error, fixes=fixes or [], progress=None, preview=None)


MANAGER = Manager()


# ---- generation preparation ----------------------------------------------------


def resolve_asset(ref: str) -> Path:
    """An input's source: an upload id, ``gen:<id>/<relative path>``, or a template's sample ``tpl:<engine>|<slot>``."""
    if ref.startswith("tpl:"):
        engine_id, _, slot = ref[len("tpl:"):].rpartition("|")
        return engines.default_input(engine_id, slot)
    if ref.startswith("gen:"):
        sid, _, rel = ref[len("gen:"):].partition("/")
        base = store.folder(sid).resolve()
    else:
        base, rel = paths.uploads_dir().resolve(), ref
    p = (base / rel).resolve()
    if base not in p.parents and p != base:
        raise ValueError("asset path escapes its folder")
    if not p.is_file():
        raise FileNotFoundError(ref)
    return p


def input_plans(spec: dict) -> dict[str, prep.Plan]:
    """How each image of a spec will be cropped and sized, from file headers alone."""
    e = engines.get(spec["engine"])
    if not e.size:
        return {}
    images = []
    for i in spec.get("inputs", []):
        if i["slot"].startswith("image:") and i.get("asset"):
            w, h = media.image_size(resolve_asset(i["asset"]))
            images.append({"slot": i["slot"], "width": w, "height": h, "crop": i.get("crop")})
    return prep.plans(e.size, (spec.get("params") or {}).get("size"), images)


def prepare_generation(spec: dict, parent: str | None = None, variant_no: int | None = None) -> sc.Manifest:
    """Copy inputs into a new generation folder and write a running manifest."""
    sid = sc.new_id()
    folder = store.folder(sid)
    (folder / "refs").mkdir(parents=True, exist_ok=True)
    strip = settings.load().get("strip_exif", True)
    e = engines.get(spec["engine"])
    if e.kind == "local" and any(p.get("type") == "seed" for p in e.params):
        seed = spec.setdefault("params", {}).get("seed")
        if seed in (None, "") or int(seed) < 0:
            spec["params"]["seed"] = random.randint(0, 2**31 - 1)
        if spec.get("raw"):
            spec["raw"] = json.loads(json.dumps(spec["raw"]).replace(json.dumps(engines.SEED_TOKEN), str(spec["params"]["seed"])))

    # Crop and size every image once, here, so each engine gets what the studio showed.
    pictures: dict[str, Image.Image] = {}
    for raw in spec["inputs"]:
        if raw["slot"].startswith("image:") and raw.get("asset"):
            img = media.open_image(resolve_asset(raw["asset"]))
            pictures[raw["slot"]] = media.strip_exif(img) if strip else img
    plans = prep.plans(e.size, (spec.get("params") or {}).get("size"), [
        {"slot": r["slot"], "width": pictures[r["slot"]].width, "height": pictures[r["slot"]].height, "crop": r.get("crop")}
        for r in spec["inputs"] if r["slot"] in pictures
    ]) if e.size else {}
    if e.size and e.size["follows"] in plans:
        lead = plans[e.size["follows"]]
        spec["size_px"] = {"width": lead.width, "height": lead.height}

    items: list[sc.InputItem] = []
    img_n = 0
    for raw in spec["inputs"]:
        slot = raw["slot"]
        item = sc.InputItem(
            slot=slot, role=raw.get("role", "character"), license=raw.get("license", "unknown"),
            contains_person=bool(raw.get("contains_person")), consent=bool(raw.get("consent")),
            url=raw.get("url") or None, label=raw.get("label"),
        )
        src = resolve_asset(raw["asset"]) if raw.get("asset") else None
        if slot.startswith("image:") and src:
            img_n += 1
            img = pictures[slot]
            if slot in plans:
                img = prep.apply(img, plans[slot])
                item.prep = plans[slot].to_dict()
            ext = ".png" if img.mode == "RGBA" else ".jpg"
            rel = f"refs/ref-{img_n:02d}{ext}"
            if ext == ".png":
                img.save(folder / rel, "PNG")
            else:
                img.convert("RGB").save(folder / rel, "JPEG", quality=95)
            item.file, item.width, item.height = rel, img.width, img.height
            item.thumb = media.thumbnail_data_uri(img)
        elif slot.startswith("video:") and src:
            (folder / "driving").mkdir(exist_ok=True)
            trim = raw.get("trim") or [0, 0]
            budget = int(media.REQUEST_MEDIA_BUDGET * 0.8)
            lo, hi = e.fps_window
            max_h = min(int(raw.get("max_height") or 1080), e.video_max_height or 1080)
            info = media.transcode(src, folder / "driving" / "driving.mp4", start=float(trim[0] or 0), end=float(trim[1] or 0) or None,
                                   max_bytes=budget, min_fps=lo, max_fps=hi, max_height=max_h)
            media.poster(folder / "driving" / "driving.mp4", folder / "driving" / "poster.webp")
            item.file, item.width, item.height, item.duration = "driving/driving.mp4", info["width"], info["height"], info["duration"]
            item.trim = [float(trim[0] or 0), float(trim[1] or 0)]
            item.role = "motion"
        if item.file:
            item.sha256 = sc.sha256_file(folder / item.file)
        items.append(item)

    template = spec.get("raw") or engines.compose(spec)["template"]
    title = (spec.get("title") or "").strip() or _auto_title(spec)
    if variant_no:
        title = f"{title} · v{variant_no}"
    lineage = sc.Lineage(
        forked_from=spec.get("forked_from"), parent=parent,
        chain=list(spec.get("chain") or []),
    )
    m = sc.Manifest(
        id=sid, title=title, mode=e.mode if e.curated else spec.get("mode", e.mode),
        engine=sc.Engine(kind="local" if e.kind == "local" else "router", model=e.id, provider=e.provider, schema_version=spec.get("schema_version")),
        inputs=items, prompt=spec.get("prompt", ""), boxes=spec.get("boxes") or [],
        params=spec.get("params") or {}, request_template=template, status="running",
        tags=spec.get("tags") or [], lineage=lineage,
    )
    store.save(m, shelf="mine")
    _write_workflow(folder, m)
    # Record the other side of a chain (Edit → Motion).
    for ref in m.lineage.chain:
        kind, _, other = ref.partition(":")
        try:
            o = store.get(other)
            if sid not in o.lineage.sent_to:
                o.lineage.sent_to.append(sid)
                store.save(o)
        except Exception:
            pass
    return m


def _write_workflow(folder: Path, m: sc.Manifest) -> None:
    """Local generations carry the workflow that ran, openable in stock ComfyUI."""
    if m.engine.kind != "local":
        return
    (folder / "comfy").mkdir(exist_ok=True)
    (folder / "comfy" / "workflow.json").write_text(json.dumps(workflow_file(m), indent=2), "utf-8")


def workflow_file(m: sc.Manifest) -> dict:
    """The API-format workflow with media tokens swapped for the input filenames.

    ComfyUI loads API-format JSON by drag and drop; the user copies the generation's
    refs into ComfyUI's input folder (or re-picks them) before queueing.
    """
    by_slot = {i.slot: i for i in m.inputs}

    def name(kind, n, form):
        item = by_slot.get(f"{kind}:{n}")
        return Path(item.file).name if item and item.file else f"{kind}_{n}"

    return engines.materialize(m.request_template, name)


def recipe_manifest(m: sc.Manifest, res: sc.Result | None = None) -> dict:
    """The Recipe-only manifest that rides inside output files."""
    d = sc.dump(m)
    d["variant"] = "recipe"
    if res is not None:
        r = res.model_dump(mode="json")
        r.pop("output_file", None)
        d["result"] = r
    for i in d["inputs"]:
        i["file"] = None
    d.pop("starred", None)
    return d


def _auto_title(spec: dict) -> str:
    p = " ".join((spec.get("prompt") or "").split())
    for sentence in p.split("."):
        s = sentence.strip()
        if s and not s.lower().startswith(("image ", "video ")):
            return (s[:48] + "…") if len(s) > 48 else s
    return "Motion run" if engines.get(spec["engine"]).mode == "motion" else "Edit run"


def _poster_url(m: sc.Manifest) -> str | None:
    if m.result and m.result.poster:
        return f"/api/generations/{m.id}/file/{m.result.poster}"
    for i in m.inputs:
        if i.slot.startswith("video:") and i.file:
            return f"/api/generations/{m.id}/file/driving/poster.webp"
    for i in m.inputs:
        if i.file:
            return f"/api/generations/{m.id}/file/{i.file}"
    return None


def _fmt_elapsed(s: float) -> str:
    s = int(s)
    return f"{s // 60}m {s % 60:02d}s" if s >= 60 else f"{s}s"


def guess_ext(ctype: str, default: str = ".bin") -> str:
    return mimetypes.guess_extension(ctype.split(";")[0].strip()) or default
