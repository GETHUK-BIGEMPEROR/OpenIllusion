"""Reading a finished run: failures, output files, inline media, the seed used."""

from __future__ import annotations

import re
from typing import Any


# ---- results --------------------------------------------------------------

VIDEO_EXT = (".mp4", ".webm", ".mov")
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp")


def classify_failure(result: Any) -> dict | None:
    """Provider-native failure inside a 200 body (H3 task.status, Higgsfield, BFL, Kling, Freepik, WaveSpeed, VEED)."""
    if not isinstance(result, dict):
        return None
    st = result.get("status")
    if st in ("Request Moderated", "Content Moderated"):
        return {"error_type": "content_policy_violation", "message": "The provider declined this request."}
    if st in ("Error", "Task not found"):
        return {"error_type": "provider_failed", "message": str(result.get("details") or st)}
    d = result.get("data")
    if isinstance(d, dict):
        if str(d.get("task_status") or d.get("status") or "").lower() == "failed":
            return {"error_type": "provider_failed", "message": str(d.get("task_status_msg") or d.get("error") or "The provider says the run failed")}
        err = d.get("error")
        if isinstance(err, dict) and err.get("message"):
            return {"error_type": "provider_failed", "message": str(err["message"])}
    task = result.get("task")
    if isinstance(task, dict) and task.get("status") in ("failed", "cancelled", "expired"):
        err = task.get("error") or {}
        return {"error_type": "provider_failed", "message": err.get("message") or f"Task {task['status']}"}
    st = result.get("status")
    if st == "nsfw":
        return {"error_type": "content_policy_violation", "message": "The provider declined this request."}
    if st in ("failed", "canceled"):
        return {"error_type": "provider_failed", "message": result.get("error") or f"Request {st}"}
    return None


def find_assets(result: Any) -> list[str]:
    """Every downloadable URL in a native result, best guesses first."""
    preferred: list[str] = []
    others: list[str] = []

    def walk(v, key=""):
        if isinstance(v, str):
            if v.startswith(("http://", "https://")):
                low = v.split("?", 1)[0].lower()
                if key in ("sample", "url") or low.endswith(VIDEO_EXT + IMAGE_EXT):
                    preferred.append(v)
                elif key not in ("status_url", "cancel_url", "response_url"):
                    others.append(v)
        elif isinstance(v, list):
            for x in v:
                walk(x, key)
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, k)

    walk(result)
    seen, out = set(), []
    for u in preferred + others:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


_B64 = re.compile(r"^[A-Za-z0-9+/=\s]{200,}$")
_MAGIC = ((b"\x89PNG", "image/png"), (b"\xff\xd8", "image/jpeg"), (b"GIF8", "image/gif"), (b"\x1aE\xdf\xa3", "video/webm"))


def _walk_path(v: Any, path: list) -> list[tuple[Any, list]]:
    """Every value at ``path`` in ``v``; ``"*"`` stands for any list index."""
    if not path:
        return [(v, [])]
    k, rest = path[0], path[1:]
    if k == "*":
        return [(x, [i, *p]) for i, item in enumerate(v) for x, p in _walk_path(item, rest)] if isinstance(v, list) else []
    if isinstance(v, dict) and isinstance(k, str) and k in v:
        return [(x, [k, *p]) for x, p in _walk_path(v[k], rest)]
    if isinstance(v, list) and isinstance(k, int) and -len(v) <= k < len(v):
        return [(x, [k, *p]) for x, p in _walk_path(v[k], rest)]
    return []


def _media_value(v: Any) -> tuple[str, str] | None:
    if not isinstance(v, str) or not v:
        return None
    if v.startswith(("http://", "https://")):
        return "url", v
    if v.startswith("data:") and ";base64," in v[:100]:
        return "b64", v.split(",", 1)[1]
    if _B64.match(v[:4096]):
        return "b64", v
    return None


def result_media(result: Any, paths_: list[list] | None) -> tuple[str, str, list] | None:
    """The finished media in a native Router result: ("url" | "b64", value, where it was).

    A template names the paths; the first one holding a link or base64 wins. With none
    named, or none of them holds one, any image or video link is taken, then any long
    base64 string."""
    for p in paths_ or []:
        for v, at in _walk_path(result, list(p)):
            hit = _media_value(v)
            if hit:
                return (*hit, at)
    urls = find_assets(result)
    if urls:
        return "url", urls[0], []
    found: list = []

    def walk(v, at):
        if found:
            return
        if isinstance(v, str):
            hit = _media_value(v)
            if hit and hit[0] == "b64":
                found.append((*hit, at))
        elif isinstance(v, list):
            for i, x in enumerate(v):
                walk(x, [*at, i])
        elif isinstance(v, dict):
            for k, x in v.items():
                walk(x, [*at, k])

    walk(result, [])
    return found[0] if found else None


def decode_media(b64: str) -> tuple[bytes, str]:
    """Bytes and a content type for base64 media from a result."""
    import base64

    data = base64.b64decode("".join(b64.split()))
    for magic, ctype in _MAGIC:
        if data.startswith(magic):
            return data, ctype
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return data, "image/webp"
    if data[4:8] == b"ftyp":
        return data, "video/mp4"
    return data, "application/octet-stream"


def slim(result: Any) -> Any:
    """A native result with inline media swapped for a note, so it can be kept beside the file."""
    if isinstance(result, str):
        hit = _media_value(result)
        return f"<base64, {len(result) * 3 // 4} bytes>" if hit and hit[0] == "b64" else result
    if isinstance(result, list):
        return [slim(x) for x in result]
    if isinstance(result, dict):
        return {k: slim(x) for k, x in result.items()}
    return result


def result_seed(result: Any) -> int | None:
    if isinstance(result, dict):
        r = result.get("result")
        if isinstance(r, dict) and isinstance(r.get("seed"), int):
            return r["seed"]
        t = result.get("task")
        if isinstance(t, dict) and isinstance(t.get("seed"), int):
            return t["seed"]
    return None
