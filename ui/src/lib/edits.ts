// What an edit does to a photo, clip or sound, and how the result meets a model's limits. Pure: the editor, Create's
// file cards and the Builder's cards all read it. Files only change on the server (server/edit.py).
import type { Fit, MediaOps, Range } from "./api";
import type { Crop } from "./size";

export type Rot = 0 | 90 | 180 | 270;
export type Tool = "crop" | "turn" | "size" | "cut" | "rate" | "sound";

/** The editor's state for one file. trim null: the whole length. width null: the crop's own pixels. */
export interface Edits {
  rotate: Rot; fh: boolean; fv: boolean;
  crop: Crop | null; ratio: number | null; width: number | null;
  trim: [number, number] | null; fps: number | null; mute: boolean;
}

/** What the edit logic needs to know about a file. */
export interface MediaLike { kind: "image" | "video" | "audio"; width?: number; height?: number; duration?: number; fps?: number; has_audio?: boolean }

export const NO_EDITS: Edits = { rotate: 0, fh: false, fv: false, crop: null, ratio: null, width: null, trim: null, fps: null, mute: false };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A trim that keeps the whole file is no trim. */
export function cutOf(e: Edits, m: MediaLike): [number, number] | null {
  const d = m.duration ?? 0;
  if (m.kind === "image" || !e.trim || !d) return null;
  return e.trim[0] > 0.01 || e.trim[1] < d - 0.01 ? e.trim : null;
}

export const isEdited = (e: Edits | null | undefined, m: MediaLike) =>
  !!e && (e.rotate !== 0 || e.fh || e.fv || !!e.crop || e.width != null || !!cutOf(e, m) || e.fps != null || e.mute);

/** Edits only a new file can carry. Crop and cut a run already applies (crop on photos and clips, cut on clips). */
export const needsFile = (e: Edits | null | undefined, m: MediaLike) =>
  !!e && (e.rotate !== 0 || e.fh || e.fv || e.width != null || e.fps != null || e.mute || (m.kind === "audio" && !!cutOf(e, m)));

export interface Out { tw: number; th: number; w: number; h: number; len: number; fps: number }

/** The file as it comes out of these edits. tw × th: the turned picture the crop is a part of. */
export function outOf(m: MediaLike, e: Edits): Out {
  const side = e.rotate % 180 !== 0;
  const [tw, th] = side ? [m.height ?? 1, m.width ?? 1] : [m.width ?? 1, m.height ?? 1];
  const [cw, ch] = e.crop ? [e.crop[2] * tw, e.crop[3] * th] : [tw, th];
  const even = m.kind === "video" ? (v: number) => Math.max(2, v - (v % 2)) : (v: number) => v;
  const w = even(clamp(Math.round(e.width ?? cw), 8, 8192));
  const h = even(clamp(Math.round((w * ch) / cw), 8, 8192));
  const t = e.trim ?? [0, m.duration ?? 0];
  return { tw, th, w, h, len: Math.max(0, t[1] - t[0]), fps: e.fps ?? m.fps ?? 0 };
}

/** A picture or clip as a run sizes it: the new file its edits make, else this one with its crop. */
export function runInput<T extends { width: number; height: number; crop?: Crop }>(m: MediaLike, e: Edits | null | undefined, d: T): T {
  if (!needsFile(e, m)) return d;
  const o = outOf({ ...m, width: d.width, height: d.height }, e!);
  return { ...d, width: o.w, height: o.h, crop: undefined };
}

/** 2.5 → "5:2", like server/fit.py. */
export function ratioText(r: number): string {
  for (let d = 1; d <= 16; d++) {
    const n = r * d;
    if (Math.abs(n - Math.round(n)) < 0.02 && Math.round(n) > 0) return `${Math.round(n)}:${d}`;
  }
  return `${r.toFixed(2)}:1`;
}

export const rangeText = (r: Range, unit: string, f: (v: number) => string = String) =>
  (r[0] != null && r[1] != null ? (r[0] === r[1] ? f(r[0]) : `${f(r[0])}–${f(r[1])}`) : r[0] != null ? `≥ ${f(r[0])}` : `≤ ${f(r[1]!)}`) + unit;

export const inRange = (v: number, r?: Range, slack = 0) => !r || ((r[0] == null || v >= r[0] * (1 - slack)) && (r[1] == null || v <= r[1] * (1 + slack)));

export type State = "ok" | "fix" | "bad" | "auto";

/** One of the model's limits against the file. "fix": a run changes the file to fit (`run` says how); "bad": it can't run;
 *  "auto": made so when it runs, whatever the file. */
export interface Check { key: string; tool: Tool | null; label: string; value: string; state: State; run: string }

