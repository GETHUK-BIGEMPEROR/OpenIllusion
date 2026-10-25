"""Media plumbing: probe, trim and transcode video, posters, embedded recipes.

Video goes through PyAV (ffmpeg's libraries, already in ComfyUI's
environment), images through Pillow. Nothing here shells out.
"""

from __future__ import annotations

import base64
import io
import json
import math
from fractions import Fraction
from pathlib import Path

import av
from PIL import Image, ImageOps, PngImagePlugin

RECIPE_KEY = "openillusion"  # PNG text chunk keyword and MP4 comment prefix
MP4_PREFIX = "openillusion:"

# Router caps a request body at 100 MiB; base64 inflates by 4/3, and the rest
# of the body needs headroom, so raw media should stay under ~75 MB in total.
REQUEST_MEDIA_BUDGET = 75 * 1024 * 1024


# ---- video ---------------------------------------------------------------


def probe(path: str | Path) -> dict:
    with av.open(str(path)) as c:
        v = next((s for s in c.streams if s.type == "video"), None)
        duration = float(c.duration / av.time_base) if c.duration else 0.0
        info = {
            "duration": round(duration, 3),
            "has_audio": any(s.type == "audio" for s in c.streams),
            "width": v.codec_context.width if v else 0,
            "height": v.codec_context.height if v else 0,
            "fps": float(v.average_rate) if v and v.average_rate else 0.0,
            "codec": v.codec_context.name if v else None,
        }
        if not info["duration"] and v and v.duration and v.time_base:
            info["duration"] = round(float(v.duration * v.time_base), 3)
    return info


def transcode(
    src: str | Path,
    dst: str | Path,
    start: float = 0.0,
    end: float | None = None,
    max_height: int = 1080,
    max_bytes: int | None = None,
    min_fps: float = 23.976,
    max_fps: float = 60.0,
    keep_audio: bool = True,
    metadata: dict | None = None,
) -> dict:
    """Trim to [start, end) and re-encode as H.264/AAC MP4.

    The bitrate is chosen so the file lands under ``max_bytes`` when given.
    Frame rate is clamped into the engine's accepted window.
    """
    info = probe(src)
    end = info["duration"] if end is None or end <= 0 else min(end, info["duration"] or end)
    length = max(0.1, end - start)

    h = min(max_height, info["height"] or max_height)
    h -= h % 2
    w = int(round((info["width"] or h) * h / max(1, info["height"] or h)))
    w -= w % 2

    fps = info["fps"] or 30.0
    fps = min(max(fps, min_fps), max_fps)
    rate = Fraction(fps).limit_denominator(1001)

    if max_bytes:
        audio_bps = 128_000 if keep_audio and info["has_audio"] else 0
        video_bps = int(max_bytes * 8 * 0.92 / length) - audio_bps
        video_bps = max(250_000, min(video_bps, 12_000_000))
    else:
        video_bps = 8_000_000

    with av.open(str(src)) as inp, av.open(str(dst), "w", format="mp4") as out:
        if metadata:
            out.metadata.update({k: str(v) for k, v in metadata.items()})
        vin = next(s for s in inp.streams if s.type == "video")
        ain = next((s for s in inp.streams if s.type == "audio"), None) if keep_audio else None

        vout = out.add_stream("libx264", rate=rate)
        vout.width, vout.height = w, h
        vout.pix_fmt = "yuv420p"
        vout.bit_rate = video_bps
        vout.options = {"preset": "veryfast", "movflags": "+faststart"}

        aout = None
        resampler = None
        if ain is not None:
            aout = out.add_stream("aac", rate=48000)
            aout.bit_rate = 128_000
            resampler = av.AudioResampler(format="fltp", layout="stereo", rate=48000)

        if start > 0:
            inp.seek(int(start / av.time_base), any_frame=False, backward=True)

        frame_step = 1.0 / float(rate)
        next_t = start
        n = 0
        streams = [vin] + ([ain] if ain is not None else [])
        a_pts = 0
        for frame in inp.decode(*streams):
            t = float(frame.pts * frame.time_base) if frame.pts is not None else None
            if t is None:
                continue
            if isinstance(frame, av.VideoFrame):
                if t < start - 1e-3:
                    continue
                if t >= end:
                    continue
                # Duplicate or drop frames to hit the target rate.
                while next_t <= t + 1e-6 and next_t < end:
                    f = frame.reformat(width=w, height=h, format="yuv420p")
                    f.pts = n
                    f.time_base = Fraction(1) / rate
                    for pkt in vout.encode(f):
                        out.mux(pkt)
                    n += 1
                    next_t = start + n * frame_step
            elif aout is not None and start <= t < end:
                for rf in resampler.resample(frame):
                    rf.pts = a_pts
                    a_pts += rf.samples
                    for pkt in aout.encode(rf):
                        out.mux(pkt)
        for pkt in vout.encode():
            out.mux(pkt)
        if aout is not None:
            for pkt in aout.encode():
                out.mux(pkt)

    return probe(dst) | {"bytes": Path(dst).stat().st_size}


def frame_at(src: str | Path, t: float = 0.0) -> Image.Image:
    with av.open(str(src)) as c:
        v = next(s for s in c.streams if s.type == "video")
        if t > 0:
            c.seek(int(t / av.time_base), any_frame=False, backward=True)
        last = None
        for frame in c.decode(v):
            last = frame
            ft = float(frame.pts * frame.time_base) if frame.pts is not None else 0.0
            if ft >= t - 1e-3:
                break
        if last is None:
            raise ValueError("no video frames")
        return last.to_image()


