"""Input prep: crop and size photos and clips once, here, before any engine sees them.

Every photo and clip a template takes has the same attributes: a shape (a crop
rectangle, or none) and a size. The studio decides them per input; this module does
the pixels. Engines get inputs already at the size they should render at, so local
workflows never resample them again and cloud engines get what the user saw. A clip
is planned like a photo from its frame size, and every frame gets the same crop and
resample (media.transcode).

Size is a pixel budget in megapixels at the input's own shape. Every template offers
the same steps, chosen by what it makes: photos up to 3 MP, videos up to 1.5 MP. That
cap holds for every input, Original included (an input over it is scaled down to it).
The uncap setting (``uncap_size``) adds bigger steps and lets Original run at full size;
``limit`` applies it. "Original" keeps the input's own size, trimmed to the multiple,
and is every input's default unless the template names another step for it:

    "size": {"multiple": 32},                      # both sides end on a multiple of this
    "inputs": [{"key": "image:1", "type": "image", "label": "Person", "size": "1 MP"}]

That is input prep, and all of it. What the workflow makes of a prepared input is its own
business: the app writes an output size into a graph only when the template declares one,
with a ``size`` input bound to the width and height it sets:

    {"key": "size", "type": "size", "label": "Output size", "aspect": "4:5", "default": "1 MP",
     "bind": [["5", "width", "width"], ["5", "height", "height"]]}   # optional "aspects": [...]

The studio then offers a shape and a step (same steps, same cap), and ``canvas_size`` turns
them into the width and height written.

``ui/src/lib/size.ts`` mirrors ``target``, ``plan`` and ``plans`` for live previews;
compose returns this module's plans, which the studio shows once they arrive.
"""

from __future__ import annotations

import math
import re
from typing import Any
from dataclasses import dataclass

from PIL import Image

DEFAULT_MULTIPLE = 16


@dataclass(frozen=True)
class Plan:
    source: tuple[int, int]  # the image as uploaded, upright
    box: tuple[float, float, float, float]  # left, top, right, bottom in source pixels
    width: int
    height: int

    @property
    def identity(self) -> bool:
        return self.box == (0, 0, *self.source) and (self.width, self.height) == self.source

    @property
    def trim_only(self) -> bool:
        """Cut on whole pixels with no resample (Original with a crop, or a trim to the multiple)."""
        l, t, r, b = self.box
        return not self.identity and (r - l, b - t) == (self.width, self.height) and all(v == int(v) for v in self.box)

    def to_dict(self) -> dict:
        return {"source": list(self.source), "box": [round(v, 2) for v in self.box], "width": self.width, "height": self.height}


ORIGINAL = "Original"
# The steps every template offers, by what it makes, and the cap on any input of it (megapixels).
STEPS = {"edit": (0.5, 1, 2, 3), "motion": (0.4, 0.75, 1, 1.5)}
OVER = {"edit": (4, 6), "motion": (2, 3)}  # offered only when the cap is lifted
CAP = {"edit": 3, "motion": 1.5}
ASPECTS = ("1:1", "4:5", "3:4", "2:3", "9:16", "16:9", "3:2", "4:3")


def _option(mp: float) -> dict:
    return {"label": f"{mp:g} MP", "px": round(math.sqrt(mp * 1e6)), "mp": mp}


def spec_of(size: dict | None, inputs: list[dict] | None = None, mode: str = "edit", out: dict | None = None) -> dict:
    """A template's size block with defaults filled in: the steps for what it makes (Original
    last), the cap, the multiple and each input's default size. ``out``: the template's ``size``
    input, when it declares one; ``canvas`` then holds the shapes offered and the default shape and step."""
    size = size or {}
    mode = mode if mode in STEPS else "edit"
    steps = [_option(mp) for mp in STEPS[mode]]
    opts = steps + [{"label": ORIGINAL, "px": 0, "mp": 0}]
    labels = [o["label"] for o in opts]
    defaults = {i["slot"]: i["size"] if i.get("size") in labels else ORIGINAL
                for i in inputs or [] if str(i.get("slot", "")).startswith(("image:", "video:"))}
    spec = {"options": opts, "more": [_option(mp) for mp in OVER[mode]], "cap": _option(CAP[mode])["px"],
            "multiple": int(size.get("multiple") or DEFAULT_MULTIPLE), "inputs": defaults, "original": ORIGINAL}
    if out is not None:
        aspects = [a for a in out.get("aspects") or ASPECTS if _ratio(a)]
        # A cloud model's size names its own steps (megapixels) and limits; a workflow's uses the steps above.
        named = [f"{x:g} MP" for x in out["steps"]] if out.get("steps") else [o["label"] for o in steps]
        spec["canvas"] = {"aspects": aspects, "aspect": out.get("aspect") if out.get("aspect") in aspects else aspects[0],
                          "size": out.get("default") if out.get("default") in named else named[min(1, len(named) - 1)]}
        if out.get("steps"):
            spec["canvas"].update(steps=list(out["steps"]), multiple=int(out.get("multiple") or DEFAULT_MULTIPLE),
                                  **{k: out[k] for k in ("sides", "pixels") if out.get(k)})
    return spec


