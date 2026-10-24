import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type LocalStatus, type Status } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { clock, errMsg } from "../lib/format";
import { isActive, useElapsed, useJobs } from "../lib/live";
import { go, href, parse, type Route } from "../lib/route";
import { useApp } from "../lib/store";
import { Brush, CheckCircle, Close, Download, Info, Library, Motion, Queue, Search, Sliders, XCircle, AlertTriangle } from "./Icons";
import { Logo } from "./Logo";
import { addToTray } from "./Refs";
import { Dot, Kbd, cx } from "./ui";

export const gpuName = (gpu?: string | null) => (gpu ? gpu.replace(/^cuda:\d+ /, "").replace(/ :.*$/, "").replace(/^NVIDIA (GeForce )?/, "") : null);

const NAV = [
  { name: "library", label: "Library", key: "1", Icon: Library },
  { name: "motion", label: "Motion", key: "2", Icon: Motion },
  { name: "edit", label: "Edit", key: "3", Icon: Brush },
] as const;

export function Rail({ route }: { route: Route }) {
  const setQueue = useApp((s) => s.setQueue);
  const queueOpen = useApp((s) => s.queueOpen);
  const { data: jobs = [] } = useJobs();
  const running = jobs.filter(isActive).length;
  const failed = jobs.some((j) => j.state === "failed" && j.finished && Date.now() / 1000 - j.finished < 600);
  const current = route.name === "generation" ? "library" : route.name;
  const item = (on: boolean) =>
    cx("group relative w-9 h-9 rounded-lg flex items-center justify-center border-0 mk-btn", on ? "bg-active text-text" : "text-muted hover:text-text hover:bg-white/[0.05] bg-transparent");

  // 1/2/3 jump between Library, Motion and Edit when no field has focus.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n && !document.querySelector("[role=dialog]")) go({ name: n.name });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  return (
    <nav aria-label="Main" className="shrink-0 w-14 bg-panel border-r border-line flex flex-col items-center py-2.5 gap-1 max-lg:w-full max-lg:h-12 max-lg:flex-row max-lg:px-3 max-lg:py-0 max-lg:border-r-0 max-lg:border-b">
      <a href={href({ name: "library" })} aria-label="OpenIllusion home" className="w-9 h-9 flex items-center justify-center mb-2 max-lg:mb-0 max-lg:mr-2 rounded-lg hover:bg-white/[0.04]"><Logo size={26} /></a>
      {NAV.map(({ name, label, key, Icon }) => (
        <a key={name} href={href({ name })} aria-label={label} aria-current={current === name ? "page" : undefined} className={item(current === name)}>
          {current === name && <span aria-hidden className="absolute -left-[10px] top-2 bottom-2 w-[3px] rounded-r-full bg-yellow max-lg:hidden" />}
          <Icon size={18} />
          <Tip>{label} <Kbd className="ml-1">{key}</Kbd></Tip>
        </a>
      ))}
      <span aria-hidden className="w-6 h-px bg-line my-1 max-lg:hidden" />
      <button type="button" aria-label={running ? `Queue, ${running} running` : "Queue"} aria-expanded={queueOpen} onClick={() => setQueue(!queueOpen)} className={item(queueOpen)}>
        <Queue size={18} />
        {running > 0 ? (
          <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-[16px] h-4 px-1 rounded-full bg-orange text-ink text-[10px] font-bold leading-4 text-center tabular">{running}</span>
        ) : failed ? (
          <span aria-hidden className="absolute right-1.5 top-1.5 w-2 h-2 rounded-full bg-rose ring-2 ring-panel" />
        ) : null}
        <Tip>Queue</Tip>
      </button>
      <a href={href({ name: "settings" })} aria-label="Settings" aria-current={current === "settings" ? "page" : undefined} className={cx(item(current === "settings"), "mt-auto max-lg:mt-0 max-lg:ml-auto")}>
        {current === "settings" && <span aria-hidden className="absolute -left-[10px] top-2 bottom-2 w-[3px] rounded-r-full bg-yellow max-lg:hidden" />}
        <Sliders size={18} />
        <Tip>Settings</Tip>
      </a>
    </nav>
  );
}

