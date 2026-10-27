import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { clock } from "../lib/format";
import { Badge, cx } from "./ui";
import { I } from "./oi";

export interface Side {
  src?: string | null;
  kind: "video" | "image";
  poster?: string | null;
  label: string;
  badge?: ReactNode;
}

export const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
};

/**
 * Synced A/B player: side by side or wipe, one transport for both.
 * Fills its parent; media are letterboxed (object-contain) so nothing is cropped.
 */
export function ABPlayer({ a, b, overlay, height, keys = true, className }: { a: Side | null; b: Side | null; overlay?: ReactNode; height?: number | string; keys?: boolean; className?: string }) {
  const [mode, setMode] = useState<"side" | "wipe">("side");
  const [wipe, setWipe] = useState(0.5);
  const va = useRef<HTMLVideoElement>(null);
  const vb = useRef<HTMLVideoElement>(null);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [playing, setPlaying] = useState(false);
  const master = () => vb.current ?? va.current;
  const videos = () => [va.current, vb.current].filter(Boolean) as HTMLVideoElement[];
  const hasVideo = (a?.kind === "video" && !!a.src) || (b?.kind === "video" && !!b.src);

  const seek = useCallback((time: number) => {
    for (const v of videos()) v.currentTime = Math.max(0, Math.min(time, (v.duration || time) - 0.01));
    setT(time);
  }, []);

  const toggle = useCallback(() => {
    const vs = videos();
    if (!vs.length) return;
    if (vs[0].paused) {
      const m = master();
      if (m) for (const v of vs) if (v !== m) v.currentTime = m.currentTime;
      vs.forEach((v) => v.play().catch(() => {}));
      setPlaying(true);
    } else {
      vs.forEach((v) => v.pause());
      setPlaying(false);
    }
  }, []);

  useEffect(() => {
    const m = master();
    if (!m) return;
    const onTime = () => {
      setT(m.currentTime);
      const other = m === vb.current ? va.current : vb.current;
      if (other && !other.paused && Math.abs(other.currentTime - m.currentTime) > 0.12) other.currentTime = m.currentTime;
    };
    const onMeta = () => setDur(m.duration || 0);
    const onEnd = () => {
      setPlaying(false);
      videos().forEach((v) => v.pause());
    };
    m.addEventListener("timeupdate", onTime);
    m.addEventListener("loadedmetadata", onMeta);
    m.addEventListener("ended", onEnd);
    if (m.duration) setDur(m.duration);
    return () => {
      m.removeEventListener("timeupdate", onTime);
      m.removeEventListener("loadedmetadata", onMeta);
      m.removeEventListener("ended", onEnd);
    };
  }, [a?.src, b?.src, mode]);

  useEffect(() => {
    if (!keys || !hasVideo) return;
    const on = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); toggle(); }
      else if (k === "k") { videos().forEach((v) => v.pause()); setPlaying(false); }
      else if (k === "j") seek(Math.max(0, (master()?.currentTime ?? 0) - (e.shiftKey ? 1 / 24 : 1)));
      else if (k === "l") seek((master()?.currentTime ?? 0) + (e.shiftKey ? 1 / 24 : 1));
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [keys, hasVideo, toggle, seek]);

  const render = (s: Side | null, ref: React.RefObject<HTMLVideoElement>, fit = "object-contain") => {
    if (!s) return null;
    return s.kind === "video" && s.src ? (
      <video ref={ref} src={s.src} poster={s.poster ?? undefined} muted={ref === va} playsInline preload="auto" className={cx("absolute inset-0 w-full h-full block", fit)} />
    ) : s.src || s.poster ? (
      <img src={(s.src || s.poster)!} alt={s.label} draggable={false} className={cx("absolute inset-0 w-full h-full block", fit)} />
    ) : null;
  };
  const label = (s: Side, pos: "left" | "right") => (
    <Badge tone="glass" className={cx("absolute top-2.5 uppercase", pos === "left" ? "left-2.5" : "right-2.5")}>{s.label}</Badge>
  );

  const both = a && b;
  const pane = "relative min-w-0 min-h-0 rounded-lg overflow-hidden bg-deep";
  return (
    <div className={cx("flex flex-col gap-2 min-h-0", height == null && "flex-1", className)} style={height != null ? { height } : undefined}>
      {mode === "side" || !both ? (
        <div className={cx("flex-1 min-h-0 grid gap-1.5", both ? "grid-cols-2" : "grid-cols-1")}>
          {[a, b].map((s, i) =>
            s ? (
              <div key={i} className={pane}>
                {render(s, i === 0 ? va : vb)}
                {label(s, "left")}
                {s.badge && <span className="absolute right-2.5 top-2.5">{s.badge}</span>}
                {(i === 1 || !both) && overlay}
              </div>
            ) : null,
          )}
        </div>
      ) : (
        <div
          className={cx(pane, "flex-1 cursor-ew-resize select-none touch-none")}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            const r = e.currentTarget.getBoundingClientRect();
            setWipe(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
          }}
          onPointerDown={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setWipe(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
          }}
        >
          {render(b, vb)}
          <div className="absolute inset-0" style={{ clipPath: `inset(0 ${100 - wipe * 100}% 0 0)` }}>{render(a, va)}</div>
          <div aria-hidden className="absolute top-0 bottom-0 w-px bg-text/90" style={{ left: `${wipe * 100}%` }}>
            <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-px w-7 h-7 rounded-full bg-text text-ink shadow-pop flex items-center justify-center"><I n="split" size={13} /></span>
          </div>
          {label(a!, "left")}
          {label(b!, "right")}
          <input type="range" aria-label="Wipe position" min={0} max={100} value={Math.round(wipe * 100)} onChange={(e) => setWipe(+e.target.value / 100)} className="sr-only" />
          {overlay}
        </div>
      )}
      {(hasVideo || both) && (
        <div className="shrink-0 h-9 flex items-center gap-2.5 px-1">
          {hasVideo && (
            <>
              <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={toggle} className="mk-btn w-7 h-7 shrink-0 rounded-md border-0 bg-text text-ink flex items-center justify-center hover:bg-white">
                <I n={playing ? "pause" : "play"} size={12} />
              </button>
              <span className="font-mono text-xs tabular whitespace-nowrap text-soft">{clock(t)} <span className="text-faint">/ {clock(dur)}</span></span>
              <input type="range" aria-label="Scrub" min={0} max={dur || 1} step={0.01} value={t} onChange={(e) => seek(+e.target.value)} className="flex-1 min-w-0 accent-[#F2FF59] h-5" />
              <span className="font-mono text-xs2 text-faint whitespace-nowrap max-md:hidden" title="Space play/pause · J/L ±1 s (Shift: ±1 frame) · K stop">Space J K L</span>
            </>
          )}
          {both && (
            <div role="radiogroup" aria-label="Compare mode" className={cx("inline-flex p-0.5 gap-0.5 rounded-lg bg-bg border border-line shrink-0", !hasVideo && "ml-auto")}>
              {([["side", "Side by side", "columns"], ["wipe", "Wipe", "split"]] as const).map(([k, l, n]) => (
                <button key={k} type="button" role="radio" aria-checked={mode === k} title={l} onClick={() => setMode(k)}
                  className={cx("mk-btn h-6 px-2 rounded-md border-0 inline-flex items-center gap-1.5 text-xs", mode === k ? "bg-active text-text shadow-seg" : "bg-transparent text-muted hover:text-text")}>
                  <I n={n} size={13} /><span className="max-sm:hidden">{l}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
