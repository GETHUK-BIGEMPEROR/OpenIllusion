import { useEffect, useRef, useState } from "react";
import { clock } from "../lib/format";
import { Check, Info } from "./Icons";
import { cx } from "./ui";

const FRAMES = 8;

/** Filmstrip frames grabbed in the browser from the clip itself. */
function useFilmstrip(src: string | undefined, duration: number | undefined) {
  const [frames, setFrames] = useState<string[]>([]);
  useEffect(() => {
    if (!src || !duration) return;
    let cancelled = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    v.src = src;
    const c = document.createElement("canvas");
    const out: string[] = [];
    let i = 0;
    const grab = () => {
      if (cancelled) return;
      if (i >= FRAMES) return setFrames(out.slice());
      v.currentTime = Math.min(duration - 0.05, ((i + 0.5) / FRAMES) * duration);
    };
    v.onseeked = () => {
      const h = 64;
      const w = Math.round((v.videoWidth / Math.max(1, v.videoHeight)) * h) || 96;
      c.width = w;
      c.height = h;
      c.getContext("2d")?.drawImage(v, 0, 0, w, h);
      try {
        out.push(c.toDataURL("image/jpeg", 0.7));
      } catch {
        out.push("");
      }
      i++;
      setFrames(out.slice());
      grab();
    };
    v.onloadeddata = grab;
    return () => {
      cancelled = true;
      v.src = "";
    };
  }, [src, duration]);
  return frames;
}

export function Trimmer({
  src, duration, trim, onChange, window, fps, height,
}: {
  src?: string;
  duration: number;
  trim: [number, number];
  onChange: (t: [number, number]) => void;
  window: [number, number] | null;
  fps?: number;
  height?: number;
}) {
  const frames = useFilmstrip(src, duration);
  const bar = useRef<HTMLDivElement>(null);
  const [a, b] = [trim[0], trim[1] || duration];
  const len = b - a;
  const pct = (t: number) => (duration ? (t / duration) * 100 : 0);

  const drag = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.preventDefault();
    const el = bar.current;
    if (!el) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)) * duration;
      const minLen = 0.5;
      if (which === "in") onChange([Math.min(t, b - minLen), b]);
      else onChange([a, Math.max(t, a + minLen)]);
    };
    const up = () => {
      window_.removeEventListener("pointermove", move);
      window_.removeEventListener("pointerup", up);
    };
    const window_ = globalThis.window;
    window_.addEventListener("pointermove", move);
    window_.addEventListener("pointerup", up);
  };

  const key = (which: "in" | "out") => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 1 : 0.1;
    const d = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
    if (!d) return;
    e.preventDefault();
    if (which === "in") onChange([Math.max(0, Math.min(a + d, b - 0.5)), b]);
    else onChange([a, Math.min(duration, Math.max(b + d, a + 0.5))]);
  };

  const fits = !window || (len >= window[0] - 0.05 && len <= window[1] + 0.05);
  return (
    <div>
      <div ref={bar} className="relative h-10 rounded-md overflow-hidden grid gap-px bg-bg select-none" style={{ gridTemplateColumns: `repeat(${FRAMES}, minmax(0, 1fr))` }}>
        {Array.from({ length: FRAMES }, (_, i) =>
          frames[i] ? <img key={i} src={frames[i]} alt="" className="w-full h-full object-cover block" draggable={false} /> : <span key={i} className="bg-raised" />,
        )}
        <div aria-hidden className="absolute left-0 top-0 bottom-0 bg-bg/70" style={{ width: `${pct(a)}%` }} />
        <div aria-hidden className="absolute right-0 top-0 bottom-0 bg-bg/70" style={{ width: `${100 - pct(b)}%` }} />
        <div aria-hidden className="absolute top-0 bottom-0 rounded-md" style={{ left: `${pct(a)}%`, right: `${100 - pct(b)}%`, boxShadow: `inset 0 0 0 2px ${fits ? "#F2FF59" : "#FF6B7E"}` }} />
        <div
          role="slider" tabIndex={0} aria-label="In point" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={a} aria-valuetext={clock(a)}
          onPointerDown={drag("in")} onKeyDown={key("in")}
          className="absolute top-0 bottom-0 w-3 cursor-ew-resize touch-none flex items-center justify-center rounded-l-md outline-none focus-visible:ring-2 focus-visible:ring-violet"
          style={{ left: `${pct(a)}%`, background: fits ? "#F2FF59" : "#FF6B7E" }}
        ><span aria-hidden className="w-[3px] h-4 rounded-full bg-ink/60" /></div>
        <div
          role="slider" tabIndex={0} aria-label="Out point" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={b} aria-valuetext={clock(b)}
          onPointerDown={drag("out")} onKeyDown={key("out")}
          className="absolute top-0 bottom-0 w-3 cursor-ew-resize touch-none z-10 flex items-center justify-center rounded-r-md outline-none focus-visible:ring-2 focus-visible:ring-violet"
          style={{ left: `calc(${pct(b)}% - 12px)`, background: fits ? "#F2FF59" : "#FF6B7E" }}
        ><span aria-hidden className="w-[3px] h-4 rounded-full bg-ink/60" /></div>
      </div>
      <div className="flex justify-between items-center mt-1.5 font-mono text-xs2 tabular text-muted">
        <span>{clock(a)}</span>
        <span className="text-text h-4 px-1.5 leading-4 bg-raised rounded">{len.toFixed(1)} s</span>
        <span>{clock(b)}</span>
      </div>
      <p className={cx("flex items-center gap-1.5 mt-1.5 mb-0 text-xs", fits ? "text-muted" : "text-rose-text")}>
        {fits ? <Check size={12} className="text-mint" /> : <Info size={12} className="text-rose" />}
        {window
          ? fits
            ? `Fits the ${window[0]}–${window[1]} s window`
            : `Trim to ${window[0]}–${window[1]} s`
          : "Any length"}
        {fps ? ` · ${Math.round(fps)} fps` : ""}
        {height ? ` · ${height}p` : ""}
      </p>
    </div>
  );
}
