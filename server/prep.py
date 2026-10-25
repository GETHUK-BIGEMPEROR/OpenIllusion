"""Input prep: crop and size images once, here, before any engine sees them.

The studio decides (a crop rectangle per image, one size for the run); this module
does the pixels. Every engine gets images that already have the size it should
render at, so local workflows never resample them again and cloud engines get the
same pictures the user saw.

A template opts in with a ``size`` block:

    "size": {
      "options": [{"label": "1K", "px": 1024}, {"label": "Original", "px": 0}],
      "default": "1K",
      "multiple": 32,          # both sides end on a multiple of this
      "follows": "image:1"     # the image whose shape sets the output
    }

``px`` is a pixel budget: about px x px pixels at the image's own shape. 0 keeps
the image's own size, trimmed to the multiple. Other images get the same budget
at their own shape, so a 16 MP product photo can't run the GPU out of memory.

``ui/src/lib/size.ts`` mirrors ``target`` and ``plan`` for live previews; compose
returns this module's plans, which the studio shows once they arrive.
"""

from __future__ import annotations

import math
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

    def to_dict(self) -> dict:
        return {"source": list(self.source), "box": [round(v, 2) for v in self.box], "width": self.width, "height": self.height}


def spec_of(size: dict | None) -> dict | None:
    """A template's size block with defaults filled in, or None when it has none."""
    if not size or not size.get("options"):
        return None
    opts = [{"label": str(o["label"]), "px": int(o.get("px", 0))} for o in size["options"]]
    labels = [o["label"] for o in opts]
    default = size.get("default") if size.get("default") in labels else labels[0]
    return {"options": opts, "default": default, "multiple": int(size.get("multiple") or DEFAULT_MULTIPLE),
            "follows": size.get("follows") or "image:1"}


def budget(size: dict, choice: str | None) -> int:
    """The pixel budget for the chosen option (its label); unknown choices fall back to the default."""
    by = {o["label"]: o["px"] for o in size["options"]}
    return by.get(str(choice), by[size["default"]]) if choice is not None else by[size["default"]]


def _round_mult(v: float, m: int) -> int:
    return max(m, round(v / m) * m)


def target(w: float, h: float, px: int, multiple: int) -> tuple[int, int]:
    """Output size for a w x h picture: about px x px pixels at its shape, both sides on the multiple.
    px 0 keeps its own size, trimmed down to the multiple so nothing is resampled."""
    if px <= 0:
        return max(multiple, math.floor(w / multiple) * multiple), max(multiple, math.floor(h / multiple) * multiple)
    r = w / h
    return _round_mult(math.sqrt(px * px * r), multiple), _round_mult(math.sqrt(px * px / r), multiple)


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


def plan(w: int, h: int, *, px: int, multiple: int, crop: list | tuple | None = None) -> Plan:
    """What happens to one picture: the part of it kept, and the size it ends at.

    The kept part is the crop, trimmed evenly on its long side to the output's exact
    shape (rounding to the multiple shifts the shape by a few pixels; this never stretches).
    """
    l, t, r, b = _crop_box(w, h, crop)
    cw, ch = r - l, b - t
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
    box = (l, t, l + kw, t + kh)
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


def plans(size: dict, choice: str | None, images: list[dict]) -> dict[str, Plan]:
    """Plans for every image of a run. ``images``: [{slot, width, height, crop?}].

    The followed image takes the chosen budget. Under "Original" (px 0) the others
    take a budget equal to its area, so a reference is never bigger than the picture.
    """
    px = budget(size, choice)
    m = size["multiple"]
    out: dict[str, Plan] = {}
    lead = next((i for i in images if i["slot"] == size["follows"]), None)
    if lead:
        out[lead["slot"]] = plan(lead["width"], lead["height"], px=px, multiple=m, crop=lead.get("crop"))
    ref_px = px or (round(math.sqrt(out[lead["slot"]].width * out[lead["slot"]].height)) if lead else 0)
    for i in images:
        if i["slot"] in out:
            continue
        out[i["slot"]] = plan(i["width"], i["height"], px=ref_px, multiple=m, crop=i.get("crop"))
    return out
