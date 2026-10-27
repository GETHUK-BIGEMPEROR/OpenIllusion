import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type Job, type LocalStatus } from "../lib/api";
import { isActive, useJobs } from "../lib/live";
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

/** Tile media: a shimmer at the right shape until the picture arrives, then a fade in.
 *  A loop is only mounted near the viewport (its poster stands in elsewhere): every <video>
 *  holds a connection, and a wall of them starves the API calls the page makes. */
export function Media({ src, video, poster, ar, children, imgStyle }: {
  src?: string | null; video?: string | null; poster?: string | null; ar: number; children?: ReactNode; imgStyle?: CSSProperties;
}) {
  const [loaded, setLoaded] = useState(false);
  const [near, setNear] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  useEffect(() => setLoaded(false), [src, video]);
  useEffect(() => {
    const el = box.current;
    if (!el || !video) return;
    const io = new IntersectionObserver(([en]) => setNear(en.isIntersecting), { rootMargin: "300px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [video]);
  const live = !!video && near;
  // Loops play while on screen only.
  useEffect(() => {
    const v = vid.current;
    if (!v) return;
    const io = new IntersectionObserver(([en]) => (en.isIntersecting ? v.play().catch(() => {}) : v.pause()), { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, [live]);
  const done = () => setLoaded(true);
  const still = video ? poster : src;
  return (
    <div ref={box} className={cx("media", (loaded || (!src && !video)) && "loaded")} style={{ "--ar": ar } as CSSProperties}>
      {live ? (
        <video ref={vid} src={video!} poster={poster ?? undefined} muted loop playsInline preload="metadata" aria-hidden onLoadedData={done} onError={done}
          style={{ width: "100%", height: "100%", objectFit: "cover", opacity: loaded ? 1 : 0, transition: "opacity .45s", ...imgStyle }} />
      ) : still ? (
        <img src={still} alt="" loading="lazy" decoding="async" draggable={false} onLoad={done} onError={done} style={imgStyle} />
      ) : null}
      {children}
    </div>
  );
}

/** Before/after wipe. Drag, or use the arrow keys. */
export function Compare({ before, after, lb = "Before", la = "After", intro, children }: { before: string; after: string; lb?: string; la?: string; intro?: boolean; children?: ReactNode }) {
  // With intro, the result wipes in from the right once, then the slider is yours.
  const [x, setX] = useState(intro ? 100 : 50);
  const [wiping, setWiping] = useState(!!intro);
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!intro) return;
    const f = requestAnimationFrame(() => requestAnimationFrame(() => setX(50)));
    const t = window.setTimeout(() => setWiping(false), 1100);
    return () => { cancelAnimationFrame(f); clearTimeout(t); };
  }, [intro]);
  const at = (clientX: number) => {
    const r = el.current!.getBoundingClientRect();
    setX(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div ref={el} className={cx("cmp", wiping && "wipe")} role="slider" tabIndex={0} aria-label={`Drag to compare ${lb.toLowerCase()} and ${la.toLowerCase()}`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(x)} style={{ "--x": `${x}%` } as CSSProperties}
      onPointerDown={(e) => { el.current!.setPointerCapture(e.pointerId); setWiping(false); at(e.clientX); }}
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

/** Sticky page header. With a title: title, actions, search, GPU. Without one (Explore): the filters take the title's place. */
export function PageHead({ title, count, filters, actions }: { title?: ReactNode; count?: number | null; filters?: ReactNode; actions?: ReactNode }) {
  const setPalette = useApp((s) => s.setPalette);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  const right = (
    <div className="hactions">
      {actions}
      <button className="icon-btn" type="button" aria-label="Search templates and results" title={`Search (${mac ? "⌘K" : "Ctrl K"})`} onClick={() => setPalette(true)}><I n="search" /></button>
      <GpuStat />
    </div>
  );
  if (!title) {
    return (
      <header className="phead">
        <div className="phead-row hrow"><div className="hfilters">{filters}</div>{right}</div>
      </header>
    );
  }
  return (
    <header className="phead">
      <div className="phead-row">
        <div className="ptitle"><h1>{title}</h1>{count != null && <span className="count">{count}</span>}</div>
        {right}
      </div>
      {filters && <div className="filters">{filters}</div>}
    </header>
  );
}

const GB = (b?: number | null) => (b ? b / 1024 ** 3 : 0);

/** The local GPU in the page header: name and ComfyUI version, a ring while a run is going.
 *  Only there when a local ComfyUI answers; click for memory, the run in flight and the addresses. */
export function GpuStat() {
  const status = useStatus();
  const { data: jobs = [] } = useJobs();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const l = status.data?.local;
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); box.current?.querySelector("button")?.focus(); } };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key); };
  }, [open]);
  if (!l?.comfyui) return null;
  const local = jobs.filter((j) => j.kind === "local" && isActive(j));
  const cur = local.find((j) => j.state === "running" || j.state === "downloading");
  const p = cur ? jobProgress(cur) : 0;
  const gpu = gpuName(l.gpu) ?? "GPU";
  const ver = l.comfyui_version ? `ComfyUI ${l.comfyui_version.split(".").slice(0, 2).join(".")}` : "ComfyUI";
  const c = 2 * Math.PI * 7;
  return (
    <div className="gstat" ref={box}>
      <button className="gchip" type="button" aria-expanded={open} aria-label={`${gpu}, ${ver}. Show GPU status`} onClick={() => setOpen(!open)}>
        <span className="gring">
          <svg viewBox="0 0 18 18" aria-hidden><circle cx="9" cy="9" r="7" strokeDasharray={c} strokeDashoffset={c * (1 - p)} style={{ opacity: cur ? 1 : 0 }} /></svg>
          <i className={cx("dot", cur && "busy", !l.ok && "warn")} />
        </span>
        <b>{gpu}</b><span className="gv">{ver}</span>
        {cur && <span className="gp mono">{Math.round(p * 100)}%</span>}
        <I n="down" className="gcv" />
      </button>
      {open && <GpuPop l={l} cur={cur} waiting={local.length - (cur ? 1 : 0)} />}
    </div>
  );
}

