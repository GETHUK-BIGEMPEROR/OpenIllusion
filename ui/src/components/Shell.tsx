import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { errMsg } from "../lib/format";
import { isActive, useJobs } from "../lib/live";
import { go, href, parse, type Route } from "../lib/route";
import { cachedEngine } from "../lib/query";
import { useApp } from "../lib/store";
import { dotStyle, I, localState, useStatus } from "./oi";
import { dropIntoStudio, isMediaFile, openWithFiles } from "./Drop";
import { buildAction, workflowToBuilder } from "../screens/Builder";
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

export function Rail({ route }: { route: Route }) {
  const setQueue = useApp((s) => s.setQueue);
  const queueOpen = useApp((s) => s.queueOpen);
  const badge = useQueueBadge();
  const status = useStatus();
  const current = section(route);
  const lastStudio = useApp((s) => s.lastStudio);
  const local = localState(status.data?.local);
  const cloudOn = !!status.data?.has_key && status.data.router.ok !== false;

  // 1/2/3 jump between Explore, Create and Library when no field has focus.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey || t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      const n = NAV.find((x) => x.key === e.key);
      if (n && !document.querySelector("[role=dialog]")) go({ name: n.name === "edit" ? useApp.getState().lastStudio : n.name });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  return (
    <nav className="rail" aria-label="Main">
      <a className="logo" href={href({ name: "explore" })} aria-label="OpenIllusion home"><LogoMark /></a>
      {NAV.map((n) => (
        <a key={n.name} className="nav-btn" href={href({ name: n.name === "edit" ? lastStudio : n.name })} aria-current={current === n.name ? "page" : undefined} title={`${n.label} (${n.key})`}>
          <I n={n.icon} />{n.label}
        </a>
      ))}
      <button className="nav-btn" type="button" aria-expanded={queueOpen} onClick={() => setQueue(!queueOpen)} aria-label={badge ? `Queue, ${badge} running` : "Queue"}>
        <I n="layers" />Queue<span className="badge">{badge}</span>
      </button>
      <div className="rail-spacer" />
      <a className="rail-status" href={href({ name: "settings" })} title={`Local: ${local.title}. Cloud: ${status.data?.has_key ? "key saved" : "no API key"}.`}>
        <span className="rs"><i className={cx("dot", local.tone === "off" && "off")} style={dotStyle(local.tone)} />GPU</span>
        <span className="rs"><i className={cx("dot", cloudOn ? "violet" : "off")} />API</span>
      </a>
      <a className="nav-btn" href={href({ name: "settings" })} aria-current={current === "settings" ? "page" : undefined}><I n="sliders" />Settings</a>
    </nav>
  );
}

/** Phone: the rail becomes a tab bar with Create in the middle. */
export function TabBar({ route }: { route: Route }) {
  const setQueue = useApp((s) => s.setQueue);
  const badge = useQueueBadge();
  const current = section(route);
  const cur = (n: string) => (current === n ? "page" : undefined);
  const lastStudio = useApp((s) => s.lastStudio);
  return (
    <nav className="tabbar" aria-label="Main">
      <a className="tab" href={href({ name: "explore" })} aria-current={cur("explore")}><I n="compass" />Explore</a>
      <a className="tab" href={href({ name: "library" })} aria-current={cur("library")}><I n="library" />Library</a>
      <a className="tab create" href={href({ name: lastStudio })} aria-current={cur("edit")}><span className="fab"><I n="plus" /></span><span>Create</span></a>
      <button className="tab" type="button" onClick={() => setQueue(true)}><I n="layers" />Queue<span className="badge">{badge}</span></button>
      <a className="tab" href={href({ name: "settings" })} aria-current={cur("settings")}><I n="sliders" />Settings</a>
    </nav>
  );
}

export function LogoMark({ size = 40 }: { size?: number }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden>
      <rect width="40" height="40" rx="12" fill="#F2FF59" />
      <circle cx="20" cy="20" r="10.5" fill="none" stroke="#16101C" strokeWidth="4.5" />
      <circle cx="23.6" cy="16.4" r="3.3" fill="#16101C" />
    </svg>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismiss);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role={t.tone === "error" ? "alert" : "status"} className={cx("toast", t.tone === "error" ? "err" : t.tone === "ok" ? "ok" : "")}>
          <I n={t.tone === "error" ? "alert" : t.tone === "warn" ? "alert" : t.tone === "ok" ? "check" : "info"} style={t.tone === "warn" ? { color: "var(--orange)" } : undefined} />
          <span>{t.text}</span>
          {t.action && <button className="btn sm" type="button" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          <button className="icon-btn sm" type="button" aria-label="Dismiss" onClick={() => dismiss(t.id)}><I n="x" /></button>
        </div>
      ))}
    </div>
  );
}

/** Drop anywhere: a .illusion, an OpenIllusion output, or a link. In a studio, plain photos go to the tray. */
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
        if (await workflowToBuilder(f)) return;
        // Only a .illusion, a PNG or an MP4 can carry a recipe. In Create, any other photo or clip is an input.
        const carries = /\.(illusion|png|mp4)$/i.test(f.name);
        if (studio && isMediaFile(f) && !carries) return void dropIntoStudio(studio, files);
        try {
          setReview(await api.importFile(f));
        } catch (err) {
          if (studio && isMediaFile(f)) return void dropIntoStudio(studio, files);
          // Elsewhere a plain photo or clip can still go straight into the last template you used.
          const st = useApp.getState();
          const last = cachedEngine(st[st.lastStudio].engine);
          toast(isMediaFile(f) && last
            ? { text: `${f.name} isn't an OpenIllusion file. Use it as an input?`, tone: "warn", action: { label: `Use in ${last.label.split(" · ")[0]}`, run: () => void openWithFiles(last, files) } }
            : { text: errMsg(err), tone: "error", action: buildAction(f) });
        }
      } catch (err) {
        toast({ text: errMsg(err), tone: "error" });
      }
    };
    const reset = () => {
      depth.current = 0;
      setOver(false);
    };
    // Capture phase: inputs that handle their own drops stop propagation, and the overlay must still close.
    const on = { capture: true };
    window.addEventListener("dragenter", enter, on);
    window.addEventListener("dragleave", leave, on);
    window.addEventListener("dragover", overFn, on);
    window.addEventListener("drop", drop, on);
    window.addEventListener("dragend", reset, on);
    window.addEventListener("blur", reset);
    return () => {
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
  const [title, rest] = route === "edit" || route === "motion"
    ? ["Drop to fill the next empty input", " · or on an input or the preview to choose"]
    : route === "explore"
      ? ["Drop on a template to run it on your file", " · or anywhere to import"]
      : ["Drop to import", " · .illusion, OpenIllusion PNG or MP4, a ComfyUI workflow"];
  return (
    <div className="dropcue" role="status">
      <I n="import" />
      <span><b>{title}</b>{rest}</span>
    </div>
  );
}
