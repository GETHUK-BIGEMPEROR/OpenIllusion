"""Fitting inputs to what a model takes: sides, shape, file size, clip and sound length, frame rate.

Every Router model publishes what each input may be (Kling's photos at least 300 px a side
and no wider than 5:2, its clips 3 to 10 s at 24 to 60 fps, Gemini's whole request under
20 MB...). An adapter input says so in ``fit``; a run then makes every file fit, here and in
staging, rather than letting the provider refuse it:

    "fit": {"short": [300, null], "long": [null, 2160], "pixels": [null, 36000000],
            "aspect": [0.4, 2.5], "mb": 10, "seconds": [3, 10], "total": 15, "fps": [24, 60]}

- ``short`` / ``long``: the shorter and longer side in pixels, [least, most]. Too small is
  scaled up, too big scaled down, keeping the shape.
- ``pixels``: width × height, [least, most].
- ``aspect``: width / height, [least, most]. Outside it the middle is cropped to the nearest end.
- ``mb``: one file's size in MB (10⁶ bytes). Photos are re-encoded, clips and sounds get the bitrate that fits.
- ``seconds``: a clip's or sound's length, [least, most]. Longer runs only its first ``most``
  seconds from where its trim starts; shorter can't run (nothing is made up).
- ``total``: seconds across every file of the input (Wan's reference clips: 15 s in all).
  Later files are cut to what's left.
- ``fps``: frame rates, [least, most]; a clip outside is resampled.

An end that's ``null`` (or left out) is open. The adapter's top-level ``media_mb`` is how
many MB of files one request may carry inline (Gemini: 20); Router's own cap is the default.
A local or hand-written cloud template can put the same ``fit`` on a photo, clip or sound input.
"""

from __future__ import annotations

import math
from typing import Any

from . import adapters, prep

RANGES = ("short", "long", "pixels", "aspect", "seconds", "fps")
NUMBERS = ("mb", "total")
MB = 1_000_000

# Router takes 100 MiB a request; base64 grows files by 4/3 and the rest of the body needs room.
ROUTER_MEDIA = int(100 * 1024 * 1024 * 0.74)


def check(fit: Any, what: str) -> dict:
    """A ``fit`` block, checked: known keys, ranges of two numbers (or null) with the least first."""
    if not isinstance(fit, dict) or set(fit) - set(RANGES) - set(NUMBERS):
        raise ValueError(f"{what}: fit takes " + ", ".join(RANGES + NUMBERS))
    out: dict[str, Any] = {}
    for k in RANGES:
        if k not in fit:
            continue
        v = fit[k]
        if not (isinstance(v, list) and len(v) == 2 and all(x is None or _num(x) and x > 0 for x in v) and any(x is not None for x in v)):
            raise ValueError(f"{what}: fit.{k} is [least, most], numbers above 0 or null")
        if None not in v and v[0] > v[1]:
            raise ValueError(f"{what}: fit.{k} has its least first")
        out[k] = [None if x is None else float(x) for x in v]
    for k in NUMBERS:
        if k in fit:
            if not (_num(fit[k]) and fit[k] > 0):
                raise ValueError(f"{what}: fit.{k} is a number above 0")
            out[k] = float(fit[k])
    return out


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def lo(fit: dict, k: str) -> float | None:
    return (fit.get(k) or [None, None])[0]


def hi(fit: dict, k: str) -> float | None:
    return (fit.get(k) or [None, None])[1]


# ---- where a template input's fit comes from ---------------------------------------


def _at(body: Any, path: list) -> Any:
    for k in path:
        try:
            body = body[k]
        except (KeyError, IndexError, TypeError):
            return None
    return body


def source(e: Any, f: dict) -> tuple[dict, str] | None:
    """The fit for one of a template's media inputs, and what it groups by for ``total``:
    the input's own ``fit``, else the Router adapter input its request puts the file in.
    Found from the request itself, so templates built before an adapter gained a limit get it too."""
    if f.get("fit"):
        return f["fit"], f["key"]
    hit = adapter_input(e, f)
    return (hit[1]["fit"], f"role:{hit[0]}") if hit and hit[1].get("fit") else None


def adapter_input(e: Any, f: dict) -> tuple[int, dict] | None:
    """The Router adapter input (its index and entry) a template's media input fills, found from where its
    request puts the file. Two roles can put a file in the same place (Seedance's Reference video and Video to
    edit); then it's the one whose ``with`` the request carries."""
    if e.kind == "local" or not e.model or not e.body or not f.get("bind"):
        return None
    a = adapters.for_model(e.model)
    if a is None:
        return None
    here = _at(e.body, list(f["bind"][0]))
    hits = [(n, i) for n, i in enumerate(a.inputs) if i["type"] == f["type"] and adapters.fill(i["value"], f["key"]) == here]
    carried = [h for h in hits if h[1].get("with") and all(_at(e.body, list(p)) == v for p, v in h[1]["with"])]
    return (carried or hits or [None])[0]