export function checks(kind: MediaLike["kind"], fit: Fit | undefined, o: Out): Check[] {
  if (!fit) return [];
  const c: Check[] = [];
  if (kind !== "audio") {
    const short = Math.min(o.w, o.h), long = Math.max(o.w, o.h), r = o.w / o.h;
    if (fit.short) c.push({ key: "short", tool: "size", label: `Short side ${rangeText(fit.short, " px")}`, value: `${short}`, state: inRange(short, fit.short) ? "ok" : "fix", run: short < (fit.short[0] ?? 0) ? "scales it up" : "scales it down" });
    if (fit.long) c.push({ key: "long", tool: "size", label: `Long side ${rangeText(fit.long, " px")}`, value: `${long}`, state: inRange(long, fit.long) ? "ok" : "fix", run: long > (fit.long[1] ?? Infinity) ? "scales it down" : "scales it up" });
    if (fit.pixels) {
      const px = o.w * o.h;
      c.push({ key: "pixels", tool: "size", label: `Pixels ${rangeText(fit.pixels, " MP", (v) => `${+(v / 1e6).toFixed(2)}`)}`, value: `${+(px / 1e6).toFixed(2)} MP`, state: inRange(px, fit.pixels) ? "ok" : "fix", run: px < (fit.pixels[0] ?? 0) ? "scales it up" : "scales it down" });
    }
    if (fit.aspect) {
      const to = fit.aspect[1] != null && r > fit.aspect[1] ? fit.aspect[1] : fit.aspect[0] ?? r;
      c.push({ key: "aspect", tool: "crop", label: `Shape ${rangeText(fit.aspect, "", ratioText).replace("–", " to ")}`, value: ratioText(r), state: inRange(r, fit.aspect, 0.002) ? "ok" : "fix", run: `crops it to ${ratioText(to)}` });
    }
  }
  if (kind !== "image" && fit.seconds) {
    const [lo, hi] = fit.seconds;
    const state = lo != null && o.len < lo - 0.05 ? "bad" : hi != null && o.len > hi + 0.05 ? "fix" : "ok";
    c.push({ key: "seconds", tool: "cut", label: `Length ${rangeText(fit.seconds, " s")}`, value: `${o.len.toFixed(1)} s`, state, run: state === "bad" ? `can't run: it needs ${lo} s` : `sends the first ${hi} s` });
  }
  if (fit.total && kind !== "image") c.push({ key: "total", tool: "cut", label: `${fit.total} s across this input`, value: `${o.len.toFixed(1)} s`, state: o.len <= fit.total + 0.05 ? "ok" : "fix", run: `cuts it to ${fit.total} s` });
  if (kind === "video" && fit.fps && o.fps) {
    const to = clamp(o.fps, fit.fps[0] ?? 0, fit.fps[1] ?? 1e9);
    c.push({ key: "fps", tool: "rate", label: `Frame rate ${rangeText(fit.fps, " fps")}`, value: `${+o.fps.toFixed(2)}`, state: inRange(o.fps, fit.fps, 0.002) ? "ok" : "fix", run: `resamples it to ${+to.toFixed(2)} fps` });
  }
  if (fit.mb) c.push({ key: "mb", tool: null, label: `Under ${fit.mb} MB`, value: "at run", state: "auto", run: "" });
  return c;
}

const RANK: Record<State, number> = { bad: 0, fix: 1, ok: 2, auto: 3 };
export const byState = (a: Check, b: Check) => RANK[a.state] - RANK[b.state];

/** One line for a file: what a run does to it, or that it fits. */
export function statusOf(m: MediaLike, fit: Fit | undefined, e: Edits, model: string): { state: "ok" | "fix" | "bad"; text: string } | null {
  if (!fit) return null;
  const c = checks(m.kind, fit, outOf(m, e));
  const bad = c.find((x) => x.state === "bad");
  if (bad) return { state: "bad", text: `Too short: ${model} needs ${fit.seconds?.[0]} s` };
  const fix = [...new Set(c.filter((x) => x.state === "fix").map((x) => x.run))];
  if (fix.length) return { state: "fix", text: `Run ${fix.join(", ")}` };
  return { state: "ok", text: `Fits ${model}` };
}

/** The part a run keeps when the shape is outside the model's, in the turned picture's fractions. */
export function keepBox(m: MediaLike, e: Edits, fit?: Fit): Crop | null {
  if (!fit?.aspect || m.kind === "audio") return null;
  const o = outOf(m, e), [x, y, w, h] = e.crop ?? [0, 0, 1, 1], r = o.w / o.h;
  const [lo, hi] = fit.aspect;
  if (hi != null && r > hi * 1.002) { const nw = (w * hi) / r; return [x + (w - nw) / 2, y, nw, h]; }
  if (lo != null && r < lo * 0.998) { const nh = (h * r) / lo; return [x, y + (h - nh) / 2, w, nh]; }
  return null;
}

