import { useEffect, useRef, useState } from "react";
import { clock } from "../lib/format";
import { cx } from "./ui";
import { I } from "./oi";

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

const BARS = 120;

/** A sound's loudness in BARS columns, decoded in the browser. */
function usePeaks(src: string | undefined) {
  const [peaks, setPeaks] = useState<number[]>([]);
  useEffect(() => {
    if (!src) return;
    let cancelled = false;
    const ctx = new AudioContext();
    fetch(src)
      .then((r) => r.arrayBuffer())
      .then((b) => ctx.decodeAudioData(b))
      .then((buf) => {
        const d = buf.getChannelData(0);
        const step = Math.max(1, Math.floor(d.length / BARS));
        const out: number[] = [];
        for (let i = 0; i < BARS; i++) {
          let m = 0;
          for (let j = i * step; j < Math.min(d.length, (i + 1) * step); j += 4) m = Math.max(m, Math.abs(d[j]));
          out.push(m);
        }
        const top = Math.max(0.01, ...out);
        if (!cancelled) setPeaks(out.map((v) => v / top));
      })
      .catch(() => {})
      .finally(() => void ctx.close());
    return () => { cancelled = true; };
  }, [src]);
  return peaks;
}

export function Trimmer({
  src, duration, trim, onChange, window, fps, height, audio, model,
}: {
  /** Who the window is for: "Not sent: Kling takes 10 s". */
  model?: string;
  /** A sound: its wave shows instead of frames. */
  audio?: boolean;
  src?: string;
  duration: number;
  trim: [number, number];
  onChange: (t: [number, number]) => void;
  window: [number, number] | null;
  fps?: number;
  height?: number;
}) {
  const frames = useFilmstrip(audio ? undefined : src, duration);
  const peaks = usePeaks(audio ? src : undefined);
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

  // Longer than the model takes is fine: the run sends its first part. Shorter can't run.
  const short = !!window && len < window[0] - 0.05;
  const long = !!window && len > window[1] + 0.05;
  const fits = !short;
  return (
    <div>
      <div ref={bar} className="trim" style={{ gridTemplateColumns: `repeat(${FRAMES}, minmax(0, 1fr))` }}>
        {audio ? (
          <svg className="trim-wave" viewBox={`0 0 ${BARS} 100`} preserveAspectRatio="none" aria-hidden>
            {peaks.map((v, i) => <rect key={i} x={i + 0.15} width={0.7} y={50 - Math.max(2, v * 46)} height={Math.max(4, v * 92)} rx={0.3} />)}
          </svg>
        ) : Array.from({ length: FRAMES }, (_, i) =>
          frames[i] ? <img key={i} src={frames[i]} alt="" draggable={false} /> : <span key={i} />,
        )}
        <div aria-hidden className="trim-out" style={{ left: 0, width: `${pct(a)}%` }} />
        <div aria-hidden className="trim-out" style={{ right: 0, width: `${100 - pct(b)}%` }} />
        <div aria-hidden className="trim-win" style={{ left: `${pct(a)}%`, right: `${100 - pct(b)}%`, boxShadow: `inset 0 0 0 2px ${fits ? "#FF4FA3" : "#FF5C78"}` }} />
        {long && window && (
          <div aria-hidden className="trim-cap" style={{ left: `${pct(a + window[1])}%`, width: `${pct(b - a - window[1])}%` }}>
            <span>{model ? `Not sent: ${model} takes ${window[1]} s` : `Not sent: past ${window[1]} s`}</span>
          </div>
        )}
        <div
          role="slider" tabIndex={0} aria-label="In point" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={a} aria-valuetext={clock(a)}
          onPointerDown={drag("in")} onKeyDown={key("in")}
          className="trim-h in" style={{ left: `${pct(a)}%`, background: fits ? "#FF4FA3" : "#FF5C78" }}
        ><span aria-hidden /></div>
        <div
          role="slider" tabIndex={0} aria-label="Out point" aria-valuemin={0} aria-valuemax={duration} aria-valuenow={b} aria-valuetext={clock(b)}
          onPointerDown={drag("out")} onKeyDown={key("out")}
          className="trim-h out" style={{ left: `calc(${pct(b)}% - 12px)`, background: fits ? "#FF4FA3" : "#FF5C78" }}
        ><span aria-hidden /></div>
      </div>
      <div className="trim-t mono">
        <span>{clock(a)}</span>
        <b>{len.toFixed(1)} s</b>
        <span>{clock(b)}</span>
      </div>
      <p className={cx("trim-fit", !fits && "bad")}>
        <I n={short ? "info" : long ? "clock" : "check"} size={12} />
        {!window ? "Any length"
          : short ? `Needs at least ${window[0]} s`
          : long ? `Runs ${window[1]} s from ${clock(a)}`
          : window[0] ? `Fits the ${window[0]}–${window[1]} s window` : `Fits: up to ${window[1]} s`}
        {fps ? ` · ${Math.round(fps)} fps` : ""}
        {height ? ` · ${height}p` : ""}
      </p>
    </div>
  );
}
