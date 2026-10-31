import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { errMsg } from "../lib/format";
import { landImport } from "../lib/imports";
import { isActive, useJobs } from "../lib/live";
import { go, href, parse, type Route } from "../lib/route";
import { cachedEngine } from "../lib/query";
import { useApp } from "../lib/store";
import { GpuStat, I, KeyStat } from "./oi";
import { dropIntoStudio, isAudio, isMediaFile, openWithFiles, pageDrop, pageDropHint } from "./Drop";
import { buildAction, workflowToBuilder } from "../screens/builder/Builder";
import { isBackup, openBackup } from "../screens/RestoreReview";
import { cx } from "./ui";

export { gpuName, localState } from "./oi";

const NAV = [
  { name: "explore", label: "Explore", key: "1", icon: "compass" },
  { name: "edit", label: "Create", key: "2", icon: "wand" },
  { name: "library", label: "Library", key: "3", icon: "library" },
  { name: "build", label: "Build", key: "4", icon: "graph" },
] as const;

const section = (r: Route) => (r.name === "generation" ? "library" : r.name === "motion" ? "edit" : r.name);

function useQueueBadge() {
  const { data: jobs = [] } = useJobs();
  const running = jobs.filter(isActive).length;
  return running ? String(running) : "";
}

/** The top bar: the app's name, its four places, then search, the two connections, the queue, Trash and Settings.
 *  Hidden on a phone, where the tab bar takes over and each page header carries the connection chips. */
export function TopBar({ route }: { route: Route }) {
  const setQueue = useApp((s) => s.setQueue);
  const queueOpen = useApp((s) => s.queueOpen);
  const setPalette = useApp((s) => s.setPalette);
  const badge = useQueueBadge();
  const current = section(route);
  const lastStudio = useApp((s) => s.lastStudio);
  const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

  // 1/2/3/4 jump between Explore, Create, Library and Build when no field has focus.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n && !document.querySelector('[role="dialog"]:not([aria-hidden="true"]):not([inert]):not([hidden])')) go({ name: n.name === "edit" ? useApp.getState().lastStudio : n.name });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  return (
    <header className="topbar">
      <a className="brand" href={href({ name: "explore" })} aria-label="OpenIllusion home"><LogoMark size={26} /><span>OpenIllusion</span></a>
      <nav className="tnav" aria-label="Main">
        {NAV.map((n) => (
          <a key={n.name} href={href({ name: n.name === "edit" ? lastStudio : n.name })} aria-current={current === n.name ? "page" : undefined} title={`${n.label} (${n.key})`}>
            <I n={n.icon} /><span>{n.label}</span>
          </a>
        ))}
      </nav>
      <div className="tright">
        <button className="tsearch" type="button" onClick={() => setPalette(true)} aria-label="Search templates and results" aria-keyshortcuts={mac ? "Meta+K" : "Control+K"}>
          <I n="search" /><span>Search or jump to</span><kbd aria-hidden>{mac ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <KeyStat />
        <GpuStat />
        <span className="tsep" aria-hidden />
        <button className="tbtn" type="button" aria-expanded={queueOpen} onClick={() => setQueue(!queueOpen)} aria-label={badge ? `Queue, ${badge} running` : "Queue"}>
          <I n="layers" /><span className="tl">Queue</span><span className="badge">{badge}</span>
        </button>
        <a className="tbtn icon" href={href({ name: "trash" })} aria-current={current === "trash" ? "page" : undefined} aria-label="Trash" title="Deleted generations, kept 7 days"><I n="trash" /></a>
        <a className="tbtn icon" href={href({ name: "settings" })} aria-current={current === "settings" ? "page" : undefined} aria-label="Settings" title="Settings"><I n="sliders" /></a>
      </div>
    </header>
  );
}

/** The top bar's other pages, under More on a phone. */
const MORE = [
  { name: "build", label: "Build a template", icon: "graph" },
  { name: "trash", label: "Trash", icon: "trash" },
  { name: "settings", label: "Settings", icon: "sliders" },
] as const;

