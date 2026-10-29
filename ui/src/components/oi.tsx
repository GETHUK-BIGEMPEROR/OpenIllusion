import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { api, type Job, type LocalStatus, type Status } from "../lib/api";
import { isActive, useJobs } from "../lib/live";
import { useApp } from "../lib/store";
import { SPRITE, type IconName } from "./sprite";
import { cx, Spinner } from "./ui";

export { cx };

/** The neon gradient, for strokes: ``stroke:url(#ng)`` in CSS. */
const NEON = '<defs><linearGradient id="ng" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#FF4FA3"/><stop offset=".5" stop-color="#9D6BFF"/><stop offset="1" stop-color="#2FD8FF"/></linearGradient></defs>';

/** The icon sprite, once per page. */
export function Sprite() {
  return <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden dangerouslySetInnerHTML={{ __html: SPRITE + NEON }} />;
}

export function I({ n, size, className, style }: { n: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg className={cx("i", className)} style={size ? { width: size, height: size, ...style } : style} aria-hidden><use href={`#i-${n}`} /></svg>;
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

/** One side of a Compare: a photo's url, or a clip (a muted loop). */
export type CompareSide = string | { url: string; kind: "image" | "video"; poster?: string | null };

/** Before/after wipe, photos or clips. Drag, or use the arrow keys. Two clips loop in step. */
export function Compare({ before, after, lb = "Before", la = "After", intro, children }: { before: CompareSide; after: CompareSide; lb?: string; la?: string; intro?: boolean; children?: ReactNode }) {
  // With intro, the result wipes in from the right once, then the slider is yours.
  const [x, setX] = useState(intro ? 100 : 50);
  const [wiping, setWiping] = useState(!!intro);
  const el = useRef<HTMLDivElement>(null);
  const vBefore = useRef<HTMLVideoElement>(null);
  const vAfter = useRef<HTMLVideoElement>(null);
  // Two clips: the result's loop leads, the input's follows it.
  useEffect(() => {
    const lead = vAfter.current, follow = vBefore.current;
    if (!lead || !follow) return;
    const sync = () => {
      if (!follow.duration) return;
      const t = lead.currentTime % follow.duration;
      if (Math.abs(follow.currentTime - t) > 0.15) follow.currentTime = t;
    };
    lead.addEventListener("timeupdate", sync);
    return () => lead.removeEventListener("timeupdate", sync);
  }, [before, after]);
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
      {side(before, lb, vBefore)}
      {side(after, la, vAfter, "after")}
      <span className="pill tg l">{lb}</span><span className="pill tg r">{la}</span>
      <div className="handle"><div className="knob"><I n="compare" /></div></div>
      {children}
    </div>
  );
}

function side(s: CompareSide, alt: string, ref: RefObject<HTMLVideoElement>, className?: string) {
  if (typeof s === "string" || s.kind === "image") return <img className={className} src={typeof s === "string" ? s : s.url} alt={alt} draggable={false} />;
  return <video ref={ref} className={className} key={s.url} src={s.url} poster={s.poster ?? undefined} muted loop playsInline autoPlay aria-label={alt} />;
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

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 30_000 });
}

/** A page's header: no visible title, since the rail already names the page; ``title`` is a hidden heading for screen
 *  readers. ``lead``: a visible start, like a back button. ``search={false}``: the page has its own search field.
 *  ``bar``: a row of filters under the header line; ``sub``: a row under that, which scrolls sideways. */
export function PageHead({ title, lead, filters, actions, sub, bar, search = true }: { title: string; lead?: ReactNode; filters?: ReactNode; actions?: ReactNode; sub?: ReactNode; bar?: ReactNode; search?: boolean }) {
  const setPalette = useApp((s) => s.setPalette);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return (
    <header className="phead">
      <h1 className="sr">{title}</h1>
      <div className="phead-row hrow">
        {lead && <div className="plead">{lead}</div>}
        <div className={bar ? "hfilters open" : "hfilters"}>{filters}</div>
        <div className="hactions">
          {actions}
          {search && <button className="icon-btn" type="button" aria-label="Search templates and results" title={`Search (${mac ? "⌘K" : "Ctrl K"})`} onClick={() => setPalette(true)}><I n="search" /></button>}
          <KeyStat />
          <GpuStat />
        </div>
      </div>
      {bar && <div className="phead-bar">{bar}</div>}
      {sub && <div className="phead-sub"><SideScroll className="hsub">{sub}</SideScroll></div>}
    </header>
  );
}

/** A row wider than its box scrolls sideways: trackpads and Shift-wheel do already, and a plain mouse wheel does
 *  too while there's room left that way. `data-start`/`data-end` say which edges have more, for the fades. */
function SideScroll({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const edges = () => {
      el.dataset.start = String(el.scrollLeft <= 1);
      el.dataset.end = String(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1);
    };
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || e.shiftKey) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0 || (e.deltaY < 0 && el.scrollLeft <= 0) || (e.deltaY > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    edges();
    el.addEventListener("scroll", edges, { passive: true });
    el.addEventListener("wheel", wheel, { passive: false });
    const ro = new ResizeObserver(edges);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { el.removeEventListener("scroll", edges); el.removeEventListener("wheel", wheel); ro.disconnect(); };
  }, []);
  return <div ref={ref} className={className}>{children}</div>;
}

