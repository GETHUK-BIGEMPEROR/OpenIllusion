import type { Box } from "./api";

// Mirrors server/engines.py box_rows: fractions → FLUX 3 [ymin, xmin, ymax, xmax] in 0..1000.
const q = (v: number) => Math.max(0, Math.min(1000, Math.round(v * 1000)));

export function engineBoxes(boxes: Box[]): string {
  const rows = boxes
    .filter((b) => b.label.trim())
    .map((b, i) => {
      const [x, y, w, h] = b.rect;
      const bb = [q(y), q(x), q(y + h), q(x + w)];
      return { id: `box_${i + 1}`, from: b.from ?? "image_1", src_bbox: bb, tgt_bbox: bb, desc: b.label.trim() };
    });
  return rows.length ? JSON.stringify(rows, null, 0).replace(/},{/g, "},\n{") : "";
}