def role(e: Any, slot: str) -> str | None:
    """The adapter role a media input fills ("First frame", "Reference image"...), or None when not known."""
    f = next((f for f in e.fields if f["key"] == slot), None)
    hit = adapter_input(e, f) if f else None
    return hit[1]["role"] if hit else None


def of(e: Any, slot: str) -> dict:
    """A media input's fit, or {} when nothing is known about the model's limits."""
    f = next((f for f in e.fields if f["key"] == slot), None)
    s = source(e, f) if f else None
    return s[0] if s else {}


def media_budget(e: Any) -> int:
    """Bytes of files one request of this template may carry inline."""
    a = adapters.for_model(e.model) if e.kind != "local" and e.model else None
    mb = a.media_mb if a is not None else None
    return min(ROUTER_MEDIA, int(mb * MB)) if mb else ROUTER_MEDIA


# ---- photos and clips: shape and size ------------------------------------------------------


def ratio_text(r: float) -> str:
    """2.5 → "5:2", 0.125 → "1:8"."""
    for d in range(1, 17):
        n = r * d
        if abs(n - round(n)) < 1e-3 and round(n) > 0:
            return f"{round(n)}:{d}"
    return f"{r:.2f}:1"


def plan(p: prep.Plan, fit: dict, even: bool = False) -> tuple[prep.Plan, list[str]]:
    """``p`` changed as little as it takes to fit: the middle cropped to the shape allowed, then
    scaled so every side and the pixel count are in range. ``even``: both sides even (video)."""
    if not fit:
        return p, []
    notes: list[str] = []
    l, t, r, b = p.box
    w, h = float(p.width), float(p.height)
    a_lo, a_hi = lo(fit, "aspect"), hi(fit, "aspect")
    if a_hi and w / h > a_hi * 1.002:
        keep = h * a_hi / w  # the share of the width kept
        c, half = (l + r) / 2, (r - l) * keep / 2
        l, r, w = c - half, c + half, h * a_hi
        notes.append(f"cropped to {ratio_text(a_hi)}")
    elif a_lo and w / h < a_lo * 0.998:
        keep = w / a_lo / h
        c, half = (t + b) / 2, (b - t) * keep / 2
        t, b, h = c - half, c + half, w / a_lo
        notes.append(f"cropped to {ratio_text(a_lo)}")

    short, long = min(w, h), max(w, h)
    up = max([1.0] + [v / s for v, s in ((lo(fit, "short"), short), (lo(fit, "long"), long)) if v]
             + ([math.sqrt(lo(fit, "pixels") / (w * h))] if lo(fit, "pixels") else []))
    down = min([math.inf] + [v / s for v, s in ((hi(fit, "short"), short), (hi(fit, "long"), long)) if v]
               + ([math.sqrt(hi(fit, "pixels") / (w * h))] if hi(fit, "pixels") else []))
    s = min(up, down)
    step = 2 if even else 1
    if s > 1.0005:
        W, H = (math.ceil(w * s / step) * step, math.ceil(h * s / step) * step)
        notes.append(f"scaled up to {W}×{H}")
    elif s < 0.9995:
        W, H = (max(step, math.floor(w * s / step) * step), max(step, math.floor(h * s / step) * step))
        notes.append(f"scaled down to {W}×{H}")
    else:
        W, H = (max(step, round(w / step) * step), max(step, round(h / step) * step))
    if not notes:
        return p, []
    box = (max(0.0, l), max(0.0, t), min(float(p.source[0]), r), min(float(p.source[1]), b))
    if all(abs(v - round(v)) < 1e-6 for v in box):
        box = tuple(float(round(v)) for v in box)
    return prep.Plan(source=p.source, box=box, width=int(W), height=int(H)), notes  # type: ignore[arg-type]


# ---- clips and sounds: length ---------------------------------------------------------------


def span(duration: float, trim: list | tuple | None, window: tuple[float | None, float | None] | None,
         left: float | None = None) -> tuple[float, float, str | None, str | None]:
    """The part of a clip or sound a run sends: (start, end, note, error).

    It starts where its trim starts and runs to the trim's end, cut to the most the model
    takes (and to ``left``, what a ``total`` leaves). Too short is an error: nothing is made up."""
    t0 = float((trim or [0, 0])[0] or 0)
    t1 = float((trim or [0, 0])[1] or 0) or duration
    t1 = min(t1, duration) if duration else t1
    least, most = window or (None, None)
    cut = min([v for v in (most, left) if v is not None], default=None)
    note = None
    if cut is not None and t1 - t0 > cut + 0.05:
        t1 = t0 + cut
        note = f"runs {cut:g} s of it" + (f" ({t0:g}–{t1:g} s)" if t0 else "")
    if least and t1 - t0 < least - 0.05:
        if left is not None and left < least:
            return t0, t1, note, f"no time left: the files before it use up the {least:g} s it needs"
        return t0, t1, note, f"is {t1 - t0:.1f} s; it needs at least {least:g} s"
    return t0, t1, note, None
