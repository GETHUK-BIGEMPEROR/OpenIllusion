import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Masonry } from "../components/Masonry";
import { EmptyBox, I, PageHead, useStatus } from "../components/oi";
import type { IconName } from "../components/sprite";
import { TemplateCard, tplModel } from "../components/TemplateCard";
import { TemplateInspector } from "../components/TemplateInspector";
import { useFileDrop } from "../components/Drop";
import { cx, Spinner } from "../components/ui";
import { api, type EngineInfo } from "../lib/api";
import { ago, errMsg } from "../lib/format";
import { landImport } from "../lib/imports";
import { go, href } from "../lib/route";
import { useApp } from "../lib/store";
import { templateReadiness, useLocalReadiness } from "../lib/readiness";

type Kind = "all" | "edit" | "motion";
type Takes = "" | "image" | "video" | "audio" | "words";
type Sort = "featured" | "recent" | "newest" | "most" | "az";
type Filters = { q: string; kind: Kind; model: string; takes: Takes; sort: Sort; source: "" | "local" | "cloud"; ready: boolean };
// Search, filters and order outlive a trip to Create and back. Recently used first: what you ran last, then the rest as featured.
const last: Filters = { q: "", kind: "all", model: "", takes: "", sort: "recent", source: "", ready: false };

// Mixed shapes, so the placeholder wall looks like the one that replaces it.
const SKELETON = [0.8, 0.75, 0.8, 1, 0.66, 0.8, 1.33, 0.75].map((aspect, i) => ({ key: String(i), aspect }));

const TAKES: { v: Takes; label: string; icon: IconName }[] = [
  { v: "image", label: "A photo", icon: "image" },
  { v: "video", label: "A clip", icon: "film" },
  { v: "audio", label: "A sound", icon: "sound" },
  { v: "words", label: "Words only", icon: "pencil" },
];
const SORTS: { v: Sort; label: string; say: string }[] = [
  { v: "featured", label: "Featured", say: "Shipped ones first" },
  { v: "recent", label: "Recently used", say: "What you ran last" },
  { v: "newest", label: "Newest", say: "Newest to this app: yours, or shipped" },
  { v: "most", label: "Most used", say: "What you run most" },
  { v: "az", label: "A to Z", say: "By name" },
];

/** What a template takes from you: a photo, a clip, a sound, or only words. */
function takes(e: EngineInfo, t: Takes): boolean {
  const slots = (e.inputs ?? []).map((x) => x.slot.split(":")[0]);
  return t === "" || (t === "words" ? !slots.length : slots.includes(t));
}

/** Everything a search can hit, weighted: the name counts most, then the model, then what it says and its prompt. */
function haystack(e: EngineInfo): [string, number][] {
  return [
    [e.label.split(" · ")[0], 4],
    [`${tplModel(e)} ${e.provider} ${e.model ?? ""} ${e.kind === "local" ? "local gpu comfyui" : "cloud router"}`, 2],
    [e.blurb, 1],
    [e.defaults?.prompt ?? "", 0.5],
  ].map(([s, w]) => [String(s).toLowerCase(), w as number]);
}

/** How well `e` matches every word of the search; 0 when one word is missing. */
function score(e: EngineInfo, words: string[]): number {
  if (!words.length) return 1;
  const hay = haystack(e);
  let total = 0;
  for (const w of words) {
    const hit = Math.max(0, ...hay.map(([s, wt]) => (s.includes(w) ? wt * (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(s) ? 1.5 : 1) : 0)));
    if (!hit) return 0;
    total += hit;
  }
  return total;
}