def poster(src: str | Path, dst: str | Path, t: float | None = None, max_side: int = 960) -> Path:
    if t is None:
        try:
            t = min(1.0, probe(src)["duration"] / 3)
        except Exception:
            t = 0.0
    img = frame_at(src, t)
    return save_webp(img, dst, max_side=max_side)


def preview(src: str | Path, dst: str | Path, max_height: int = 720, max_bytes: int = 8 * 1024 * 1024) -> dict:
    return transcode(src, dst, max_height=max_height, max_bytes=max_bytes, min_fps=1, max_fps=60)


def write_mp4_recipe(src: str | Path, dst: str | Path, manifest: dict) -> None:
    """Remux without re-encoding and set the container comment to the recipe."""
    payload = MP4_PREFIX + b64url(json.dumps(manifest, separators=(",", ":")).encode())
    with av.open(str(src)) as inp, av.open(str(dst), "w", format="mp4") as out:
        out.metadata.update({k: v for k, v in inp.metadata.items() if k not in ("comment",)})
        out.metadata["comment"] = payload
        mapping = {}
        for s in inp.streams:
            if s.type in ("video", "audio"):
                mapping[s.index] = out.add_stream_from_template(s)
        for pkt in inp.demux(*[s for s in inp.streams if s.index in mapping]):
            if pkt.dts is None:
                continue
            pkt.stream = mapping[pkt.stream.index]
            out.mux(pkt)


def read_mp4_recipe(path: str | Path) -> dict | None:
    try:
        with av.open(str(path)) as c:
            raw = c.metadata.get("comment") or c.metadata.get("description") or ""
    except Exception:
        return None
    if not raw.startswith(MP4_PREFIX):
        return None
    try:
        return json.loads(b64url_decode(raw[len(MP4_PREFIX):]))
    except ValueError:
        return None


# ---- images --------------------------------------------------------------


def open_image(data: bytes | str | Path) -> Image.Image:
    """Decoded, and turned upright the way browsers show it (EXIF orientation applied)."""
    img = Image.open(io.BytesIO(data) if isinstance(data, bytes) else str(data))
    img.load()
    return ImageOps.exif_transpose(img) or img


def image_size(path: str | Path) -> tuple[int, int]:
    """Width and height as shown upright, read from the header without decoding."""
    with Image.open(str(path)) as img:
        w, h = img.size
        return (h, w) if img.getexif().get(0x0112) in (5, 6, 7, 8) else (w, h)


def strip_exif(img: Image.Image) -> Image.Image:
    """A copy with pixel data only: no EXIF, GPS or text chunks."""
    alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    mode = "RGBA" if alpha else "RGB"
    clean = Image.new(mode, img.size)
    clean.paste(img.convert(mode))
    return clean


def fit(img: Image.Image, max_side: int | None = None, max_pixels: int | None = None, min_side: int | None = None) -> Image.Image:
    w, h = img.size
    scale = 1.0
    if max_side and max(w, h) > max_side:
        scale = min(scale, max_side / max(w, h))
    if max_pixels and w * h * scale * scale > max_pixels:
        scale = min(scale, math.sqrt(max_pixels / (w * h)))
    if min_side and min(w, h) * scale < min_side:
        scale = max(scale, min_side / min(w, h))
    if abs(scale - 1.0) < 1e-3:
        return img
    return img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)


def save_webp(img: Image.Image, dst: str | Path, max_side: int | None = None, quality: int = 88) -> Path:
    img = strip_exif(fit(img, max_side=max_side))
    img.save(str(dst), "WEBP", quality=quality, method=4)
    return Path(dst)


def thumbnail_data_uri(img: Image.Image, side: int = 96) -> str:
    small = strip_exif(fit(img, max_side=side))
    buf = io.BytesIO()
    small.save(buf, "WEBP", quality=70)
    return "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode()


def png_with_recipe(img: Image.Image, dst: str | Path, manifest: dict) -> Path:
    meta = PngImagePlugin.PngInfo()
    meta.add_itxt(RECIPE_KEY, json.dumps(manifest, separators=(",", ":")), zip=True)
    strip_exif(img).save(str(dst), "PNG", pnginfo=meta)
    return Path(dst)


def read_png_recipe(data: bytes | str | Path) -> dict | None:
    try:
        img = Image.open(io.BytesIO(data) if isinstance(data, bytes) else str(data))
    except Exception:
        return None
    raw = (getattr(img, "text", None) or {}).get(RECIPE_KEY) or img.info.get(RECIPE_KEY)
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        return None


def image_payload(path: str | Path, max_pixels: int = 16_000_000, min_side: int = 256, max_b64: int = 20 * 1024 * 1024) -> tuple[str, str]:
    """(data URI, bare base64) for an image, sized into FLUX 3's bounds."""
    img = fit(open_image(path), max_pixels=max_pixels, min_side=min_side)
    img = strip_exif(img)
    quality = 92
    while True:
        buf = io.BytesIO()
        if img.mode == "RGBA":
            img.save(buf, "PNG")
            mime = "image/png"
        else:
            img.save(buf, "JPEG", quality=quality)
            mime = "image/jpeg"
        b = base64.b64encode(buf.getvalue()).decode()
        if len(b) <= max_b64 or quality <= 50:
            return f"data:{mime};base64,{b}", b
        img = img.convert("RGB")
        quality -= 12


def file_data_uri(path: str | Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(Path(path).read_bytes()).decode()


def b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))