/** Phone: the top bar becomes a tab bar with Create in the middle; the rest is under More. */
export function TabBar({ route }: { route: Route }) {
  const setQueue = useApp((s) => s.setQueue);
  const badge = useQueueBadge();
  const current = section(route);
  const cur = (n: string) => (current === n ? "page" : undefined);
  const lastStudio = useApp((s) => s.lastStudio);
  const [more, setMore] = useState(false);
  const moreButton = useRef<HTMLButtonElement>(null);
  const moreMenu = useRef<HTMLDivElement>(null);
  useEffect(() => setMore(false), [current]);
  useEffect(() => {
    if (!more) return;
    const frame = requestAnimationFrame(() => moreMenu.current?.querySelector<HTMLAnchorElement>("a")?.focus());
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setMore(false);
        moreButton.current?.focus();
      }
    };
    window.addEventListener("keydown", on);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", on); };
  }, [more]);
  const inMore = MORE.some((m) => m.name === current);
  const moreLabel = current === "build" ? "Builder" : MORE.find((m) => m.name === current)?.label ?? "More";
  const moveInMore = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!moreMenu.current) return;
    const items = [...moreMenu.current.querySelectorAll<HTMLAnchorElement>("a")];
    const at = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (e.key === "Tab") {
      const leaving = (e.shiftKey && at === 0) || (!e.shiftKey && at === items.length - 1);
      if (leaving) {
        e.preventDefault();
        setMore(false);
        requestAnimationFrame(() => moreButton.current?.focus());
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    e.preventDefault();
    items[next]?.focus();
  };
  return (
    <nav className="tabbar" aria-label="Main">
      {more && <button className="tabmore-scrim" type="button" aria-label="Close" onClick={() => { setMore(false); requestAnimationFrame(() => moreButton.current?.focus()); }} />}
      {more && (
        <div className="tabmore" id="tabmore" role="menu" ref={moreMenu} onKeyDown={moveInMore}>
          {MORE.map((m) => (
            <a key={m.name} role="menuitem" href={href({ name: m.name })} aria-current={cur(m.name)} onClick={() => setMore(false)}><I n={m.icon} />{m.label}</a>
          ))}
        </div>
      )}
      <a className="tab" href={href({ name: "explore" })} aria-current={cur("explore")}><I n="compass" />Explore</a>
      <a className="tab" href={href({ name: "library" })} aria-current={cur("library")}><I n="library" />Library</a>
      <a className="tab create" href={href({ name: lastStudio })} aria-current={cur("edit")}><span className="fab"><I n="plus" /></span><span>Create</span></a>
      <button className="tab" type="button" onClick={() => setQueue(true)}><I n="layers" />Queue<span className="badge">{badge}</span></button>
      <button ref={moreButton} className="tab" type="button" aria-haspopup="menu" aria-expanded={more} aria-controls="tabmore" aria-current={inMore ? "page" : undefined} onClick={() => setMore(!more)}><I n="more" />{moreLabel}</button>
    </nav>
  );
}

export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg className="logomark" viewBox="0 0 24 24" width={size} height={size} aria-hidden>
      <defs><linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#FF4FA3" /><stop offset=".55" stopColor="#B36BFF" /><stop offset="1" stopColor="#4FC3FF" /></linearGradient></defs>
      <circle cx="9" cy="12" r="6.2" fill="none" stroke="url(#logo-g)" strokeWidth="2.2" />
      <circle cx="15" cy="12" r="6.2" fill="none" stroke="url(#logo-g)" strokeWidth="2.2" />
    </svg>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className={cx("toast", t.tone === "error" ? "err" : t.tone === "ok" ? "ok" : "", t.closing && "closing")}>
          <I n={t.tone === "error" ? "alert" : t.tone === "warn" ? "alert" : t.tone === "ok" ? "check" : "info"} style={t.tone === "warn" ? { color: "var(--orange)" } : undefined} />
          <span>{t.text}</span>
          {t.action && <button className="btn sm" type="button" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          <button className="icon-btn sm" type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}><I n="x" /></button>
        </div>
      ))}
    </div>
  );
}

