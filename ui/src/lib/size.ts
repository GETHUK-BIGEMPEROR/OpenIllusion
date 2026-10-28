import { useEffect, useState } from "react";
import type { PrepPlan, SizeSpec } from "./api";

/**
 * Live previews of what server/prep.py will do to each image. Same formulas, line for line;
 * the server's plans (from compose) replace these once they arrive.
 */

export interface Dims { width: number; height: number }
export type Crop = [number, number, number, number];

/** Python's round(): halves go to the even neighbour. */
const pyRound = (x: number) => {
  const f = Math.floor(x);
  const d = x - f;
  return d > 0.5 ? f + 1 : d < 0.5 ? f : f % 2 === 0 ? f : f + 1;
};

/** About px x px pixels at the picture's shape, both sides on the multiple. px 0: its own size, trimmed down to the multiple. */
export function target(w: number, h: number, px: number, m: number): Dims {
  if (px <= 0) return { width: Math.max(m, Math.floor(w / m) * m), height: Math.max(m, Math.floor(h / m) * m) };
  const round = (v: number) => Math.max(m, pyRound(v / m) * m);
  const r = w / h;
  const flip = r < 1;
  const q = flip ? 1 / r : r;
  const base = round(Math.sqrt((px * px) / q));
  let best: [number, number] | null = null;
  let score = Infinity;
  for (let k = -4; k <= 4; k++) {
    const short = base + k * m;
    if (short < m) continue;
    const long = round(short * q);
    const area = Math.abs((short * long) / (px * px) - 1);
    if (area > 0.12) continue;
    const s = Math.abs(Math.log(long / short / q)) + 0.1 * area;
    if (s < score) { best = [long, short]; score = s; }
  }
  if (!best) return { width: round(Math.sqrt(px * px * r)), height: round(Math.sqrt((px * px) / r)) };
  return flip ? { width: best[1], height: best[0] } : { width: best[0], height: best[1] };
}

/** cap: no bigger than about cap x cap pixels; Original over it is scaled down to it. */
export function plan(w: number, h: number, px: number, m: number, crop?: Crop, cap = 0): PrepPlan {
  let [l, t, r, b] = [0, 0, w, h];
  if (crop) {
    const x = Math.min(Math.max(crop[0], 0), 1), y = Math.min(Math.max(crop[1], 0), 1);
    const cw = Math.min(Math.max(crop[2], 0), 1 - x), ch = Math.min(Math.max(crop[3], 0), 1 - y);
    [l, t, r, b] = [x * w, y * h, (x + cw) * w, (y + ch) * h];
  }
  const cw = r - l, ch = b - t;
  if (cap && (px > cap || (px <= 0 && cw * ch > cap * cap))) px = cap;
  const out = target(cw, ch, px, m);
  if (!crop && w % m === 0 && h % m === 0 && Math.abs(out.width - w) <= m && Math.abs(out.height - h) <= m) {
    return { source: [w, h], box: [0, 0, w, h], width: w, height: h };
  }
  if (px <= 0) {
    const x = Math.min(Math.max(pyRound(l + (cw - out.width) / 2), 0), w - out.width);
    const y = Math.min(Math.max(pyRound(t + (ch - out.height) / 2), 0), h - out.height);
    return { source: [w, h], box: [x, y, x + out.width, y + out.height], ...out };
  }
  const scale = Math.max(out.width / cw, out.height / ch);
  const kw = out.width / scale, kh = out.height / scale;
  const x = l + (cw - kw) / 2, y = t + (ch - kh) / 2;
  return { source: [w, h], box: [Math.max(0, x), Math.max(0, y), Math.min(w, x + kw), Math.min(h, y + kh)], ...out };
}

/** An input as prep sees it: its pixel size, and the shape and size chosen for it. */
export interface PrepInput { slot: string; width: number; height: number; crop?: Crop; size?: string }

/** The size an input runs at: its own choice when it names an option, else the template's default for it. */
export const choiceOf = (size: SizeSpec, slot: string, choice?: unknown) =>
  size.options.some((o) => o.label === choice) ? String(choice) : size.inputs[slot] ?? size.original;

export const budget = (size: SizeSpec, choice?: unknown) => size.options.find((o) => o.label === choice)?.px ?? 0;

const ratioOf = (aspect: string) => { const [w, h] = aspect.split(":").map(Number); return w > 0 && h > 0 ? [w, h] : null; };

/** Templates without inputs: the canvas for a shape and a size, as server/prep.py canvas_size makes it. */
export function canvasSize(size: SizeSpec, aspect?: unknown, choice?: unknown): Dims | null {
  const c = size.canvas;
  if (!c) return null;
  const shape = c.aspects.includes(String(aspect)) ? String(aspect) : c.aspect;
  if (c.steps) return fitDims(c, shape, choice);
  const [w, h] = ratioOf(shape) ?? [1, 1];
  return target(w, h, budget(size, choice) || budget(size, c.size), size.multiple);
}

/** The steps an output size offers: a cloud model's own megapixels, else the template's steps (Original left out). */
export const canvasSteps = (size: SizeSpec): string[] =>
  size.canvas?.steps ? size.canvas.steps.map((x) => `${x} MP`) : size.options.filter((o) => o.px).map((o) => o.label);

