"""Covers, sample inputs and clip limits of a template."""

from __future__ import annotations

import functools
import re
from pathlib import Path
from urllib.parse import quote

from PIL import Image

from .. import fit, media, paths
from .contract import Engine


# ---- covers ------------------------------------------------------------------
# A template's tile in the Library: a poster image, plus an optional short muted
# loop. The user's choice (saved under covers/) wins over the one the template
# ships with; neither is required. A cover is a real result, shown beside the input
# it was made from: a cover set from a run keeps a copy of that run's lead input
# (``.before.webp`` / ``.before.mp4``); a shipped cover was made from the shipped samples.

COVER_SIDE = 1600  # sharp on a hi-dpi stage, beside its input
COVER_LOOP_SECONDS = 8.0
# Covers and samples are cached as immutable. Bump this to make browsers fetch them
# again, e.g. after empty bodies were cached while aiohttp's sendfile was broken on Windows.
CACHE_ERA = "&c=2"
_VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}
BEFORE_EXT = (".before.webp", ".before.mp4")


def user_cover(engine_id: str, ext: str = ".webp") -> Path:
    return paths.user_root() / "covers" / (re.sub(r"[^A-Za-z0-9._-]+", "__", engine_id) + ext)


def cover_files(e: Engine) -> tuple[Path | None, Path | None]:
    """(poster, loop) for this template, either may be missing."""
    own = user_cover(e.id)
    if own.is_file():
        loop = user_cover(e.id, ".mp4")
        return own, loop if loop.is_file() else None
    poster = e.cover if e.cover and e.cover.is_file() else None
    loop = e.cover_video if e.cover_video and e.cover_video.is_file() else None
    return poster, loop


def cover_file(e: Engine, video: bool = False) -> Path | None:
    return cover_files(e)[1 if video else 0]


def lead_slot(e: Engine) -> str | None:
    """The input the stage shows a run by: the first clip, else the first photo (Create's ``leadSlot``)."""
    media = [f for f in e.fields if f["type"] in ("video", "image")]
    return next((f["key"] for f in media if f["type"] == "video"), None) or next((f["key"] for f in media), None)


# Router roles whose file a result is made over, so a wipe between the two shows the change. A reference
# (photo, clip or style) only guides the result: shown beside it, it isn't a before.
OVER_ROLES = {"Photo", "First frame", "Video to edit"}


def lead_is_before(e: Engine) -> bool:
    """Whether the lead input is what the result is made over: every local workflow takes its lead that way;
    on Router it's the role the request puts it in (a model we know nothing about keeps the comparison)."""
    slot = lead_slot(e)
    if slot is None:
        return False
    r = fit.role(e, slot) if e.kind != "local" else None
    return r is None or r in OVER_ROLES


def cover_before(e: Engine) -> Path | None:
    """The input the cover was made from, or None when that isn't known (no cover, a template
    without photos or clips, or a cover set before covers kept their input) or isn't a before (a reference)."""
    if not lead_is_before(e):
        return None
    if user_cover(e.id).is_file():
        return next((p for p in (user_cover(e.id, x) for x in BEFORE_EXT) if p.is_file()), None)
    if cover_files(e)[0] is None:
        return None
    slot = lead_slot(e)
    p = e.default_inputs.get(slot) if slot else None
    return p if p is not None and p.is_file() else None


@functools.lru_cache(maxsize=256)
def _aspect(path: str, _mtime: int) -> float:
    with Image.open(path) as img:
        return round(img.width / max(1, img.height), 4)


@functools.lru_cache(maxsize=256)
def _dims(path: str, _mtime: int) -> tuple[int, int]:
    return media.image_size(path)


@functools.lru_cache(maxsize=64)
def _clip(path: str, _mtime: int) -> dict:
    return media.probe(path)


def defaults_info(e: Engine) -> dict:
    """What a template opens with: its prompt, and a sample for each slot that has one.
    Samples are assets like uploads (``tpl:<engine>|<slot>``), so runs and remixes treat them the same."""
    inputs = []
    for slot, p in e.default_inputs.items():
        if not p.is_file():
            continue
        v = p.stat().st_mtime_ns // 1_000_000
        url = f"/api/templates/input?engine={quote(e.id, safe='')}&slot={quote(slot, safe='')}&v={v}{CACHE_ERA}"
        item = {"slot": slot, "asset": f"tpl:{e.id}|{slot}", "name": p.name, "url": url}
        if p.suffix.lower() in _VIDEO_EXT:
            info = _clip(str(p), v)
            item.update(kind="video", width=info["width"], height=info["height"], duration=info["duration"], fps=info["fps"],
                        has_audio=info["has_audio"], poster=f"{url}&poster=1")
        elif p.suffix.lower() in media.AUDIO_EXT:
            item.update(kind="audio", duration=media.audio_info(p)["duration"])
        else:
            w, h = _dims(str(p), v)
            item.update(kind="image", width=w, height=h)
        inputs.append(item)
    return {"prompt": e.default_prompt, "inputs": inputs}