function Tip({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 -translate-y-1/2 h-7 px-2 rounded-md bg-active shadow-pop text-xs text-text whitespace-nowrap inline-flex items-center opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity delay-150 z-40 max-lg:hidden">
      {children}
    </span>
  );
}

export function TopBar({ crumbs, right, onImport }: { crumbs: { label: ReactNode; href?: string }[]; right?: ReactNode; onImport: () => void }) {
  const search = useApp((s) => s.search);
  const setSearch = useApp((s) => s.setSearch);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
  return (
    <header className="shrink-0 h-12 flex items-center gap-3 px-4 border-b border-line bg-bg">
      <nav aria-label="Breadcrumb" className="flex-1 min-w-0">
        <ol className="m-0 p-0 list-none flex items-center gap-1.5 min-w-0 text-md">
          {crumbs.map((c, i) => {
            const last = i === crumbs.length - 1;
            return (
              <li key={i} className={cx("flex items-center gap-1.5 min-w-0", !last && "shrink-0")}>
                {c.href && !last ? <a href={c.href} className="text-muted hover:text-text font-medium">{c.label}</a>
                  : <span aria-current={last ? "page" : undefined} className={cx("truncate", last ? "text-text font-semibold" : "text-muted font-medium")}>{c.label}</span>}
                {!last && <span aria-hidden className="text-faint">/</span>}
              </li>
            );
          })}
        </ol>
      </nav>
      {right}
      <label className="field group w-[260px] max-md:w-[160px] max-sm:w-[128px] h-8 flex items-center gap-2 pl-2.5 pr-1.5 text-muted cursor-text">
        <Search size={14} />
        <span className="sr-only">Search generations</span>
        <input
          ref={ref}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go({ name: "library", shelf: "mine" }); if (e.key === "Escape") { setSearch(""); ref.current?.blur(); } }}
          onFocus={() => { if (parse(location.hash).name !== "library") go({ name: "library", shelf: "mine" }); }}
          placeholder="Search generations"
          className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-text"
        />
        {search ? (
          <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="mk-btn w-5 h-5 rounded border-0 bg-transparent text-muted hover:text-text flex items-center justify-center"><Close size={10} /></button>
        ) : <Kbd className="max-md:hidden">{mac ? "⌘K" : "Ctrl K"}</Kbd>}
      </label>
      <button type="button" onClick={onImport} aria-label="Import" title="Import a .illusion file, a PNG or MP4 with a recipe, or a generation JSON"
        className="mk-btn h-8 inline-flex items-center gap-1.5 px-2.5 max-sm:w-8 max-sm:px-0 max-sm:justify-center rounded-lg border-0 bg-raised shadow-line text-sm font-medium hover:bg-active">
        <Download size={14} /><span className="max-sm:hidden">Import</span>
      </button>
    </header>
  );
}

function cloudState(s?: Status): { tone: "ok" | "warn" | "bad" | "off"; text: string; title: string } {
  if (!s) return { tone: "off", text: "Checking", title: "Checking Comfy Router" };
  if (!s.has_key) return { tone: "off", text: "No key", title: "Add a Comfy API key in Settings to run cloud templates" };
  const r = s.router;
  if (r.ok) return { tone: "ok", text: "Connected", title: "Comfy Router reachable with your key" };
  if (r.ok === false) return { tone: "bad", text: r.reason === "unreachable" ? "Unreachable" : "Key refused", title: r.message ?? r.reason ?? "Router error" };
  return { tone: "off", text: "Not tested", title: "Key saved, not tested yet" };
}