/** A cloud model's size in pixels, as server/prep.py fit_dims makes it: the shape at the step's megapixels
 *  (1 MP = 1024²), on the multiple, inside the model's sides and pixel range. */
function fitDims(c: NonNullable<SizeSpec["canvas"]>, aspect: string, choice?: unknown): Dims {
  const [w, h] = ratioOf(aspect) ?? [1, 1];
  const steps = c.steps ?? [1];
  const mp = steps.find((x) => `${x} MP` === String(choice)) ?? steps.find((x) => `${x} MP` === c.size) ?? steps[0];
  const [loPx, hiPx] = c.pixels ?? [0, Infinity];
  const px = Math.min(Math.max(mp * 1024 * 1024, loPx), hiPx);
  const k = Math.sqrt(px / (w * h));
  let W = w * k, H = h * k;
  const [lo, hi] = c.sides ?? [0, Infinity];
  let f = Math.min(1, hi / Math.max(W, H));
  W *= f; H *= f;
  f = Math.max(1, lo / Math.min(W, H));
  W *= f; H *= f;
  const m = c.multiple ?? 16;
  W = Math.max(m, pyRound(W / m) * m); H = Math.max(m, pyRound(H / m) * m);
  while (W > hi || W * H > hiPx) W -= m;
  while (H > hi || W * H > hiPx) H -= m;
  return { width: W, height: H };
}

/** Plans for every input of a run, each at its own size. */
export function plans(size: SizeSpec, inputs: PrepInput[]) {
  const out: Record<string, PrepPlan> = {};
  for (const i of inputs) out[i.slot] = plan(i.width, i.height, budget(size, choiceOf(size, i.slot, i.size)), size.multiple, i.crop, size.cap ?? 0);
  return out;
}

const NAMED = [[1, 1], [5, 4], [4, 5], [4, 3], [3, 4], [3, 2], [2, 3], [16, 9], [9, 16], [21, 9], [9, 21], [2, 1], [1, 2]] as const;

/** "4:3" when the shape is within 1.5% of a common one, else "1.62:1". */
export function aspectName({ width, height }: Dims) {
  const r = width / height;
  const hit = NAMED.find(([a, b]) => Math.abs(r / (a / b) - 1) < 0.015);
  if (hit) return `${hit[0]}:${hit[1]}`;
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`;
}

export const megapixels = ({ width, height }: Dims) => (width * height) / 1e6;

export const dimsText = ({ width, height }: Dims) => `${width}×${height}`;

/** What to tell people about rendering this picture at this size. Never blocking. */
export function sizeNotes(p: PrepPlan): string[] {
  const notes: string[] = [];
  const [l, t, r, b] = p.box;
  const kept = { width: r - l, height: b - t };
  const ratio = kept.width / kept.height;
  if (Math.max(ratio, 1 / ratio) > 2.5) notes.push(`Very ${ratio > 1 ? "wide" : "tall"} picture. Edits hold up better closer to 16:9; crop it.`);
  if (p.width * p.height > kept.width * kept.height * 1.4) notes.push(`Upscaled from ${Math.round(kept.width)}×${Math.round(kept.height)}, so detail may look soft. Pick a smaller size or a bigger photo.`);
  if (megapixels(p) > 4.3) notes.push("Over 4 MP: slow, and may run out of GPU memory.");
  return notes;
}

/** A run's images with their pixel sizes and crops, as prep sees them. Sizes the upload didn't record are read from the files. */
export function usePrepImages(refs: { url: string; width?: number; height?: number; slot?: number; crop?: Crop; size?: string; missing?: boolean }[]) {
  const [read, setRead] = useState<Record<string, Dims>>({});
  const unknown = refs.filter((r) => r.url && !(r.width && r.height) && !read[r.url]).map((r) => r.url);
  useEffect(() => {
    let live = true;
    for (const url of unknown) {
      const img = new Image();
      img.onload = () => { if (live && img.naturalWidth) setRead((m) => ({ ...m, [url]: { width: img.naturalWidth, height: img.naturalHeight } })); };
      img.src = url;
    }
    return () => { live = false; };
  }, [unknown.join("|")]);
  return refs.flatMap((r, i) => {
    const d = r.width && r.height ? { width: r.width, height: r.height } : read[r.url];
    return d && !r.missing ? [{ slot: `image:${r.slot ?? i + 1}`, ...d, crop: r.crop, size: r.size }] : [];
  });
}

/** Shapes the studio offers on top of the input's own. */
export const SHAPES = [["Own", 0], ["9:16", 9 / 16], ["16:9", 16 / 9], ["1:1", 1], ["4:5", 4 / 5]] as const;

/** The largest centred crop of a w x h picture at shape r (width / height), as fractions [x, y, w, h]. */
export function shapeCrop(w: number, h: number, r: number): Crop {
  if (w / h > r) { const cw = (h * r) / w; return [(1 - cw) / 2, 0, cw, 1]; }
  const ch = w / r / h;
  return [0, (1 - ch) / 2, 1, ch];
}

/** Which of SHAPES a crop gives ("Own" when there is none). */
export function shapeOf(w: number, h: number, crop?: Crop): string {
  if (!crop) return "Own";
  const r = (crop[2] * w) / (crop[3] * h);
  return SHAPES.find(([, x]) => x && Math.abs(r / x - 1) < 0.01)?.[0] ?? "Custom";
}
