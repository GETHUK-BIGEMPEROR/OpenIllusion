import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type Job, type LocalStatus } from "../lib/api";
import { useApp } from "../lib/store";
import { SPRITE, type IconName } from "./sprite";
import { cx } from "./ui";

export { cx };

/** The icon sprite, once per page. */
export function Sprite() {
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden dangerouslySetInnerHTML={{ __html: SPRITE }} />;
}

export function I({ n, className, style }: { n: IconName; className?: string; style?: CSSProperties }) {
  return <svg className={cx("i", className)} style={style} aria-hidden><use href={`#i-${n}`} /></svg>;
}

/** Circular progress, 0..1. */
export function Ring({ p, sm }: { p: number; sm?: boolean }) {
  const c = 2 * Math.PI * 22;
  return (
    <svg className={cx("pring", sm && "sm")} viewBox="0 0 50 50" aria-hidden>
      <circle className="bgc" cx="25" cy="25" r="22" />
      <circle className="fgc" cx="25" cy="25" r="22" strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(1, Math.max(0, p)))} />
    </svg>
  );
}

/** Tile media: a shimmer at the right shape until the picture arrives, then a fade in. */
export function Media({ src, video, poster, ar, children, imgStyle }: {
  src?: string | null; video?: string | null; poster?: string | null; ar: number; children?: ReactNode; imgStyle?: CSSProperties;
}) {
  const [loaded, setLoaded] = useState(false);
  const vid = useRef<HTMLVideoElement>(null);
  useEffect(() => setLoaded(false), [src, video]);
  // Loops play while on screen only.
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    const io = new IntersectionObserver(([en]) => (en.isIntersecting ? v.play().catch(() => {}) : v.pause()), { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, [video]);
  const done = () => setLoaded(true);
  return (
    <div className={cx("media", (loaded || (!src && !video)) && "loaded")} style={{ "--ar": ar } as CSSProperties}>
      {video ? (
        <video ref={vid} src={video} poster={poster ?? undefined} muted loop playsInline preload="metadata" aria-hidden onLoadedData={done} onError={done}
          style={{ width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0, transition: "opacity .45s", ...imgStyle }} />
      ) : src ? (
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} onLoad={done} onError={done} style={imgStyle} />
      ) : null}
      {children}
    </div>
  );
}

/** Before/after wipe. Drag, or use the arrow keys. */
export function Compare({ before, after, lb = "Before", la = "After", children }: { before: string; after: string; lb?: string; la?: string; children?: ReactNode }) {
  const [x, setX] = useState(50);
  const el = useRef<HTMLDivElement>(null);
  const at = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    setX(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div ref={el} className="cmp" role="slider" tabIndex={0} aria-label={`Drag to compare ${lb.toLowerCase()} and ${la.toLowerCase()}`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(x)} style={{ "--x": `${x}%` } as CSSProperties}
      onPointerDown={(e) => { el.current!.setPointerCapture(e.pointerId); at(e.clientX); }}
      onPointerMove={(e) => { if (e.buttons) at(e.clientX); }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); setX((v) => Math.max(0, v - 5)); }
        if (e.key === "ArrowRight") { e.preventDefault(); setX((v) => Math.min(100, v + 5)); }
      }}>
      <img src={before} alt={lb} draggable={false} />
      <img className="after" src={after} alt={la} draggable={false} />
      <span className="pill tg l">{lb}</span><span className="pill tg r">{la}</span>
      <div className="handle"><div className="knob"><I n="compare" /></div></div>
      {children}
    </div>
  );
}

export function EmptyBox({ icon, title, children, action, style }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; style?: CSSProperties }) {
  return (
    <div className="empty" style={style}>
      {icon && <div className="empty-ic"><I n={icon} /></div>}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export const gpuName = (gpu?: string | null) => (gpu ? gpu.replace(/^cuda:\d+ /, "").replace(/ :.*$/, "").replace(/^NVIDIA (GeForce )?/, "") : null);

export function localState(l?: LocalStatus): { tone: "ok" | "warn" | "off"; text: string; title: string } {
  if (!l) return { tone: "off", text: "Checking", title: "Looking for ComfyUI" };
  if (l.upstream_match === false) return { tone: "warn", text: "Two ComfyUIs", title: `Comfy API v2 runs on ${l.upstream_seen ?? l.upstream}, not ${l.comfyui_url}` };
  if (!l.comfyui) return { tone: "off", text: "Offline", title: `No ComfyUI at ${l.comfyui_url}` };
  const gpu = gpuName(l.gpu);
  if (l.ok) return { tone: "ok", text: gpu ?? "Ready", title: `ComfyUI ${l.comfyui_version ?? ""} and Comfy API v2 up${gpu ? ` · ${gpu}` : ""}` };
  return { tone: "warn", text: gpu ?? "ComfyUI up", title: `ComfyUI up · Comfy API v2 not running at ${l.v2_url}${l.autostart && l.proxy_installed ? " (starts when you run)" : ""}` };
}

export const dotStyle = (tone: "ok" | "warn" | "off" | "bad"): CSSProperties | undefined =>
  tone === "warn" ? { background: "var(--orange)", boxShadow: "0 0 0 3px rgba(255,162,76,.15)" } : tone === "bad" ? { background: "var(--rose)", boxShadow: "0 0 0 3px rgba(255,107,126,.15)" } : undefined;

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 30_000 });
}

/** Sticky page header: title, search (opens the palette), page actions, where runs go. */
export function PageHead({ title, count, filters, actions }: { title: ReactNode; count?: number | null; filters?: ReactNode; actions?: ReactNode }) {
  const setPalette = useApp((s) => s.setPalette);
  const status = useStatus();
  const local = localState(status.data?.local);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return (
    <header className="phead">
      <div className="phead-row">
        <div className="ptitle"><h1>{title}</h1>{count != null && <span className="count">{count}</span>}</div>
        <button className="search" type="button" onClick={() => setPalette(true)}>
          <I n="search" /><span>Search templates and generations</span><kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div className="hactions">
          {actions}
          <a className="enginepill" href="#/settings" title={local.title}><i className={cx("dot", local.tone === "off" && "off")} style={dotStyle(local.tone)} /><b>Local</b>{local.text}</a>
          <button className="icon-btn mob-only" type="button" aria-label="Search" onClick={() => setPalette(true)}><I n="search" /></button>
        </div>
      </div>
      {filters && <div className="filters">{filters}</div>}
    </header>
  );
}

/** Where overlays mount: inside the app frame, so they follow its width rules. */
export const appRoot = () => document.getElementById("app") ?? document.body;

/** 0..1 for a run in flight: the sampler's own value, else steps, else nodes. */
export function jobProgress(job?: Pick<Job, "progress"> | null) {
  const p = job?.progress;
  if (!p) return 0;
  if (p.value != null) return p.value;
  if (p.step && p.steps) return p.step / p.steps;
  if (p.nodes_done != null && p.nodes_total) return p.nodes_done / p.nodes_total;
  return 0;
}

/** Waiting states: the run exists but nothing is sampling yet. */
export const QUEUED = new Set(["estimating", "waiting", "queued", "rate_limited"]);