/** server/fit.py's plan: the crop and size that meet the model's shape and side limits, changing as little as it can. */
function fitPlan(tw: number, th: number, crop: Crop | null, W: number, H: number, fit: Fit, even: boolean): { crop: Crop | null; width: number | null } {
  const [cx0, cy0, cw0, ch0] = crop ?? [0, 0, 1, 1];
  let [l, t, r, b] = [cx0 * tw, cy0 * th, (cx0 + cw0) * tw, (cy0 + ch0) * th];
  let [w, h] = [W, H];
  let cropped = false;
  const [aLo, aHi] = fit.aspect ?? [null, null];
  if (aHi && w / h > aHi * 1.002) {
    const keep = (h * aHi) / w, c = (l + r) / 2, half = ((r - l) * keep) / 2;
    [l, r, w, cropped] = [c - half, c + half, h * aHi, true];
  } else if (aLo && w / h < aLo * 0.998) {
    const keep = w / aLo / h, c = (t + b) / 2, half = ((b - t) * keep) / 2;
    [t, b, h, cropped] = [c - half, c + half, w / aLo, true];
  }
  const short = Math.min(w, h), long = Math.max(w, h);
  const lo = (k: "short" | "long" | "pixels") => fit[k]?.[0] ?? null;
  const hi = (k: "short" | "long" | "pixels") => fit[k]?.[1] ?? null;
  const up = Math.max(1, ...[[lo("short"), short], [lo("long"), long]].filter(([v]) => v).map(([v, s]) => v! / s!), ...(lo("pixels") ? [Math.sqrt(lo("pixels")! / (w * h))] : []));
  const down = Math.min(Infinity, ...[[hi("short"), short], [hi("long"), long]].filter(([v]) => v).map(([v, s]) => v! / s!), ...(hi("pixels") ? [Math.sqrt(hi("pixels")! / (w * h))] : []));
  const s = Math.min(up, down);
  const step = even ? 2 : 1;
  const sized = Math.abs(s - 1) > 0.0005;
  const outW = s > 1 ? Math.ceil((w * s) / step) * step : Math.max(step, Math.floor((w * s) / step) * step);
  const box: Crop = [l / tw, t / th, (r - l) / tw, (b - t) / th];
  return { crop: cropped ? box : crop, width: sized || cropped ? outW : null };
}

/** The edits that make a file meet the model's limits, and the tools they touched. */
export function fitEdits(m: MediaLike, fit: Fit, e: Edits): { edits: Edits; changed: Tool[] } {
  const next = { ...e };
  const changed: Tool[] = [];
  const o = outOf(m, e);
  if (m.kind !== "audio" && m.width && m.height) {
    const p = fitPlan(o.tw, o.th, e.crop, o.w, o.h, fit, m.kind === "video");
    if (p.crop !== e.crop) { next.crop = p.crop; next.ratio = null; changed.push("crop"); }
    if (p.width != null && p.width !== o.w) { next.width = p.width; changed.push("size"); }
  }
  const hi = fit.seconds?.[1] ?? fit.total ?? null;
  if (m.kind !== "image" && hi != null && o.len > hi + 0.05) {
    const a = e.trim?.[0] ?? 0;
    next.trim = [a, a + hi];
    changed.push("cut");
  }
  if (m.kind === "video" && fit.fps && m.fps && !inRange(o.fps, fit.fps, 0.002)) {
    next.fps = clamp(m.fps, fit.fps[0] ?? 0, fit.fps[1] ?? 1e9);
    changed.push("rate");
  }
  return { edits: next, changed };
}

/** The edits as server/edit.py takes them. Flipped both ways is half a turn. */
export function toOps(e: Edits, m: MediaLike): MediaOps {
  const both = e.fh && e.fv;
  const cut = cutOf(e, m);
  const o = outOf(m, e);
  return {
    rotate: (both ? (e.rotate + 180) % 360 : e.rotate) as Rot,
    flip: both ? null : e.fh ? "h" : e.fv ? "v" : null,
    crop: e.crop,
    width: e.width != null ? o.w : null,
    height: e.width != null ? o.h : null,
    start: cut ? cut[0] : null,
    end: cut ? cut[1] : null,
    fps: e.fps,
    mute: e.mute,
  };
}

/** Before → after, for the editor's footer. */
export function deltaOf(m: MediaLike, e: Edits): { label: string; from: string; to: string }[] {
  const o = outOf(m, e);
  const rows: { label: string; from: string; to: string }[] = [];
  if (m.kind !== "audio" && m.width && m.height) rows.push({ label: "Size", from: `${m.width}×${m.height}`, to: `${o.w}×${o.h}` });
  if (m.kind !== "image" && m.duration) rows.push({ label: "Length", from: `${m.duration.toFixed(1)} s`, to: `${o.len.toFixed(1)} s` });
  if (m.kind === "video" && m.fps) rows.push({ label: "Rate", from: `${+m.fps.toFixed(2)} fps`, to: `${+o.fps.toFixed(2)} fps` });
  if (m.kind === "video" && m.has_audio) rows.push({ label: "Sound", from: "on", to: e.mute ? "off" : "on" });
  return rows;
}