/** Drop anywhere: a .illusion, a backup, an OpenIllusion output, or a link. In a studio, plain photos go to the tray. */
export function DropOverlay() {
  const [over, setOver] = useState(false);
  const setReview = useApp((s) => s.setReview);
  const toast = useApp((s) => s.toast);
  const depth = useRef(0);
  // A drag that began on this page (selected text, a picture, a link) isn't an import.
  const inside = useRef(false);
  useEffect(() => {
    const isOurs = (e: DragEvent) => {
      // Inputs (reference trays, the driving video card) handle their own drops.
      const t = e.target as HTMLElement | null;
      return !t?.closest?.("[data-own-drop]");
    };
    const fromOutside = (e: DragEvent) =>
      !inside.current && !!e.dataTransfer && (e.dataTransfer.types.includes("Files") || e.dataTransfer.types.includes("text/uri-list"));
    const start = () => { inside.current = true; };
    const enter = (e: DragEvent) => {
      if (!fromOutside(e)) return;
      depth.current++;
      if (isOurs(e)) setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!fromOutside(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setOver(false);
    };
    const overFn = (e: DragEvent) => {
      if (!fromOutside(e)) return;
      // Always: a file nothing takes would otherwise open in the tab, and the page would be gone.
      e.preventDefault();
      // Inputs that handle their own drops decide for themselves; a busy one just ignores the file.
      if (isOurs(e)) e.dataTransfer!.dropEffect = "copy";
      setOver(isOurs(e));
    };
    const drop = async (e: DragEvent) => {
      depth.current = 0;
      setOver(false);
      if (!fromOutside(e)) return void (inside.current = false);
      e.preventDefault();
      if (!isOurs(e)) return;
      const files = [...(e.dataTransfer?.files ?? [])];
      const route = parse(window.location.hash).name;
      const studio = route === "edit" || route === "motion" ? route : null;
      try {
        const f = files[0];
        if (!f) {
          const text = e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain");
          if (text) setReview(await api.importText(text));
          return;
        }
        if (isBackup(f)) return void openBackup(f);
        if (await workflowToBuilder(f)) return;
        // A page with inputs of its own (the Builder) fills them with photos, clips and sounds.
        if (files.some((x) => isMediaFile(x) || isAudio(x)) && pageDrop(files)) return;
        // Only a .illusion, a PNG or an MP4 can carry a recipe. In Create, any other photo or clip is an input.
        const carries = /\.(illusion|png|mp4)$/i.test(f.name);
        if (studio && isMediaFile(f) && !carries) return void dropIntoStudio(studio, files);
        try {
          landImport(await api.importFile(f));
        } catch (err) {
          if (studio && isMediaFile(f)) return void dropIntoStudio(studio, files);
          // Elsewhere a plain photo or clip can still go straight into the last template you used.
          const st = useApp.getState();
          const last = cachedEngine(st[st.lastStudio].engine);
          toast(isMediaFile(f) && last
            ? { text: `${f.name} isn't an OpenIllusion file. Use it as an input?`, tone: "warn", action: { label: `Use in ${last.label}`, run: () => void openWithFiles(last, files) } }
            : { text: errMsg(err), tone: "error", action: buildAction(f) });
        }
      } catch (err) {
        toast({ text: errMsg(err), tone: "error" });
      }
    };
    const reset = () => {
      depth.current = 0;
      inside.current = false;
      setOver(false);
    };
    // Capture phase: inputs that handle their own drops stop propagation, and the overlay must still close.
    const on = { capture: true };
    window.addEventListener("dragstart", start, on);
    window.addEventListener("dragenter", enter, on);
    window.addEventListener("dragleave", leave, on);
    window.addEventListener("dragover", overFn, on);
    window.addEventListener("drop", drop, on);
    window.addEventListener("dragend", reset, on);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("dragstart", start, on);
      window.removeEventListener("dragenter", enter, on);
      window.removeEventListener("dragleave", leave, on);
      window.removeEventListener("dragover", overFn, on);
      window.removeEventListener("drop", drop, on);
      window.removeEventListener("dragend", reset, on);
      window.removeEventListener("blur", reset);
    };
  }, [setReview, toast]);
  if (!over) return null;
  // A hint, not a cover: the inputs under the cursor stay visible and light up themselves.
  const route = parse(window.location.hash).name;
  const own = pageDropHint();
  const [title, rest] = own ? [own, " · or a ComfyUI workflow to start over"]
    : route === "edit" || route === "motion"
    ? ["Drop to fill the next empty input", " · or on an input or the preview to choose"]
    : route === "explore"
      ? ["Drop on a template to run it on your file", " · or anywhere to import"]
      : ["Drop to import", " · a template or generation .illusion, a backup, OpenIllusion PNG or MP4, a ComfyUI workflow"];
  return (
    <div className="dropcue" role="status">
      <I n="import" />
      <span><b>{title}</b>{rest}</span>
    </div>
  );
}