export function localState(l?: LocalStatus): { tone: "ok" | "warn" | "bad" | "off"; text: string; title: string } {
  if (!l) return { tone: "off", text: "Checking", title: "Looking for ComfyUI" };
  if (l.upstream_match === false) return { tone: "warn", text: "Two ComfyUIs", title: `Comfy API v2 runs on ${l.upstream_seen ?? l.upstream}, not ${l.comfyui_url}` };
  if (!l.comfyui) return { tone: "off", text: "Offline", title: `No ComfyUI at ${l.comfyui_url}` };
  const gpu = gpuName(l.gpu);
  if (l.ok) return { tone: "ok", text: gpu ?? "Ready", title: `ComfyUI ${l.comfyui_version ?? ""} and Comfy API v2 up${gpu ? ` · ${gpu}` : ""}` };
  return { tone: "warn", text: gpu ?? "ComfyUI up", title: `ComfyUI up · Comfy API v2 not running at ${l.v2_url}${l.autostart && l.proxy_installed ? " (starts automatically)" : ""}` };
}

/** Bottom status bar: what's running, and whether cloud and local are reachable. */
export function StatusBar() {
  const { data: jobs = [] } = useJobs();
  const { data: status } = useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 30_000 });
  const setQueue = useApp((s) => s.setQueue);
  const active = jobs.filter(isActive);
  const first = active.find((j) => j.state === "running") ?? active[0];
  const last = jobs.find((j) => !isActive(j));
  const t = useElapsed(first?.started ?? first?.created);
  const cloud = cloudState(status);
  const local = localState(status?.local);
  const pct = first?.progress?.value != null ? Math.round(first.progress.value * 100) : null;
  return (
    <footer className="shrink-0 h-7 flex items-center gap-1 px-2 border-t border-line bg-panel text-xs text-muted">
      <button type="button" onClick={() => setQueue(true)} className="mk-btn h-6 min-w-0 flex items-center gap-2 px-2 rounded-md border-0 bg-transparent hover:bg-white/[0.05] hover:text-text text-left">
        {first ? (
          <>
            <Dot tone="busy" pulse />
            <span className="text-text font-medium whitespace-nowrap">{active.length} running</span>
            <span className="truncate">{first.title}</span>
            <span className="font-mono tabular text-soft">{clock(t, false)}</span>
            {pct != null && (
              <span className="flex items-center gap-1.5">
                <span className="w-16 h-1 rounded-full bg-white/10 overflow-hidden"><span className="block h-full bg-yellow transition-[width]" style={{ width: `${pct}%` }} /></span>
                <span className="font-mono tabular">{pct}%</span>
              </span>
            )}
          </>
        ) : last ? (
          <>
            <Dot tone={last.state === "done" ? "ok" : last.state === "cancelled" ? "off" : "bad"} />
            <span className="whitespace-nowrap">Idle</span>
            <span className="truncate text-faint">
              Last: {last.title} · {last.state === "done" ? "done" : describeFailure(last.state, last.error, last.detail).title.toLowerCase()}
            </span>
          </>
        ) : (
          <><Dot tone="off" /><span>Idle</span></>
        )}
      </button>
      <span className="ml-auto" />
      <a href={href({ name: "settings" })} title={cloud.title} className="h-6 flex items-center gap-1.5 px-2 rounded-md text-muted hover:text-text hover:bg-white/[0.05] whitespace-nowrap">
        <Dot tone={cloud.tone} />Cloud <span className="text-faint max-sm:hidden">{cloud.text}</span>
      </a>
      <a href={href({ name: "settings" })} title={local.title} className="h-6 flex items-center gap-1.5 px-2 rounded-md text-muted hover:text-text hover:bg-white/[0.05] whitespace-nowrap">
        <Dot tone={local.tone} />Local <span className="text-faint max-sm:hidden">{local.text}</span>
      </a>
      {status?.version && <span className="px-2 font-mono text-faint max-md:hidden">v{status.version}</span>}
    </footer>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div aria-live="polite" className="fixed bottom-10 right-4 z-[60] flex flex-col gap-2 items-end pointer-events-none max-sm:left-4">
      {toasts.map((t) => {
        const Icon = t.tone === "error" ? XCircle : t.tone === "warn" ? AlertTriangle : t.tone === "ok" ? CheckCircle : Info;
        const color = t.tone === "error" ? "text-rose" : t.tone === "warn" ? "text-orange" : t.tone === "ok" ? "text-mint" : "text-violet-light";
        return (
          <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className="pointer-events-auto w-[360px] max-sm:w-full flex items-start gap-2.5 pl-3 pr-1.5 py-2 rounded-lg bg-surface shadow-float animate-rise text-sm">
            <Icon size={15} className={cx("shrink-0 mt-[2px]", color)} />
            <span className="flex-1 min-w-0 py-px text-soft leading-[18px]">{t.text}</span>
            {t.action && (
              <button type="button" onClick={() => { t.action!.run(); dismiss(t.id); }} className="mk-btn h-6 px-2 rounded-md border-0 bg-white/[0.06] hover:bg-white/10 text-text font-medium text-xs shrink-0">{t.action.label}</button>
            )}
            <button type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)} className="mk-btn w-6 h-6 rounded-md border-0 bg-transparent text-muted hover:text-text flex items-center justify-center shrink-0"><Close size={10} /></button>
          </div>
        );
      })}
    </div>
  );
}