def _cover_info(e: Engine) -> dict:
    poster, loop = cover_files(e)
    if poster is None:
        return {"cover": None, "cover_video": None, "cover_aspect": None, "cover_before": None}
    before = cover_before(e)
    # Served immutable: the version moves when any of the three files does, not just the poster.
    v = max(p.stat().st_mtime_ns for p in (poster, loop, before) if p is not None) // 1_000_000
    url = f"/api/cover?engine={quote(e.id, safe='')}&v={v}{CACHE_ERA}"
    return {
        "cover": url,
        "cover_video": f"{url}&video=1" if loop else None,
        "cover_aspect": _aspect(str(poster), v),
        "cover_before": {"url": f"{url}&before=1", "kind": "video" if before.suffix.lower() in _VIDEO_EXT else "image"} if before else None,
    }


def set_cover(engine_id: str, src: Path, loop: Path | None = None, before: Path | None = None) -> Path:
    """Make ``src`` this template's cover. A video becomes a short loop, with its sound,
    plus its first frame as the poster; ``loop`` adds a loop to an image poster.
    Cards play the loop muted; Create's example plays its sound.
    ``before``: the input it was made from, kept beside it the same way."""
    dst = user_cover(engine_id)
    dst.parent.mkdir(parents=True, exist_ok=True)
    clip = loop or (src if src.suffix.lower() in _VIDEO_EXT else None)
    poster = media.frame_at(src) if src.suffix.lower() in _VIDEO_EXT else media.open_image(src)
    mp4 = user_cover(engine_id, ".mp4")
    if clip is None:
        mp4.unlink(missing_ok=True)
    else:
        tmp = mp4.with_suffix(".tmp.mp4")
        media.transcode(clip, tmp, end=COVER_LOOP_SECONDS, max_height=720, max_bytes=4 * 1024 * 1024, min_fps=1)
        tmp.replace(mp4)
    for x in BEFORE_EXT:
        user_cover(engine_id, x).unlink(missing_ok=True)
    if before is not None and before.is_file():
        if before.suffix.lower() in _VIDEO_EXT:
            tmp = user_cover(engine_id, ".before.tmp.mp4")
            media.transcode(before, tmp, end=COVER_LOOP_SECONDS, max_height=720, max_bytes=4 * 1024 * 1024,
                            min_fps=1, keep_audio=False)
            tmp.replace(user_cover(engine_id, ".before.mp4"))
        else:
            media.save_webp(media.open_image(before), user_cover(engine_id, ".before.webp"), max_side=COVER_SIDE)
    return media.save_webp(poster, dst, max_side=COVER_SIDE)


def clear_cover(engine_id: str) -> None:
    for x in (".webp", ".mp4", *BEFORE_EXT):
        user_cover(engine_id, x).unlink(missing_ok=True)


def clip_limits(e: Engine, slot: str) -> tuple[tuple[float, float] | None, tuple[float, float]]:
    """A video input's clip length (None: any) and frame rates: the input's own, else what the
    model takes (its ``fit``), else the template's."""
    f = next((f for f in e.fields if f["key"] == slot), None)
    if f is not None:
        ft = fit.of(e, slot)
        secs = (fit.lo(ft, "seconds") or 0.0, fit.hi(ft, "seconds") or 600.0) if ft.get("seconds") else None
        rate = (fit.lo(ft, "fps") or 1.0, fit.hi(ft, "fps") or 240.0) if ft.get("fps") else None
        return (tuple(f["window"]) if f.get("window") else secs), tuple(f.get("fps") or rate or (1.0, 60.0))
    return e.video_window, e.fps_window


def clip_file(slot: str) -> str:
    """Where a generation keeps the clip for a video input: video:1 at driving/driving.mp4, video:2 at driving/driving-2.mp4."""
    n = slot.split(":")[1]
    return "driving/driving.mp4" if n == "1" else f"driving/driving-{n}.mp4"


def poster_file(clip: str) -> str:
    """The poster next to a clip: driving/driving-2.mp4 -> driving/poster-2.webp."""
    return clip.replace("/driving", "/poster", 1).rsplit(".", 1)[0] + ".webp"
