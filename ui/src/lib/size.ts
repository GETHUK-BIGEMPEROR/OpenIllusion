import { useEffect, useState } from "react";
import type { PrepPlan, SizeSpec } from "./api";

/**
 * Live previews of what openillusion/prep.py will do to each image. Same formulas, line for line;
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
  const r = w / h;
  return { width: Math.max(m, pyRound(Math.sqrt(px * px * r) / m) * m), height: Math.max(m, pyRound(Math.sqrt(px * px / r) / m) * m) };
}

export function plan(w: number, h: number, px: number, m: number, crop?: Crop): PrepPlan {
  let [l, t, r, b] = [0, 0, w, h];
  if (crop) {
    const x = Math.min(Math.max(crop[0], 0), 1), y = Math.min(Math.max(crop[1], 0), 1);
    const cw = Math.min(Math.max(crop[2], 0), 1 - x), ch = Math.min(Math.max(crop[3], 0), 1 - y);
    [l, t, r, b] = [x * w, y * h, (x + cw) * w, (y + ch) * h];
  }
  const cw = r - l, ch = b - t;
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
  return { source: [w, h], box: [x, y, x + kw, y + kh], ...out };
}

export const budget = (size: SizeSpec, choice?: unknown) =>
  (size.options.find((o) => o.label === choice) ?? size.options.find((o) => o.label === size.default) ?? size.options[0]).px;

/** Plans for every image of a run; references share the budget (under "Original", the main picture's area). */
export function plans(size: SizeSpec, choice: unknown, images: { slot: string; width: number; height: number; crop?: Crop }[]) {
  const px = budget(size, choice);
  const out: Record<string, PrepPlan> = {};
  const lead = images.find((i) => i.slot === size.follows);
  if (lead) out[lead.slot] = plan(lead.width, lead.height, px, size.multiple, lead.crop);
  const refPx = px || (lead ? pyRound(Math.sqrt(out[lead.slot].width * out[lead.slot].height)) : 0);
  for (const i of images) if (!out[i.slot]) out[i.slot] = plan(i.width, i.height, refPx, size.multiple, i.crop);
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
export function usePrepImages(refs: { url: string; width?: number; height?: number; slot?: number; crop?: Crop; missing?: boolean }[]) {
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
    return d && !r.missing ? [{ slot: `image:${r.slot ?? i + 1}`, ...d, crop: r.crop }] : [];
  });
}