/** Full-window drop target: a .illusion, an OpenIllusion output, or a link. In a studio, plain photos go to the tray. */
export function DropOverlay() {
  const [over, setOver] = useState(false);
  const setReview = useApp((s) => s.setReview);
  const toast = useApp((s) => s.toast);
  const depth = useRef(0);
  useEffect(() => {
    const isOurs = (e: DragEvent) => {
      // Inputs (reference trays, the driving video card) handle their own drops.
      const t = e.target as HTMLElement | null;
      return !t?.closest?.("[data-own-drop]");
    };
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files") && !e.dataTransfer?.types.includes("text/uri-list")) return;
      depth.current++;
      if (isOurs(e)) setOver(true);
    };
    const leave = () => {
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (isOurs(e)) e.preventDefault();
      setOver(isOurs(e));
    };
    const drop = async (e: DragEvent) => {
      depth.current = 0;
      setOver(false);
      if (!isOurs(e) || e.defaultPrevented) return;
      e.preventDefault();
      try {
        const f = e.dataTransfer?.files?.[0];
        const studio = parse(window.location.hash).name;
        const toTray = (studio === "edit" || studio === "motion") && !!f && f.type.startsWith("image/");
        // Only PNGs can carry a recipe; in a studio, any other photo is a reference.
        if (toTray && f.type !== "image/png") {
          addToTray(studio, [await api.upload(f)]);
          return;
        }
        if (f) {
          try {
            setReview(await api.importFile(f));
          } catch (err) {
            if (!toTray) throw err;
            addToTray(studio, [await api.upload(f)]);
          }
        } else {
          const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
          if (text) setReview(await api.importText(text));
        }
      } catch (err) {
        toast({ text: errMsg(err), tone: "error" });
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, [setReview, toast]);
  if (!over) return null;
  const studio = parse(window.location.hash).name;
  const inStudio = studio === "edit" || studio === "motion";
  return (
    <div className="fixed inset-0 z-[70] p-3 pointer-events-none animate-fade">
      <div className="w-full h-full rounded-xl bg-deep/85 backdrop-blur-sm border-2 border-dashed border-violet/60 flex flex-col items-center justify-center gap-3 text-center">
        <Logo size={40} />
        <span className="text-lg font-semibold">{inStudio ? "Drop to add to the tray" : "Drop to import"}</span>
        <span className="text-sm text-muted max-w-[420px]">
          {inStudio ? "Photos land in the reference tray. A .illusion file or an OpenIllusion PNG opens for review instead." : "A .illusion file, an OpenIllusion PNG or MP4, or a generation link. Nothing runs until you review it."}
        </span>
      </div>
    </div>
  );
}
