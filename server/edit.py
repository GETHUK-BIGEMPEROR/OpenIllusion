"""The media editor's work: one photo, clip or sound in, a new upload out. The original stays.

Edits (``ops``), all optional, in the order they happen:

    {"rotate": 0 | 90 | 180 | 270,            # clockwise
     "flip": "h" | "v" | null,
     "crop": [x, y, w, h],                     # fractions of the turned picture
     "width": 1024, "height": 576,             # the size it ends at (default: the crop's own pixels)
     "start": 1.5, "end": 6.5,                 # seconds kept (clips and sounds)
     "fps": 24,                                # clips: resampled to this rate
     "mute": false}                            # clips: drop the sound

Also ``normalize``: an upload in a format browsers and models don't take (TIFF, BMP,
AVIF, GIF, MKV, AVI, WMA...) is turned into one they do (PNG, MP4, MP3) as it arrives.
"""

from __future__ import annotations

import hashlib
import io
import math
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any

import av
from PIL import Image, ImageOps

from . import media, paths, prep

# Uploads taken as they are, and the ones turned into those on arrival.
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v"}
TO_PNG = {".gif", ".bmp", ".tif", ".tiff", ".avif", ".tga", ".ico"}
TO_MP4 = {".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".3gp", ".ts", ".mts", ".m2ts", ".ogv"}
TO_MP3 = {".wma", ".aiff", ".aif", ".opus", ".amr"}
CONVERTED = TO_PNG | TO_MP4 | TO_MP3
MAX_SIDE = 8192


class EditError(ValueError):
    """Edits that can't apply to this file."""


def kind_of(p: Path) -> str:
    ext = p.suffix.lower()
    if ext in IMAGE_EXT | TO_PNG:
        return "image"
    if ext in VIDEO_EXT | TO_MP4:
        return "video"
    if ext in media.AUDIO_EXT | TO_MP3:
        return "audio"
    raise EditError(f"{ext or 'This file'} isn't a photo, clip or sound")


def _store(make, ext: str) -> Path:
    """Write what ``make(path)`` makes into uploads, named by its content like any upload."""
    with tempfile.TemporaryDirectory(dir=paths.uploads_dir()) as tmp:
        out = Path(tmp) / f"out{ext}"
        make(out)
        h = hashlib.sha256(out.read_bytes()).hexdigest()[:24]
        dst = paths.uploads_dir() / f"{h}{ext}"
        if not dst.exists():
            out.replace(dst)
    return dst


def _turn(rotate: int, flip: str | None):
    def f(img: Image.Image) -> Image.Image:
        if rotate:
            img = img.rotate(-rotate, expand=True)  # PIL turns counter-clockwise
        if flip == "h":
            img = ImageOps.mirror(img)
        elif flip == "v":
            img = ImageOps.flip(img)
        return img
    return f


def _ops(ops: Any) -> dict:
    if not isinstance(ops, dict):
        raise EditError("Send the edits as an object")
    o: dict[str, Any] = {}
    r = ops.get("rotate") or 0
    if r not in (0, 90, 180, 270):
        raise EditError("Rotate by 0, 90, 180 or 270 degrees")
    o["rotate"] = int(r)
    if ops.get("flip") not in (None, "h", "v"):
        raise EditError("Flip is h or v")
    o["flip"] = ops.get("flip")
    c = ops.get("crop")
    if c is not None and not (isinstance(c, list) and len(c) == 4 and all(isinstance(v, (int, float)) for v in c)):
        raise EditError("Crop is [x, y, w, h] as fractions")
    o["crop"] = c
    for k in ("width", "height"):
        v = ops.get(k)
        if v is not None and not (isinstance(v, (int, float)) and 8 <= v <= MAX_SIDE):
            raise EditError(f"{k.capitalize()} is 8 to {MAX_SIDE} px")
        o[k] = int(round(v)) if v is not None else None
    for k in ("start", "end"):
        v = ops.get(k)
        if v is not None and not (isinstance(v, (int, float)) and v >= 0 and math.isfinite(v)):
            raise EditError(f"{k.capitalize()} is seconds, 0 or more")
        o[k] = float(v) if v is not None else None
    if o["start"] is not None and o["end"] is not None and o["end"] - o["start"] < 0.1:
        raise EditError("Keep at least 0.1 s")
    f = ops.get("fps")
    if f is not None and not (isinstance(f, (int, float)) and 1 <= f <= 120):
        raise EditError("Frame rate is 1 to 120")
    o["fps"] = float(f) if f is not None else None
    o["mute"] = bool(ops.get("mute"))
    return o


def _plan(w: int, h: int, o: dict, even: bool) -> prep.Plan:
    """The crop (fractions of a w x h picture) and the size it ends at."""
    l, t, r, b = prep._crop_box(w, h, o["crop"])
    cw, ch = r - l, b - t
    W, H = o["width"], o["height"]
    if W and not H:
        H = round(W * ch / cw)
    elif H and not W:
        W = round(H * cw / ch)
    W, H = W or round(cw), H or round(ch)
    if even:
        W, H = max(2, W - W % 2), max(2, H - H % 2)
    if all(abs(v - round(v)) < 1e-6 for v in (l, t, r, b)):
        l, t, r, b = (float(round(v)) for v in (l, t, r, b))
    return prep.Plan(source=(w, h), box=(l, t, r, b), width=int(W), height=int(H))


def edit(src: Path, ops: Any) -> Path:
    """Apply the edits to a photo, clip or sound. Returns the new upload."""
    o = _ops(ops)
    kind = kind_of(src)
    if kind == "image":
        img = _turn(o["rotate"], o["flip"])(media.open_image(src))
        img = prep.apply(img, _plan(img.width, img.height, o, even=False))
        alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        lossless = alpha or src.suffix.lower() == ".png"
        img = media.strip_exif(img)
        return _store(lambda out: img.save(out, "PNG") if lossless else img.convert("RGB").save(out, "JPEG", quality=95),
                      ".png" if lossless else ".jpg")
    if kind == "video":
        info = media.probe(src)
        w, h = int(info["width"]), int(info["height"])
        if o["rotate"] in (90, 270):
            w, h = h, w
        plan = _plan(w, h, o, even=True)
        turned = o["rotate"] or o["flip"]
        fps = o["fps"] or info["fps"] or 30.0
        bps = int(min(30e6, max(2e6, plan.width * plan.height * fps * 0.12)))
        return _store(lambda out: media.transcode(
            src, out, start=o["start"] or 0.0, end=o["end"], min_fps=o["fps"] or 1.0, max_fps=o["fps"] or 240.0,
            keep_audio=not o["mute"], plan=plan, pre=_turn(o["rotate"], o["flip"]) if turned else None, video_bps=bps), ".mp4")
    return _store(lambda out: media.transcode_audio(src, out, start=o["start"] or 0.0, end=o["end"]), ".mp3")


# ---- uploads in other formats ------------------------------------------------------


def _gif_to_mp4(src: Path, out: Path) -> None:
    with Image.open(src) as im:
        frames, delays = [], []
        for n in range(getattr(im, "n_frames", 1)):
            im.seek(n)
            frames.append(im.convert("RGB"))
            delays.append(max(20, int(im.info.get("duration") or 100)))
    fps = min(50.0, max(1.0, 1000 / (sum(delays) / len(delays))))
    w, h = frames[0].width - frames[0].width % 2, frames[0].height - frames[0].height % 2
    rate = Fraction(fps).limit_denominator(1001)
    with av.open(str(out), "w", format="mp4") as c:
        s = c.add_stream("libx264", rate=rate)
        s.width, s.height, s.pix_fmt = w, h, "yuv420p"
        s.options = {"crf": "18", "preset": "veryfast", "movflags": "+faststart"}
        for n, f in enumerate(frames):
            vf = av.VideoFrame.from_image(f.crop((0, 0, w, h))).reformat(format="yuv420p")
            vf.pts = n
            vf.time_base = Fraction(1) / rate
            for pkt in s.encode(vf):
                c.mux(pkt)
        for pkt in s.encode():
            c.mux(pkt)


def normalize(p: Path) -> Path:
    """An upload in a format the app takes as it is: itself. Otherwise a new upload in one
    (PNG, MP4, MP3; an animated GIF becomes a clip), and the original is removed."""
    ext = p.suffix.lower()
    if ext not in CONVERTED:
        return p
    if ext == ".gif":
        with Image.open(p) as im:
            animated = getattr(im, "n_frames", 1) > 1
        if animated:
            dst = _store(lambda out: _gif_to_mp4(p, out), ".mp4")
            p.unlink(missing_ok=True)
            return dst
    if ext in TO_PNG:
        img = media.strip_exif(media.open_image(p))
        buf = io.BytesIO()
        img.save(buf, "PNG")
        dst = _store(lambda out: out.write_bytes(buf.getvalue()), ".png")
    elif ext in TO_MP4:
        dst = _store(lambda out: media.transcode(p, out, max_height=100_000, min_fps=1.0, max_fps=240.0, video_bps=12_000_000), ".mp4")
    else:
        dst = _store(lambda out: media.transcode_audio(p, out), ".mp3")
    p.unlink(missing_ok=True)
    return dst