def limit(size: dict, uncapped: bool) -> dict:
    """The spec as runs see it: capped, or with the bigger steps offered and no cap."""
    if not uncapped:
        return size
    n = sum(1 for o in size["options"] if o["px"])  # the steps, before Original
    return {**size, "options": size["options"][:n] + size.get("more", []) + size["options"][n:], "more": [], "cap": 0}


def _ratio(aspect: str) -> tuple[float, float] | None:
    try:
        w, h = (float(v) for v in str(aspect).split(":"))
        return (w, h) if w > 0 and h > 0 else None
    except ValueError:
        return None


def shape(aspect: Any) -> tuple[float, float] | None:
    """``16:9`` (or ``1536x1024``, ``1280*720``) as (16, 9); None for ``auto`` and the like."""
    m = re.fullmatch(r"(\d+(?:\.\d+)?)[:x*](\d+(?:\.\d+)?)", str(aspect))
    return (float(m[1]), float(m[2])) if m and float(m[1]) > 0 and float(m[2]) > 0 else None


def fit_dims(s: dict, aspect: Any, step: Any) -> tuple[int, int]:
    """Pixels for a cloud model's size (an adapter's size setting, or a template's size input
    built from one): the shape at the step's megapixels, on the multiple, inside the model's
    sides and pixel range. ``s``: aspect, default, steps (megapixels), sides, pixels, multiple."""
    w, h = shape(aspect) or shape(s.get("aspect")) or (1.0, 1.0)
    steps = {f"{x:g} MP": x for x in s["steps"]}
    mp = steps.get(str(step)) or steps.get(str(s.get("default"))) or next(iter(steps.values()))
    px = mp * 1024 * 1024  # 1 MP is 1024 × 1024, the size models are trained around
    lo_px, hi_px = s.get("pixels") or (0, float("inf"))
    px = min(max(px, lo_px), hi_px)
    k = (px / (w * h)) ** 0.5
    W, H = w * k, h * k
    lo, hi = s.get("sides") or (0, float("inf"))
    f = min(1.0, hi / max(W, H))
    W, H = W * f, H * f
    f = max(1.0, lo / min(W, H))
    W, H = W * f, H * f
    m = int(s.get("multiple") or 16)
    W, H = max(m, round(W / m) * m), max(m, round(H / m) * m)
    # Rounding may pass a most: step down by the multiple until inside.
    while W > hi or W * H > hi_px:
        W -= m
    while H > hi or W * H > hi_px:
        H -= m
    return int(W), int(H)


def canvas_size(size: dict, aspect: str | None, choice: str | None) -> tuple[int, int] | None:
    """Width and height for a template's declared output size: the picked shape at the picked
    step (the template's defaults when either isn't offered)."""
    c = size.get("canvas")
    if not c:
        return None
    if c.get("steps"):  # a cloud model's size
        return fit_dims({**c, "default": c["size"]}, aspect if aspect in c["aspects"] else c["aspect"], choice)
    w, h = _ratio(aspect if aspect in c["aspects"] else c["aspect"])  # type: ignore[misc]
    px = budget(size, choice) or budget(size, c["size"])
    return target(w, h, px, size["multiple"])


def choice_of(size: dict, slot: str, choice: str | None = None) -> str:
    """The size an input runs at: its own choice when it names an option, else the template's default for it."""
    labels = {o["label"] for o in size["options"]}
    return choice if choice in labels else size["inputs"].get(slot, size["original"])


def budget(size: dict, choice: str | None) -> int:
    """The pixel budget for an option (its label); unknown labels mean Original."""
    return next((o["px"] for o in size["options"] if o["label"] == choice), 0)


def _round_mult(v: float, m: int) -> int:
    return max(m, round(v / m) * m)


