import { useEffect, useRef, useState } from "react";
import type { Box } from "../lib/api";
import { newKey } from "../lib/store";
import { Close } from "./Icons";
import { cx } from "./ui";

const COLORS = ["#9A86F0", "#F2FF59", "#5FD39A", "#FFA24C", "#FF6B7E", "#BBAEF7"];

/** The base image with a region tool. Boxes are stored as fractions of the image. */
export function RegionCanvas({ src, natural, boxes, onChange, height, hint = "Drag on the image to mark a region, then describe the change" }: {
  src: string;
  natural?: { width?: number; height?: number };
  boxes: Box[];
  onChange: (b: Box[]) => void;
  height?: string;
  hint?: string;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<{ w: number; h: number } | null>(natural?.width && natural?.height ? { w: natural.width, h: natural.height } : null);
  const [rect, setRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null);
  const [sel, setSel] = useState<string | null>(null);

  // Fit the image inside the frame and remember where it landed.
  useEffect(() => {
    const el = wrap.current;
    if (!el || !img) return;
    const fit = () => {
      const W = el.clientWidth, H = el.clientHeight;
      const s = Math.min(W / img.w, H / img.h);
      const w = img.w * s, h = img.h * s;
      setRect({ x: (W - w) / 2, y: (H - h) / 2, w, h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [img]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!sel) return;
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        onChange(boxes.filter((b) => b.id !== sel));
        setSel(null);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [sel, boxes, onChange]);

  const toFrac = (e: React.PointerEvent): [number, number] => {
    const r = wrap.current!.getBoundingClientRect();
    if (!rect) return [0, 0];
    return [Math.min(1, Math.max(0, (e.clientX - r.left - rect.x) / rect.w)), Math.min(1, Math.max(0, (e.clientY - r.top - rect.y) / rect.h))];
  };

  const down = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("[data-box]")) return;
    const [x, y] = toFrac(e);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDraft([x, y, x, y]);
    setSel(null);
  };
  const move = (e: React.PointerEvent) => {
    if (!draft) return;
    const [x, y] = toFrac(e);
    setDraft([draft[0], draft[1], x, y]);
  };
  const up = () => {
    if (!draft) return;
    const [x0, y0, x1, y1] = draft;
    const box: Box["rect"] = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
    setDraft(null);
    if (box[2] < 0.02 || box[3] < 0.02) return;
    const id = newKey();
    onChange([...boxes, { id, rect: box, label: "" }]);
    setSel(id);
    requestAnimationFrame(() => document.getElementById(`box-label-${id}`)?.focus());
  };

  const place = (r: Box["rect"]) => rect && { left: rect.x + r[0] * rect.w, top: rect.y + r[1] * rect.h, width: r[2] * rect.w, height: r[3] * rect.h };
  const zoom = rect && img ? Math.round((rect.w / img.w) * 100) : null;

  return (
    <div className={cx("flex flex-col gap-2 min-h-0", height == null && "flex-1")} style={height != null ? { height } : undefined}>
      <div ref={wrap} data-own-drop className="relative flex-1 min-h-[240px] rounded-lg overflow-hidden checker select-none cursor-crosshair touch-none" onPointerDown={down} onPointerMove={move} onPointerUp={up}>
        <img src={src} alt="Base image" draggable={false} onLoad={(e) => !img && setImg({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          className="absolute pointer-events-none" style={rect ? { left: rect.x, top: rect.y, width: rect.w, height: rect.h } : { opacity: 0 }} />
        {boxes.map((b, i) => {
          const st = place(b.rect);
          const c = COLORS[i % COLORS.length];
          return st ? (
            <div key={b.id} data-box onPointerDown={(e) => { e.stopPropagation(); setSel(b.id); }}
              className="absolute rounded-md cursor-pointer" style={{ ...st, boxShadow: `inset 0 0 0 ${sel === b.id ? 2 : 1.5}px ${c}${sel === b.id ? "" : "B3"}`, background: sel === b.id ? `${c}1A` : "transparent" }}>
              <span className="absolute -top-[11px] left-1.5 inline-flex items-center gap-1 h-[20px] pl-0.5 pr-2 rounded-md text-xs font-medium max-w-[220px] text-ink shadow-pop" style={{ background: c }}>
                <span className="w-4 h-4 rounded bg-ink/15 flex items-center justify-center font-mono text-xs2">{i + 1}</span>
                <span className="truncate">{b.label || "describe…"}</span>
              </span>
            </div>
          ) : null;
        })}
        {draft && rect && (
          <div className="absolute rounded-md shadow-[inset_0_0_0_1.5px_#F0EFED] bg-white/5 pointer-events-none"
            style={place([Math.min(draft[0], draft[2]), Math.min(draft[1], draft[3]), Math.abs(draft[2] - draft[0]), Math.abs(draft[3] - draft[1])])!} />
        )}
        {!boxes.length && !draft && <span className="glass absolute left-2.5 bottom-2.5 h-6 rounded-md px-2 inline-flex items-center text-xs text-soft pointer-events-none">{hint}</span>}
        {img && <span className="glass absolute right-2.5 bottom-2.5 h-6 rounded-md px-2 inline-flex items-center font-mono text-xs2 text-soft tabular pointer-events-none">{img.w} × {img.h}{zoom ? ` · ${zoom}%` : ""}</span>}
      </div>
      {boxes.length > 0 && (
        <ul aria-label="Regions" className="shrink-0 m-0 p-0 list-none grid gap-1.5 max-h-[112px] overflow-y-auto scroll-y" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))" }}>
          {boxes.map((b, i) => (
            <li key={b.id} className={cx("h-8 flex items-center gap-2 pl-1.5 pr-1 rounded-lg bg-surface border", sel === b.id ? "border-violet/60" : "border-line")}>
              <span className="w-5 h-5 shrink-0 rounded flex items-center justify-center font-mono text-xs2 text-ink" style={{ background: COLORS[i % COLORS.length] }}>{i + 1}</span>
              <label className="sr-only" htmlFor={`box-label-${b.id}`}>Box {i + 1} instruction</label>
              <input id={`box-label-${b.id}`} value={b.label} onFocus={() => setSel(b.id)} onChange={(e) => onChange(boxes.map((x) => (x.id === b.id ? { ...x, label: e.target.value } : x)))}
                placeholder="What changes here?" className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm placeholder:text-faint" />
              <button type="button" aria-label={`Delete box ${i + 1}`} onClick={() => onChange(boxes.filter((x) => x.id !== b.id))} className="mk-btn w-6 h-6 shrink-0 rounded-md border-0 bg-transparent text-muted hover:text-text hover:bg-white/[0.06] flex items-center justify-center"><Close size={9} /></button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