function GpuPop({ l, cur, waiting }: { l: LocalStatus; cur?: Job; waiting: number }) {
  // Memory moves while a run is going; ask more often while the card is open.
  useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 3000 });
  const setQueue = useApp((s) => s.setQueue);
  const total = GB(l.vram_total), used = total ? total - GB(l.vram_free) : 0;
  const host = (u: string) => u.replace(/^https?:\/\//, "");
  return (
    <div className="gpop" role="dialog" aria-label="GPU status">
      <div className="gp-h">
        <span className="ic"><I n="cpu" /></span>
        <div><b>{gpuName(l.gpu) ?? "GPU"}</b><span>{total ? `${Math.round(total)} GB · ` : ""}local ComfyUI</span></div>
        <span className={cx("pill", cur ? "yellow" : l.ok ? "mint" : "orange")}>{cur ? "Busy" : l.ok ? "Ready" : "API v2 off"}</span>
      </div>
      {total > 0 && (
        <div className="gp-m">
          <div className="gp-l"><span>GPU memory</span><span className="mono">{used.toFixed(1)} of {total.toFixed(0)} GB</span></div>
          <div className="vram" style={{ "--v": `${Math.min(100, (used / total) * 100)}%` } as CSSProperties}><i /></div>
        </div>
      )}
      <div className="gp-rows">
        <div><span>Now</span><b>{cur ? `${cur.title} · ${Math.round(jobProgress(cur) * 100)}%` : "Idle"}</b></div>
        <div><span>Queue</span><b>{waiting > 0 ? `${waiting} waiting` : "Empty"}</b></div>
        <div><span>ComfyUI</span><b className="mono">{l.comfyui_version ?? "?"} · {host(l.comfyui_url)}</b></div>
        <div><span>Comfy API v2</span><b className="mono">{l.v2 ? `:${new URL(l.v2_url).port || "80"}${l.managed ? " · started for you" : ""}` : l.autostart && l.proxy_installed ? "starts when you run" : "not running"}</b></div>
      </div>
      <div className="gp-f">
        <button className="btn sm" type="button" onClick={() => setQueue(true)}><I n="layers" />Open queue</button>
        <a className="btn sm ghost" href="#/settings"><I n="sliders" />Settings</a>
      </div>
    </div>
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