def target(w: float, h: float, px: int, multiple: int) -> tuple[int, int]:
    """Output size for a w x h picture: about px x px pixels at its shape, both sides on the multiple.
    px 0 keeps its own size, trimmed down to the multiple so nothing is resampled.

    Rounding each side on its own can bend the shape by 3% (16:9 at 1 MP would be 1344x736).
    So a few short sides near the budget are tried, each with the long side that fits it best,
    and the pair truest to the shape wins, as long as it stays within 12% of the budget.
    """
    if px <= 0:
        return max(multiple, math.floor(w / multiple) * multiple), max(multiple, math.floor(h / multiple) * multiple)
    r = w / h
    flip = r < 1
    q = 1 / r if flip else r  # long side / short side
    base = _round_mult(math.sqrt(px * px / q), multiple)
    best, score = None, math.inf
    for k in range(-4, 5):
        short = base + k * multiple
        if short < multiple:
            continue
        long = _round_mult(short * q, multiple)
        area = abs(short * long / (px * px) - 1)
        if area > 0.12:
            continue
        s = abs(math.log(long / short / q)) + 0.1 * area
        if s < score:
            best, score = (long, short), s
    if best is None:
        return _round_mult(math.sqrt(px * px * r), multiple), _round_mult(math.sqrt(px * px / r), multiple)
    return (best[1], best[0]) if flip else best


def _crop_box(w: int, h: int, crop: list | tuple | None) -> tuple[float, float, float, float]:
    """A crop as fractions [x, y, w, h] of the picture → a box in pixels, clamped inside it."""
    if not crop:
        return 0.0, 0.0, float(w), float(h)
    x, y, cw, ch = (float(v) for v in crop)
    x, y = min(max(x, 0.0), 1.0), min(max(y, 0.0), 1.0)
    cw, ch = min(max(cw, 0.0), 1.0 - x), min(max(ch, 0.0), 1.0 - y)
    if cw * w < 8 or ch * h < 8:
        raise ValueError("crop is too small")
    return x * w, y * h, (x + cw) * w, (y + ch) * h


def plan(w: int, h: int, *, px: int, multiple: int, crop: list | tuple | None = None, cap: int = 0) -> Plan:
    """What happens to one picture: the part of it kept, and the size it ends at.
    ``cap``: no bigger than about cap x cap pixels; Original over it is scaled down to it.

    The kept part is the crop, trimmed evenly on its long side to the output's exact
    shape (rounding to the multiple shifts the shape by a few pixels; this never stretches).
    """
    l, t, r, b = _crop_box(w, h, crop)
    cw, ch = r - l, b - t
    if cap and (px > cap or (px <= 0 and cw * ch > cap * cap)):
        px = cap
    out_w, out_h = target(cw, ch, px, multiple)
    if not crop and w % multiple == 0 and h % multiple == 0 and abs(out_w - w) <= multiple and abs(out_h - h) <= multiple:
        # Already prepared (a rerun, a remix): rounding its shape again could move a side by one step.
        return Plan(source=(w, h), box=(0.0, 0.0, float(w), float(h)), width=w, height=h)
    if px <= 0:  # own size: a centred trim on whole pixels, no resampling
        x, y = round(l + (cw - out_w) / 2), round(t + (ch - out_h) / 2)
        x, y = min(max(x, 0), w - out_w), min(max(y, 0), h - out_h)
        return Plan(source=(w, h), box=(float(x), float(y), float(x + out_w), float(y + out_h)), width=out_w, height=out_h)
    scale = max(out_w / cw, out_h / ch)
    kw, kh = out_w / scale, out_h / scale
    l, t = l + (cw - kw) / 2, t + (ch - kh) / 2
    box = (max(0.0, l), max(0.0, t), min(float(w), l + kw), min(float(h), t + kh))  # float error can step a hair outside
    if all(abs(v - round(v)) < 1e-6 for v in box):
        box = tuple(float(round(v)) for v in box)
    return Plan(source=(w, h), box=box, width=out_w, height=out_h)  # type: ignore[arg-type]


def apply(img: Image.Image, p: Plan) -> Image.Image:
    """One crop and at most one Lanczos resample. Same input and plan, same pixels."""
    if p.identity:
        return img
    l, t, r, b = p.box
    if (r - l, b - t) == (p.width, p.height) and all(v == int(v) for v in p.box):
        return img.crop((int(l), int(t), int(r), int(b)))
    return img.resize((p.width, p.height), Image.LANCZOS, box=p.box)


def plans(size: dict, inputs: list[dict]) -> dict[str, Plan]:
    """Plans for every input of a run, photos and clips alike, each at its own size.
    ``inputs``: [{slot, width, height, crop?, size?}]."""
    out: dict[str, Plan] = {}
    for i in inputs:
        px = budget(size, choice_of(size, i["slot"], i.get("size")))
        out[i["slot"]] = plan(i["width"], i["height"], px=px, multiple=size["multiple"], crop=i.get("crop"), cap=size.get("cap", 0))
    return out