/** Every template as one wall, photos and videos, local and cloud together. Search and filters on top; click runs it in Create, (i) opens its details. */
export function Explore({ t, source }: { t?: string; source?: "local" | "cloud" }) {
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const status = useStatus();
  const openTemplate = useApp((s) => s.openTemplate);
  const [f, setF] = useState<Filters>(() => ({ ...last, ...(source ? { source } : {}) }));
  const set = (p: Partial<Filters>) => setF((x) => ({ ...x, ...p }));
  useEffect(() => { Object.assign(last, f); }, [f]);
  useEffect(() => { if (source) set({ source, ready: false }); }, [source]);

  // Explore shows what's published; a draft from the Builder waits in the Queue until a tested run publishes it.
  const every = useMemo(() => (engines.data ?? []).filter((e) => !e.hidden && !e.draft), [engines.data]);
  const checks = useLocalReadiness(every, status.data);
  const readiness = (e: EngineInfo) => templateReadiness(e, status.data, checks.data, checks.isError);

  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const scores = useMemo(() => new Map(every.map((e) => [e.id, score(e, words)])), [every, f.q]); // words come from f.q
  // Each filter's counts follow every other filter, so a number always says what picking it shows.
  const pass = (e: EngineInfo, skip?: keyof Filters) =>
    (scores.get(e.id) ?? 0) > 0
    && (skip === "kind" || f.kind === "all" || e.mode === f.kind)
    && (skip === "model" || !f.model || tplModel(e) === f.model)
    && (skip === "takes" || takes(e, f.takes))
    && (skip === "source" || !f.source || e.kind === f.source)
    && (skip === "ready" || !f.ready || readiness(e).state === "ready");
  const without = (k: keyof Filters) => every.filter((e) => pass(e, k));

  const models = useMemo(() => {
    const m = new Map<string, { local: boolean; cloud: boolean }>();
    for (const e of every) {
      const x = m.get(tplModel(e)) ?? { local: false, cloud: false };
      m.set(tplModel(e), { local: x.local || e.kind === "local", cloud: x.cloud || e.kind === "cloud" });
    }
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [every]);
  const byModel = without("model");
  const byTakes = without("takes");
  const byKind = without("kind");
  const featured = (a: EngineInfo, b: EngineInfo) => Number(b.curated) - Number(a.curated) || Number(b.kind === "local") - Number(a.kind === "local");
  const order: Record<Sort, (a: EngineInfo, b: EngineInfo) => number> = {
    featured: (a, b) => (words.length ? (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) : 0) || featured(a, b),
    recent: (a, b) => (b.used_at ?? 0) - (a.used_at ?? 0) || featured(a, b),
    newest: (a, b) => (b.added ?? 0) - (a.added ?? 0) || featured(a, b),
    most: (a, b) => (b.uses ?? 0) - (a.uses ?? 0) || featured(a, b),
    az: (a, b) => a.label.localeCompare(b.label),
  };
  const shown = every.filter((e) => pass(e)).sort(order[f.sort]);
  const tiles = shown.map((e) => ({ key: e.id, aspect: e.cover ? e.cover_aspect : undefined, e }));
  // Sorting context stays in the model tooltip rather than competing with the artwork.
  const hint = (e: EngineInfo): { text: string; off?: boolean } | undefined =>
    f.sort === "recent" ? (e.used_at ? { text: ago(e.used_at) } : { text: "Not run yet", off: true })
      : f.sort === "most" ? (e.uses ? { text: e.uses === 1 ? "1 run" : `${e.uses} runs` } : { text: "Not run yet", off: true })
        : f.sort === "newest" && e.added ? { text: ago(e.added) } : undefined;
  const narrowed = !!(f.q || f.kind !== "all" || f.model || f.takes || f.source || f.ready);
  const clear = () => set({ q: "", kind: "all", model: "", takes: "", source: "", ready: false });

  const locked = (e: EngineInfo) => readiness(e).state === "setup" ? readiness(e).reason : null;
  const use_ = (e: EngineInfo) => { openTemplate(e.mode, e.id); go({ name: e.mode }); };

  // The panel keeps showing the last template while it slides shut.
  const open = every.find((e) => e.id === t);
  const shownInPanel = useRef<EngineInfo | undefined>(undefined);
  const inspector = useRef<HTMLElement>(null);
  const exploreScroll = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  const [phoneInspector, setPhoneInspector] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  if (open) shownInPanel.current = open;
  const panel = open ?? shownInPanel.current;
  const isOpen = !!open;
  const inspect = (id?: string) => {
    if (id && !open) returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    go({ name: "explore", t: id });
  };
  const close = () => inspect();
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const sync = () => setPhoneInspector(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const el = inspector.current;
    if (!el) return;
    const tabbar = document.querySelector<HTMLElement>(".tabbar");
    const focusable = () => [...el.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.getClientRects().length > 0 && !node.closest('[inert],[aria-hidden="true"]'));
    const focusFirst = () => focusable()[0]?.focus();
    el.toggleAttribute("inert", !isOpen);
    if (isOpen && phoneInspector) el.setAttribute("aria-modal", "true");
    else el.removeAttribute("aria-modal");
    exploreScroll.current?.toggleAttribute("inert", isOpen && phoneInspector);
    tabbar?.toggleAttribute("inert", isOpen && phoneInspector);
    if (isOpen && (!wasOpen.current || (phoneInspector && !el.contains(document.activeElement)))) {
      requestAnimationFrame(focusFirst);
    } else if (!isOpen && wasOpen.current) {
      const target = returnFocus.current?.isConnected ? returnFocus.current : exploreScroll.current?.querySelector<HTMLElement>(".xsearch input,.card-use,a[href],button");
      returnFocus.current = null;
      requestAnimationFrame(() => target?.focus());
    }
    const contain = (event: KeyboardEvent) => {
      if (!isOpen || !phoneInspector || event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && (document.activeElement === first || !el.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !el.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    if (isOpen) el.addEventListener("keydown", contain);
    wasOpen.current = isOpen;
    return () => {
      el.removeEventListener("keydown", contain);
      exploreScroll.current?.removeAttribute("inert");
      tabbar?.removeAttribute("inert");
    };
  }, [isOpen, phoneInspector]);

  const kindN = (k: Kind) => byKind.filter((e) => k === "all" || e.mode === k).length;
  const bar = (
    <div className="xbar">
      <div className="seg" role="group" aria-label="What it makes">
        <button type="button" aria-pressed={f.kind === "all"} onClick={() => set({ kind: "all" })}>All<span className="n">{kindN("all")}</span></button>
        <button type="button" aria-pressed={f.kind === "edit"} onClick={() => set({ kind: "edit" })}><I n="image" />Photo<span className="n">{kindN("edit")}</span></button>
        <button type="button" aria-pressed={f.kind === "motion"} onClick={() => set({ kind: "motion" })}><I n="film" />Video<span className="n">{kindN("motion")}</span></button>
      </div>
      <Facet label="Runs on" value={f.source === "local" ? "Local" : f.source === "cloud" ? "Cloud" : null} icon="layers">
        {(done) => <>
          <Opt on={!f.source} n={without("source").length} onPick={() => { set({ source: "" }); done(); }}>Local and cloud</Opt>
          <Opt on={f.source === "local"} n={without("source").filter(e => e.kind === "local").length} icon="cpu" say="Your ComfyUI and hardware" onPick={() => { set({ source: "local" }); done(); }}>Local</Opt>
          <Opt on={f.source === "cloud"} n={without("source").filter(e => e.kind === "cloud").length} icon="cloud" say="Comfy Router · API key required" onPick={() => { set({ source: "cloud" }); done(); }}>Cloud</Opt>
        </>}
      </Facet>
      <button type="button" className={cx("xfacet xready", f.ready && "on")} aria-pressed={f.ready} onClick={() => set({ ready: !f.ready })}
        title="Connection, nodes and models checked. Review inputs in Create."><I n="check" size={14} />Ready to run<span className="mono">{without("ready").filter(e => readiness(e).state === "ready").length}</span></button>
      <Facet label="Model" value={f.model || null} icon="cpu">
        {(done) => (
          <>
            <Opt on={!f.model} n={byModel.length} onPick={() => { set({ model: "" }); done(); }}>Every model</Opt>
            {models.map(([m, w]) => {
              const n = byModel.filter((e) => tplModel(e) === m).length;
              return (
                <Opt key={m} on={f.model === m} n={n} dim={!n} onPick={() => { set({ model: f.model === m ? "" : m }); done(); }}
                  say={w.local && w.cloud ? "Your GPU and Cloud" : w.local ? "Your GPU" : "Cloud · Comfy Router"} icon={w.local ? "cpu" : "cloud"}>{m}</Opt>
              );
            })}
            {!models.some(([, w]) => w.cloud) && (
              <a className="xopt more" href={href({ name: "build", cloud: true })} onClick={done}>
                <I n="plus" /><span className="xo-t"><b>Add a cloud model</b><span>Build a template on Comfy Router</span></span>
              </a>
            )}
          </>
        )}
      </Facet>
      <Facet label="Input" value={TAKES.find((x) => x.v === f.takes)?.label ?? null} icon="upload">
        {(done) => (
          <>
            <Opt on={!f.takes} n={byTakes.length} onPick={() => { set({ takes: "" }); done(); }}>Anything</Opt>
            {TAKES.map((x) => {
              const n = byTakes.filter((e) => takes(e, x.v)).length;
              return (!!n || f.takes === x.v) && <Opt key={x.v} on={f.takes === x.v} n={n} icon={x.icon} onPick={() => { set({ takes: f.takes === x.v ? "" : x.v }); done(); }}>{x.label}</Opt>;
            })}
          </>
        )}
      </Facet>
      {narrowed && <button type="button" className="xclear" onClick={clear}><I n="x" size={13} />Clear</button>}
      <Facet label="Sort" value={SORTS.find((x) => x.v === f.sort)!.label} end quiet>
        {(done) => SORTS.map((x) => <Opt key={x.v} on={f.sort === x.v} say={x.say} onPick={() => { set({ sort: x.v }); done(); }}>{x.label}</Opt>)}
      </Facet>
    </div>
  );

  return (
    <div className="page explore">
      <div ref={exploreScroll} className="scroll">
        <PageHead title="Explore" search={false} filters={<Search value={f.q} onChange={(q) => set({ q })} found={engines.data ? shown.length : null} total={every.length} />}
          bar={bar}
          actions={<a className="btn" href="#/build" title="Make a template from a ComfyUI workflow or a Comfy Router model"><I n="plus" /><span className="lbl">New template</span></a>} />
        {f.ready && <div className="xreadiness" role="status">
          <span>{checks.isFetching ? "Checking local nodes and models…" : "Connection and requirements checked, not inputs, available VRAM or cloud credit."}</span>
          <button type="button" className="xclear" onClick={() => { if (status.data?.local.comfyui) void checks.refetch(); void status.refetch(); }} disabled={checks.isFetching || status.isFetching}><I n="refresh" size={13} />Check again</button>
        </div>}
        <div className="wall-wrap wtop">
          {engines.isLoading ? (
            <Masonry label="Loading templates" items={SKELETON} maxCols={5} minCol={200} render={(x) => <div aria-hidden className="card"><div className="media" style={{ "--ar": x.aspect } as CSSProperties} /></div>} />
          ) : engines.isError ? (
            <EmptyBox icon="alert" title="Couldn't load templates" action={<button className="btn" type="button" onClick={() => engines.refetch()}>Try again</button>}>{errMsg(engines.error)}</EmptyBox>
          ) : tiles.length ? (
            <Masonry label="Templates" items={tiles} maxCols={5} minCol={200}
              render={({ e }) => <TemplateCard e={e} hint={hint(e)} readiness={readiness(e)} selected={e.id === t} onUse={() => use_(e)} onInspect={() => inspect(e.id === t ? undefined : e.id)} />} />
          ) : (
            <EmptyBox icon={f.ready ? "check" : "search"} title={f.ready ? (checks.isFetching ? "Checking what's ready" : "No ready templates match") : f.q ? `Nothing matches “${f.q.trim()}”` : "No templates match"}
              action={<><button className="btn" type="button" onClick={clear}>Show all</button>{f.ready && <a className="btn primary" href="#/connect">Set up a connection</a>}</>}>
              {f.ready ? "Connect your ComfyUI or add a cloud key. Local templates also need their nodes and models installed." : f.q ? "Try another word: what it does (hat, swap, relight), or the model." : "Clear the filters to see all of them."}
            </EmptyBox>
          )}
          <AddTemplate />
        </div>
      </div>
      <div className={open ? "scrim on" : "scrim"} onClick={close} />
      <aside ref={inspector} className={open ? "inspector open" : "inspector"} role="dialog" aria-label="Template details" aria-hidden={!open}>
        {panel && <TemplateInspector key={panel.id} e={panel} locked={locked(panel)} onUse={() => use_(panel)} onClose={close} />}
      </aside>
    </div>
  );
}

/** The search field: `/` jumps to it from anywhere on the page, Esc clears it. */
function Search({ value, onChange, found, total }: { value: string; onChange: (q: string) => void; found: number | null; total: number }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      const el = ev.target as HTMLElement | null;
      if (ev.key !== "/" || ev.ctrlKey || ev.metaKey || el?.closest("input,textarea,select,[contenteditable=true]")) return;
      ev.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <label className={value ? "xsearch on" : "xsearch"}>
      <I n="search" className="xs-ic" />
      <input ref={ref} type="search" value={value} placeholder="Search templates: hat, swap, relight, Seedance…" aria-label="Search templates"
        spellCheck={false} autoComplete="off" onChange={(ev) => onChange(ev.target.value)}
        onKeyDown={(ev) => { if (ev.key === "Escape" && value) { ev.preventDefault(); onChange(""); } }} />
      {value ? (
        <>
          {found != null && <span className="xs-n mono">{found} of {total}</span>}
          <button type="button" className="xs-x" aria-label="Clear search" onClick={() => { onChange(""); ref.current?.focus(); }}><I n="x" size={14} /></button>
        </>
      ) : <kbd aria-hidden>/</kbd>}
    </label>
  );
}

/** A filter that opens a short list: its name, and what's picked once something is. */
function Facet({ label, value, icon, end, quiet, children }: { label: string; value: string | null; icon?: IconName; end?: boolean; quiet?: boolean; children: (done: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" className={["xfacet", value && !quiet && "on", end && "end"].filter(Boolean).join(" ")} aria-haspopup="dialog"
          aria-label={value ? `${label}: ${value}` : label}>
          {icon && <I n={icon} size={14} />}
          <span className="xf-l">{label}</span>
          {value && <b>{value}</b>}
          <I n="down" size={13} className="xf-cv" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align={end ? "end" : "start"} sideOffset={8} className="pop xpop" role="dialog" aria-label={`${label} filter`}>
          {children(() => setOpen(false))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Opt({ on, n, dim, say, icon, onPick, children }: { on: boolean; n?: number; dim?: boolean; say?: string; icon?: IconName; onPick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} className={dim ? "xopt dim" : "xopt"} onClick={onPick}>
      {icon && <I n={icon} size={15} />}
      <span className="xo-t"><b>{children}</b>{say && <span>{say}</span>}</span>
      {n != null && <span className="xo-n mono">{n}</span>}
      <I n="check" size={14} className="xo-on" />
    </button>
  );
}

/** Under the templates: add one someone exported, by dropping its .illusion here or choosing it. */
function AddTemplate() {
  const toast = useApp((s) => s.toast);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [compact] = useState(() => {
    try { return localStorage.getItem("openillusion.seen-template-import") === "1"; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem("openillusion.seen-template-import", "1"); } catch { /* storage can be disabled */ }
  }, []);
  const add = async (files: File[]) => {
    const f = files[0];
    if (!f || busy) return;
    setBusy(true);
    try {
      landImport(await api.importFile(f));
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const drop = useFileDrop((files) => void add(files));
  return (
    <section {...drop.props} className={cx("xadd", compact && "compact", drop.over && "over")} aria-label="Add a shared template">
      <input ref={input} type="file" accept=".illusion" hidden onChange={(ev) => { void add([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
      <span className="xadd-ic">{busy ? <Spinner size={18} /> : <I n="import" />}</span>
      <div className="xadd-t">
        <b>{compact ? "Import a shared template" : "Add a template someone shared"}</b>
        <p>{compact ? "Drop an .illusion file here, or choose one." : "Drop its .illusion here. It brings its samples and cover, and lands on Explore as yours. Export one from any template in Create."}</p>
      </div>
      <button className="btn" type="button" disabled={busy} onClick={() => input.current?.click()}><I n="upload" />Choose file</button>
    </section>
  );
}