const GB = (b?: number | null) => (b ? b / 1024 ** 3 : 0);

/** The local GPU in the page header: name and ComfyUI version, a ring while a run is going.
 *  Only there when a local ComfyUI answers; click for memory, the run in flight and the addresses. */
/** A header chip's card: closes on a click outside or Escape, which hands focus back to the chip. */
function usePop() {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); box.current?.querySelector("button")?.focus(); } };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", down); window.removeEventListener("keydown", key); };
  }, [open]);
  return { open, setOpen, box };
}

type KeyState = { tone: "ok" | "off" | "warn" | "bad"; word: string; pill: string; pillTone: "mint" | "orange" | "rose" | ""; say: string };

/** Where the Comfy API key stands, in the words the header and its card use. */
export function keyState(s?: Status): KeyState {
  if (!s) return { tone: "off", word: "Checking", pill: "Checking", pillTone: "", say: "Asking Comfy whether your key works." };
  const r = s.router;
  if (!s.has_key) return { tone: "off", word: "No key", pill: "Not set", pillTone: "", say: "Cloud templates need a Comfy API key. Local templates never do." };
  if (r.ok) return { tone: "ok", word: "Connected", pill: "Connected", pillTone: "mint", say: "Cloud templates run on Comfy Router and bill your Comfy account per run." };
  if (r.ok === null) return { tone: "off", word: "Checking", pill: "Checking", pillTone: "", say: "Asking Comfy whether your key works." };
  if (r.reason === "unreachable" || (r.status ?? 0) >= 500)
    return { tone: "warn", word: "Can't reach", pill: "Offline", pillTone: "orange", say: `Comfy didn't answer, so cloud runs wait. Your key is kept.${r.message ? ` ${r.message}` : ""}` };
  return { tone: "bad", word: "Key refused", pill: "Refused", pillTone: "rose", say: r.message || "Comfy refused this key. Paste a new one in Settings." };
}

/** The Comfy API key in the page header: one word for where it stands; click for the key, what it's for, and a re-check. */
export function KeyStat() {
  const status = useStatus();
  const { open, setOpen, box } = usePop();
  const k = keyState(status.data);
  return (
    <div className="gstat" ref={box}>
      <button className={cx("gchip kchip", k.tone)} type="button" aria-expanded={open} aria-label={`Comfy API: ${k.word}. Show details`} onClick={() => setOpen(!open)}>
        <span className="gring"><i className={cx("dot", k.tone === "off" && "off", k.tone === "warn" && "warn", k.tone === "bad" && "bad")} /></span>
        <I n="key" className="kic" /><b>Comfy API</b><span className="gv">{k.word}</span>
        <I n="down" className="gcv" />
      </button>
      {open && <KeyPop k={k} has={!!status.data?.has_key} />}
    </div>
  );
}

function KeyPop({ k, has }: { k: KeyState; has: boolean }) {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [checking, setChecking] = useState(false);
  const recheck = async () => {
    setChecking(true);
    try { qc.setQueryData(["status"], await api.status(true)); } catch { /* the chip keeps its last word */ } finally { setChecking(false); }
  };
  const s = settings.data;
  return (
    <div className="gpop" role="dialog" aria-label="Comfy API key">
      <div className="gp-h">
        <span className="ic key"><I n="key" /></span>
        <div><b>Comfy API key</b><span>{has && s?.key_hint ? `${s.key_hint} · ${s.key_source === "env" ? "from COMFY_API_KEY" : "kept in this browser"}` : "Not set"}</span></div>
        <span className={cx("pill", k.pillTone)}>{k.pill}</span>
      </div>
      <p className="gp-say">{k.say}</p>
      <div className="gp-rows">
        <div><span>Runs on</span><b>Comfy Router</b></div>
        <div><span>Usage</span><b>Comfy dashboard</b></div>
        <div><span>Files by link</span><b>Comfy Cloud, same key</b></div>
      </div>
      <div className="gp-f">
        {has ? <button className="btn sm" type="button" disabled={checking} onClick={() => void recheck()}>{checking ? <Spinner size={13} /> : <I n="refresh" />}Check again</button>
          : <a className="btn sm primary" href="#/settings"><I n="key" />Add key</a>}
        <a className="btn sm ghost" href="#/settings"><I n="sliders" />Settings</a>
      </div>
    </div>
  );
}

export function GpuStat() {
  const status = useStatus();
  const { data: jobs = [] } = useJobs();
  const { open, setOpen, box } = usePop();
  const l = status.data?.local;
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
        <span className={cx("pill", cur ? "hot" : l.ok ? "mint" : "orange")}>{cur ? "Busy" : l.ok ? "Ready" : "API v2 off"}</span>
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
