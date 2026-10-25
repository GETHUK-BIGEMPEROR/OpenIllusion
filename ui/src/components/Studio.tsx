import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, fileUrl, HttpError, type EngineInfo, type Estimate, type Job, type LocalStatus, type Manifest, type Mode, type Spec } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { clock, elapsed, errMsg, OUTCOME, shortModel } from "../lib/format";
import { useElapsed, useJobs } from "../lib/live";
import { go, href } from "../lib/route";
import { insertAt, toSpec } from "../lib/spec";
import { newKey, useApp, type StudioState } from "../lib/store";
import { usePrepImages } from "../lib/size";
import { typing } from "./ABPlayer";
import { CostPill, OutcomeToggle, StateBadge } from "./bits";
import { EngineDropdown, ParamFields, SizeField } from "./Engine";
import { AlertTriangle, Brush, Check, Chevron, Copy, Download, External, Motion, Refresh, XCircle } from "./Icons";
import { gpuName } from "./Shell";
import { Button, Dot, Empty, Kbd, Notice, Section, Spinner, cx } from "./ui";

export function useStudio(mode: Mode) {
  const s = useApp((st) => st[mode]);
  const set = useApp((st) => st.setStudio);
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  // A studio without an engine opens on Settings' default, else the mode's first template.
  useEffect(() => {
    if (s.engine || !engines.data || !settings.data) return;
    const mine = engines.data.filter((e) => e.mode === mode);
    const pref = settings.data[mode === "motion" ? "default_motion_engine" : "default_edit_engine"];
    const pick = mine.find((e) => e.id === pref) ?? mine[0];
    if (pick) set(mode, { engine: pick.id });
  }, [mode, s.engine, engines.data, settings.data, set]);
  // A template opens ready to run: its samples in the slots, its default prompt in the box. Once per fresh draft;
  // a draft that already has content (a remix) is left as it is.
  useEffect(() => {
    const e = engines.data?.find((x) => x.id === s.engine);
    if (!e || s.seeded === e.id) return;
    if (s.refs.length || s.prompt || s.video || !e.defaults) return set(mode, { seeded: e.id });
    set(mode, {
      seeded: e.id,
      prompt: e.defaults.prompt,
      refs: e.defaults.inputs.filter((i) => i.slot.startsWith("image:")).map((i) => {
        const n = Number(i.slot.split(":")[1]);
        return {
          ...i, key: newKey(), slot: n, sample: true, license: "stock", contains_person: false, consent: false,
          role: mode === "motion" ? "character" : n === 1 ? "base" : "character",
        };
      }),
    });
  }, [mode, s.engine, s.seeded, engines.data, set]);
  return [s, (p: Partial<StudioState> | ((s: StudioState) => Partial<StudioState>)) => set(mode, p)] as const;
}

type SetStudio = ReturnType<typeof useStudio>[1];

function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

const checkKey = (spec: Spec) => JSON.stringify({ ...spec, title: undefined, prompt: "" });

/** Whether a cached query key (a JSON spec) belongs to this engine. */
function sameEngine(key: unknown, engine: string) {
  try {
    return JSON.parse(String(key)).engine === engine;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ layout */

/**
 * Studio frame: inputs on the left, the stage in the middle, engine + run on the right.
 * Each pane scrolls on its own; below xl the panes stack and the page scrolls.
 */
export function StudioLayout({ left, center, right, run }: { left: ReactNode; center: ReactNode; right: ReactNode; run: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 xl:grid xl:grid-cols-[288px_minmax(0,1fr)_320px] xl:grid-rows-[minmax(0,1fr)_auto] max-xl:flex max-xl:flex-col max-xl:overflow-y-auto max-xl:scroll-y">
      <aside aria-label="Inputs" className="bg-panel xl:row-span-2 xl:min-h-0 xl:border-r border-line xl:overflow-y-auto scroll-y max-xl:shrink-0 max-xl:border-b max-xl:order-2">
        {left}
      </aside>
      <section aria-label="Stage" className="min-w-0 flex flex-col xl:row-span-2 xl:min-h-0 max-xl:shrink-0 max-xl:h-[min(640px,75vh)] max-xl:order-1">
        {center}
      </section>
      <aside aria-label="Engine" className="bg-panel xl:min-h-0 xl:border-l border-line xl:overflow-y-auto scroll-y max-xl:shrink-0 max-xl:order-3">
        {right}
      </aside>
      <div className="bg-panel xl:border-l border-t border-line px-4 py-3 max-xl:order-4 max-xl:sticky max-xl:bottom-0 max-xl:z-10 max-xl:shadow-[0_-8px_24px_rgba(0,0,0,0.35)]">{run}</div>
    </div>
  );
}

/** Title + status row above the stage. */
export function StageBar({ s, set, children }: { s: StudioState; set: SetStudio; children?: ReactNode }) {
  return (
    <div className="shrink-0 h-11 px-3 flex items-center gap-3 border-b border-line">
      <label className="flex-1 min-w-0 flex">
        <span className="sr-only">Generation title</span>
        <input value={s.title} onChange={(e) => set({ title: e.target.value })} placeholder="Untitled generation"
          className="w-full min-w-0 h-7 px-1.5 -mx-1.5 rounded-md bg-transparent border-0 outline-none text-md font-semibold placeholder:text-faint placeholder:font-medium hover:bg-white/[0.03] focus:bg-white/[0.04]" />
      </label>
      {children}
    </div>
  );
}

/** Small row of actions under the stage. */
export function ActionBar({ children }: { children: ReactNode }) {
  return <div className="shrink-0 px-3 pb-3 flex flex-wrap items-center gap-1.5">{children}</div>;
}

/* ------------------------------------------------------------- local checks */

/** What the user's ComfyUI lacks for a local template, debounced; null for cloud engines. */
export function useLocalCheck(spec: Spec) {
  const isLocal = spec.engine.startsWith("local/");
  const key = useDebounced(checkKey(spec), 600);
  return useQuery({
    queryKey: ["local-check", key],
    queryFn: () => api.localCheck(JSON.parse(key) as Spec),
    enabled: isLocal && key === checkKey(spec),
    staleTime: 30_000,
    retry: false,
    placeholderData: (p, q) => (q && sameEngine(q.queryKey[1], spec.engine) ? p : undefined),
  });
}

/** Save this template's workflow as ComfyUI API JSON. Run-time tokens become loadable stand-ins. */
export async function downloadWorkflow(spec: Spec) {
  const { template } = await api.compose(spec);
  const json = JSON.stringify(template, null, 2)
    .replace(/"\{\{seed:random\}\}"/g, () => String(Math.floor(Math.random() * 2 ** 32)))
    .replace(/"\{\{(image|video):\d+\}\}"/g, '"example.png"');
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  a.download = `${spec.engine.split("/").pop()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function Code({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[11px] text-soft bg-white/[0.06] rounded px-1 py-px break-all">{children}</span>;
}

/** Missing nodes and models, listed the way ComfyUI does. Nothing is installed for you. */
export function LocalNeeds({ spec }: { spec: Spec }) {
  const qc = useQueryClient();
  const check = useLocalCheck(spec);
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const [starting, setStarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const toast = useApp((st) => st.toast);
  if (!spec.engine.startsWith("local/")) return null;
  const local = status.data?.local;
  const c = check.data;
  const again = async () => {
    setChecking(true);
    try {
      const fresh = await api.localCheck(spec, true);
      const k = checkKey(spec);
      qc.removeQueries({ queryKey: ["local-check"], predicate: (q) => q.queryKey[1] !== k });
      qc.setQueryData(["local-check", k], fresh);
      qc.invalidateQueries({ queryKey: ["status"] });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setChecking(false);
    }
  };
  const start = async () => {
    setStarting(true);
    try {
      const r = await api.startProxy();
      qc.setQueryData(["status"], (old: any) => (old ? { ...old, local: r.local } : old));
      if (!r.ok) toast({ text: r.reason === "proxy_not_installed" ? "comfy-api-proxy isn't installed. Run: pip install comfy-api-proxy" : "comfy-api-proxy didn't start. See proxy.log in OpenIllusion's home folder.", tone: "error" });
    } finally {
      setStarting(false);
    }
  };
  const comfy = local?.comfyui_url ?? "http://127.0.0.1:8188";
  const recheck = <Button size="xs" onClick={again} disabled={checking}>{checking ? <Spinner size={11} /> : <Refresh size={12} />}Check again</Button>;

  if (local?.upstream_match === false) return <UpstreamWarning local={local} />;
  if (local && !local.comfyui) {
    return (
      <Notice tone="error" title="ComfyUI isn't answering" actions={<>{recheck}<Button size="xs" tone="ghost" onClick={() => (location.hash = href({ name: "settings" }))}>Settings</Button></>}>
        Nothing at <Code>{comfy}</Code>. Start ComfyUI, or change its address in Settings.
      </Notice>
    );
  }
  const problems = c ? c.missing_nodes.length + c.missing_models.length + c.bad_values.length : 0;
  return (
    <>
      {local && !local.v2 && !(local.autostart && local.proxy_installed) && (
        <Notice tone="warn" title="Comfy API v2 isn't running"
          actions={local.proxy_installed && <Button size="xs" onClick={start} disabled={starting}>{starting ? <Spinner size={11} /> : null}Start comfy-api-proxy</Button>}>
          Nothing at <Code>{local.v2_url}</Code>. {local.proxy_installed ? "Auto-start is off in Settings." : <>Install it with <Code>pip install comfy-api-proxy</Code>.</>}
        </Notice>
      )}
      {c && problems > 0 && (
        <Notice tone="error" title="Your ComfyUI can't run this yet"
          actions={<>
            {recheck}
            <Button size="xs" tone="ghost" onClick={() => downloadWorkflow(spec).catch((e) => toast({ text: errMsg(e), tone: "error" }))}
              title="This template's workflow in API format. Drop it on the ComfyUI canvas; Manager's Install Missing works on it.">
              <Download size={12} />Workflow
            </Button>
            <Button size="xs" tone="ghost" onClick={() => window.open(comfy, "_blank", "noreferrer")} title="Opens ComfyUI with whatever it had open last"><External size={12} />ComfyUI</Button>
          </>}>
          <span className="block mb-2">Install what's listed, then check again. OpenIllusion never installs anything for you.</span>
          <div className="flex flex-col gap-2">
            {c.missing_nodes.length > 0 && (
              <NeedList title={`Missing nodes · ${c.missing_nodes.length}`} hint="Install with ComfyUI Manager">
                {c.missing_nodes.map((n) => (
                  <li key={n.class_type} className="px-2 py-1.5 flex flex-col">
                    <span className="font-mono text-xs text-text break-all">{n.class_type}</span>
                    {n.package && <span className="text-xs2 text-muted">{n.package}</span>}
                  </li>
                ))}
              </NeedList>
            )}
            {c.missing_models.length > 0 && (
              <NeedList title={`Missing models · ${c.missing_models.length}`}>
                {c.missing_models.map((m) => (
                  <li key={m.node_id + m.input} className="px-2 py-1.5 flex flex-col gap-0.5">
                    <span className="font-mono text-xs text-text break-all">{m.value}</span>
                    <span className="text-xs2 text-muted">into <span className="font-mono">models/{m.folder ?? "…"}</span>{m.url && <> · <a href={m.url} target="_blank" rel="noreferrer" className="text-violet-light hover:underline">download</a></>}</span>
                  </li>
                ))}
              </NeedList>
            )}
            {c.bad_values.length > 0 && (
              <NeedList title={`Values ComfyUI rejects · ${c.bad_values.length}`}>
                {c.bad_values.map((b) => (
                  <li key={b.node_id + b.input} className="px-2 py-1.5 font-mono text-xs break-all">{b.class_type}.{b.input} = {JSON.stringify(b.value)}</li>
                ))}
              </NeedList>
            )}
          </div>
        </Notice>
      )}
      {c && problems === 0 && c.reachable !== false && (
        <p className="m-0 flex items-center gap-1.5 text-xs text-muted"><Check size={12} className="text-mint" />All nodes and models found{gpuName(local?.gpu) ? ` · ${gpuName(local?.gpu)}` : ""}</p>
      )}
    </>
  );
}

function NeedList({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-baseline justify-between gap-2 text-xs2 font-semibold uppercase tracking-[0.05em] text-muted">{title}{hint && <span className="normal-case tracking-normal font-normal">{hint}</span>}</span>
      <ul className="m-0 p-0 list-none rounded-md bg-deep/60 border border-line divide-y divide-line max-h-[180px] overflow-y-auto scroll-y">{children}</ul>
    </div>
  );
}

/** Shown when Comfy API v2 runs on a different ComfyUI than the one OpenIllusion checks. */
export function UpstreamWarning({ local }: { local?: LocalStatus }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  if (!local?.v2 || !local.upstream || local.upstream_match === true) return null;
  const seen = local.upstream_seen ?? local.upstream;
  const use = async () => {
    setBusy(true);
    try {
      await api.saveSettings({ local_comfyui_url: seen });
      qc.setQueryData(["status"], await api.status(true));
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["local-check"] });
    } finally {
      setBusy(false);
    }
  };
  if (local.upstream_match === null) {
    return (
      <Notice tone="info">
        Comfy API v2 forwards to <Code>{local.upstream}</Code>, a name only its own network knows. Make sure that's the ComfyUI at <Code>{local.comfyui_url}</Code>.
      </Notice>
    );
  }
  return (
    <Notice tone="error" title="Two different ComfyUIs"
      actions={<Button size="xs" onClick={use} disabled={busy}>{busy ? <Spinner size={11} /> : null}Check <span className="font-mono">{seen}</span> instead</Button>}>
      Comfy API v2 at <Code>{local.v2_url}</Code> runs on <Code>{seen}</Code>, but nodes and models are checked on <Code>{local.comfyui_url}</Code>.
      {local.managed ? " OpenIllusion restarts its proxy on the right one when you run." : ""}
    </Notice>
  );
}

/* ---------------------------------------------------------------- progress */

/** Live progress for a local run: nodes done, sampler steps, and the latest preview frame. */
export function LocalProgress({ job, preview = true }: { job: Job; preview?: boolean }) {
  const p = job.progress;
  const pct = p?.value != null ? Math.round(p.value * 100) : null;
  return (
    <div className="relative flex flex-col items-center gap-2 w-full max-w-[320px]">
      {preview && job.preview && <img src={job.preview} alt="Preview of the run in progress" className="max-h-[200px] max-w-full rounded-lg shadow-float" />}
      <div className="w-full h-1 rounded-full bg-white/10 overflow-hidden" role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
        <div className={cx("h-full rounded-full bg-yellow transition-[width] duration-500", pct == null && "mk-shimmer w-full")} style={pct != null ? { width: `${pct}%` } : undefined} />
      </div>
      <span className="font-mono text-xs2 tabular text-muted text-center">
        {pct != null ? `${pct}%` : "Starting"}
        {p?.nodes_total ? ` · node ${p.nodes_done ?? 0}/${p.nodes_total}` : ""}
        {p?.steps ? ` · step ${p.step ?? 0}/${p.steps}` : ""}
        {p?.current_node_class ? ` · ${p.current_node_class}` : ""}
      </span>
    </div>
  );
}

/** Stage overlay while a run is in flight. */
export function StageRunning({ job, t, compact = false }: { job: Job; t: number; compact?: boolean }) {
  const local = job.kind === "local" && job.state === "running";
  const word = job.state === "running" ? "Running" : job.state === "downloading" ? "Saving result" : job.state === "queued" ? "Queued" : job.detail || "Waiting";
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 text-center p-6 bg-deep/40">
      <div aria-hidden className="absolute inset-0 stage-shimmer" />
      <span className="relative inline-flex items-center gap-2 text-md font-semibold"><Dot tone="busy" pulse />{word}</span>
      {local ? <LocalProgress job={job} preview={!compact} /> : !compact && job.state === "running" && <span className="relative text-xs text-muted max-w-[300px]">This model doesn't report progress.</span>}
      <span className="relative font-mono text-[22px] tabular text-text">{clock(t, false)}</span>
      {!compact && <span className="relative text-xs text-muted">{job.kind === "local" ? "In your ComfyUI" : `${job.provider} via Comfy Router`}</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ errors */

export interface Fix { label: string; run: () => void; primary?: boolean; icon?: ReactNode }

/**
 * One way to show a failed run anywhere: a plain title, what to do, the fixes the
 * engine suggested, and the raw message behind "Details".
 */
export function StageError({ state, error, detail, fixes = [], compact = false, className }: {
  state: string; error?: Record<string, unknown> | null; detail?: string | null; fixes?: Fix[]; compact?: boolean; className?: string;
}) {
  const f = describeFailure(state, error as any, detail);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const raw = f.raw && f.raw !== f.body ? f.raw : null;
  const quiet = f.kind === "cancelled";
  const copy = () => {
    navigator.clipboard?.writeText(raw ?? f.body).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {});
  };
  return (
    <div role={quiet ? "status" : "alert"} className={cx("w-full flex flex-col items-center text-center gap-2", compact ? "max-w-[300px]" : "max-w-[440px]", className)}>
      <span className={cx("rounded-full flex items-center justify-center", compact ? "w-8 h-8" : "w-10 h-10", quiet ? "bg-white/[0.06] text-muted" : "bg-rose/15 text-rose")}>
        {quiet ? <XCircle size={compact ? 16 : 18} /> : <AlertTriangle size={compact ? 16 : 18} />}
      </span>
      <span className={cx("font-semibold text-text", compact ? "text-base" : "text-md")}>{f.title}</span>
      <span className="text-sm text-muted">{f.body}</span>
      {fixes.length > 0 && (
        <div className="mt-1 flex flex-wrap justify-center gap-1.5">
          {fixes.map((x) => <Button key={x.label} size="sm" tone={x.primary ? "contrast" : "secondary"} onClick={x.run}>{x.icon}{x.label}</Button>)}
        </div>
      )}
      {raw && (
        <div className="w-full mt-1 flex flex-col items-center">
          <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="mk-btn h-6 px-1.5 rounded-md border-0 bg-transparent text-xs text-faint hover:text-soft inline-flex items-center gap-1">
            {open ? "Hide details" : "Show details"}<Chevron size={11} className={cx("transition-transform", open && "rotate-180")} />
          </button>
          {open && (
            <div className="relative w-full mt-1 text-left">
              <pre className="m-0 max-h-[160px] overflow-auto scroll-y rounded-md bg-deep border border-line p-2.5 pr-9 font-mono text-xs2 leading-[1.6] text-soft whitespace-pre-wrap break-all">{raw}</pre>
              <button type="button" aria-label="Copy details" title="Copy" onClick={copy} className="mk-btn absolute right-1.5 top-1.5 w-6 h-6 rounded-md border-0 bg-raised text-muted hover:text-text flex items-center justify-center">
                {copied ? <Check size={12} className="text-mint" /> : <Copy size={12} />}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A studio with no template for its mode yet (nothing shipped, or still loading). */
export function NoTemplates({ mode }: { mode: Mode }) {
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  if (engines.isLoading) return <div className="flex-1 flex items-center justify-center" aria-busy="true"><Spinner size={18} /></div>;
  const other = mode === "motion" ? "edit" : "motion";
  const hasOther = !!engines.data?.some((e) => e.mode === other);
  return (
    <Empty className="flex-1" icon={mode === "motion" ? <Motion size={18} /> : <Brush size={18} />} title={`No ${mode} templates yet`}
      action={<>
        {hasOther && <Button tone="primary" size="md" onClick={() => go({ name: other })}>Open {other === "edit" ? "Edit" : "Motion"} studio</Button>}
        <Button size="md" onClick={() => go({ name: "explore" })}>Browse templates</Button>
      </>}>
      Templates are added one at a time, each after it has run end to end. Drop a template file into your templates folder and it shows up here.
    </Empty>
  );
}

/* ----------------------------------------------------------------- compose */

/** Compose (template + warnings) and the Router estimate, both debounced. */
export function useCompose(mode: Mode, s: StudioState, engine?: EngineInfo) {
  const spec = useMemo(() => toSpec(mode, s, engine), [mode, s, engine]);
  const key = useDebounced(JSON.stringify(spec), 350);
  const compose = useQuery({ queryKey: ["compose", key], queryFn: () => api.compose(JSON.parse(key) as Spec), placeholderData: (p, q) => (q && sameEngine(q.queryKey[1], spec.engine) ? p : undefined), enabled: !!engine });
  const complete = !!compose.data && !compose.data.warnings.some((w) => w.level === "error");
  const estKey = useDebounced(key, 900);
  const estimate = useQuery({
    queryKey: ["estimate", estKey],
    queryFn: () => api.estimate(JSON.parse(estKey) as Spec),
    enabled: complete && estKey === key,
    staleTime: 300_000,
    retry: false,
  });
  const est: Estimate | null | undefined = !complete ? { source: "unknown", reason: "incomplete" } : estimate.data;
  return { spec, compose: compose.data, estimate: est, estimating: estimate.isFetching };
}

/* ------------------------------------------------------------------ panels */

export function PromptCard({ mode, s, set, roleSentences, children, label = "Prompt", hint, invalid, examples, noTokens }: {
  mode: Mode; s: StudioState; set: SetStudio; roleSentences?: string; children?: ReactNode; label?: string; hint?: string; invalid?: boolean; examples?: string[]; noTokens?: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const insert = (text: string) => {
    const [v, caret] = insertAt(ta.current, s.prompt, text);
    set({ prompt: v });
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(caret, caret);
    });
  };
  // Templates already refer to their images in their own instruction.
  const tokens = noTokens ? [] : [...s.refs.map((_, i) => `Image ${i + 1}`), ...(mode === "motion" && s.video ? ["Video 1"] : [])];
  const id = `${mode}-prompt`;
  return (
    <Section title={<label htmlFor={id}>{label}</label>} meta={s.prompt ? <span className="font-mono tabular">{s.prompt.length}</span> : undefined}>
      <div className="flex flex-col gap-2">
        <textarea
          id={id}
          ref={ta}
          rows={5}
          value={s.prompt}
          aria-invalid={(invalid && s.prompt.trim() !== "") || undefined}
          aria-describedby={`${id}-help`}
          onChange={(e) => set({ prompt: e.target.value })}
          placeholder={hint ?? (mode === "motion" ? "Image 1 is the character. Video 1 is the motion. Night city, rain, slow push-in." : "Describe the change. Keep it to one clear instruction.")}
          className="field px-2.5 py-2 text-base leading-[1.5] resize-y min-h-[96px] max-h-[320px]"
        />
        {(roleSentences || tokens.length > 0) && (
          <div className="flex flex-wrap gap-1" aria-label="Insert into prompt">
            {roleSentences && (
              <button type="button" onClick={() => insert(roleSentences)} title={roleSentences} className="mk-btn h-6 px-2 rounded-md border border-line bg-transparent text-muted hover:text-text hover:border-line2 text-xs">+ Role sentences</button>
            )}
            {tokens.map((t) => (
              <button key={t} type="button" onClick={() => insert(t)} className="mk-btn h-6 px-1.5 rounded-md border border-line bg-transparent text-muted hover:text-text hover:border-line2 font-mono text-xs2">+ {t}</button>
            ))}
          </div>
        )}
        {!!examples?.length && (
          <div className="flex flex-wrap items-center gap-1" aria-label="Example prompts">
            <span className="text-xs text-faint mr-0.5">Try</span>
            {examples.map((x) => (
              <button key={x} type="button" aria-pressed={s.prompt === x} onClick={() => set({ prompt: x })} title={x}
                className={cx("mk-btn h-6 max-w-full px-2 rounded-md border text-xs truncate",
                  s.prompt === x ? "border-line2 bg-active text-text" : "border-line bg-transparent text-muted hover:text-text hover:border-line2")}>
                {x}
              </button>
            ))}
          </div>
        )}
        {children}
        <p id={`${id}-help`} className="m-0 text-xs text-faint">Sent exactly as typed.</p>
      </div>
    </Section>
  );
}

export function EngineCard({ mode, s, set, engine, invalid, extra }: {
  mode: Mode; s: StudioState; set: SetStudio; engine?: EngineInfo; invalid: Set<string>; extra?: ReactNode;
}) {
  const images = usePrepImages(s.refs);
  return (
    <>
      <Section title="Engine" meta={engine ? (engine.kind === "local" ? "Local · your GPU" : "Cloud · Comfy Router") : undefined}>
        <div className="flex flex-col gap-2">
          <EngineDropdown mode={mode} value={s.engine} onChange={(engine) => set({ engine, raw: null })} />
          {engine?.blurb && <p className="m-0 text-xs text-muted">{engine.blurb}</p>}
          {extra}
        </div>
      </Section>
      <Section title="Parameters" meta={engine?.params.length ? (engine.kind === "local" ? "From template" : "From schema") : undefined}>
        <div className="flex flex-col gap-3.5">
          {engine?.size && <SizeField size={engine.size} value={s.params.size} images={images} onChange={(v) => set((st) => ({ params: { ...st.params, size: v }, raw: null }))} />}
          {engine ? (
            <ParamFields params={engine.params} values={s.params} invalid={invalid} onChange={(k, v) => set((st) => ({ params: { ...st.params, [k]: v }, raw: null }))} />
          ) : (
            <div className="flex flex-col gap-2" aria-busy="true"><div className="skeleton h-3 w-1/3 rounded" /><div className="skeleton h-7 rounded-lg" /><div className="skeleton h-3 w-1/4 rounded" /><div className="skeleton h-7 rounded-lg" /></div>
          )}
        </div>
      </Section>
    </>
  );
}

/** The request we'll send (cloud) or the workflow (local), viewable and editable. */
export function RawRequest({ s, set, spec, compose }: { s: StudioState; set: SetStudio; spec: Spec; compose?: { template: Record<string, unknown> } }) {
  const [editRaw, setEditRaw] = useState(false);
  const [copied, setCopied] = useState(false);
  const isLocal = spec.engine.startsWith("local/");
  const rawBad = !!s.raw && (() => { try { JSON.parse(s.raw!); return false; } catch { return true; } })();
  const shown = s.raw ?? JSON.stringify(compose?.template ?? {}, null, 2);
  return (
    <details className="group border-b border-line last:border-b-0" open={editRaw || !!s.raw || undefined}>
      <summary className="h-10 px-4 flex items-center gap-2 cursor-pointer select-none hover:bg-white/[0.02]">
        <Chevron size={12} className="text-muted -rotate-90 group-open:rotate-0 transition-transform" />
        <span className="eyebrow">{isLocal ? "Workflow JSON" : "Request JSON"}</span>
        {s.raw && <span className="h-4 px-1 rounded text-[10px] font-semibold leading-4 bg-yellow/10 text-yellow-light">Edited</span>}
        <span className="ml-auto font-mono text-xs2 text-faint truncate">{shortModel(s.engine)}</span>
      </summary>
      <div className="px-4 pb-3.5 flex flex-col gap-2">
        {editRaw ? (
          <textarea aria-label={isLocal ? "Workflow JSON" : "Request JSON"} aria-invalid={rawBad || undefined} value={shown} onChange={(e) => set({ raw: e.target.value })} rows={14} spellCheck={false}
            className="field p-2.5 font-mono text-xs2 leading-[1.6]" />
        ) : (
          <pre className="m-0 rounded-lg bg-deep border border-line p-2.5 font-mono text-xs2 leading-[1.6] text-soft whitespace-pre-wrap break-all max-h-[280px] overflow-auto scroll-y">{shown}</pre>
        )}
        {rawBad && <span className="text-xs text-rose-text">Not valid JSON. Fix it or reset to the form.</span>}
        <p className="m-0 text-xs text-faint">Media appear as tokens like <span className="font-mono">{"{{image:1}}"}</span> and are filled in on send{isLocal ? " as uploaded assets" : ""}.</p>
        <div className="flex gap-1.5">
          <Button size="xs" onClick={() => { if (!editRaw && !s.raw) set({ raw: shown }); setEditRaw(!editRaw); }}>{editRaw ? "Done" : "Edit"}</Button>
          {s.raw && <Button size="xs" tone="ghost" onClick={() => { set({ raw: null }); setEditRaw(false); }}>Reset to form</Button>}
          <Button size="xs" tone="ghost" className="ml-auto" onClick={() => navigator.clipboard?.writeText(shown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
            {copied ? <Check size={12} className="text-mint" /> : <Copy size={12} />}{copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </div>
    </details>
  );
}

type Composed = { template: Record<string, unknown>; warnings: { field: string; level: string; text: string }[] };

/** Everything that decides whether Run works, and Run itself. R runs from anywhere outside a text field. */
export function useRunner({ s, set, spec, compose, estimate, onRan }: {
  s: StudioState; set: SetStudio; spec: Spec; compose?: Composed; estimate?: Estimate | null; onRan?: (ids: string[]) => void;
}) {
  const qc = useQueryClient();
  const toast = useApp((st) => st.toast);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const errors = compose?.warnings.filter((w) => w.level === "error") ?? [];
  const rawBad = !!s.raw && (() => { try { JSON.parse(s.raw!); return false; } catch { return true; } })();
  const isLocal = spec.engine.startsWith("local/");
  const check = useLocalCheck(spec);
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const split = isLocal && status.data?.local.upstream_match === false && !status.data.local.managed;
  const missing = split || (isLocal && !!check.data && !check.data.ok && check.data.reachable !== false);
  const unknown = !isLocal && (!estimate || estimate.source === "unknown");
  const noKey = !isLocal && status.data && !status.data.has_key;
  const blocked = (!s.raw && errors.length > 0) || rawBad || busy || missing || !!noKey;
  const reasons = [
    ...(noKey ? ["Add a Comfy API key in Settings to run cloud engines"] : []),
    ...(!s.raw ? errors.map((w) => w.text) : []),
    ...(rawBad ? ["The edited request isn't valid JSON"] : []),
    ...(missing && !split ? ["Install what your ComfyUI is missing"] : []),
  ];

  const run = async (force = false) => {
    if (blocked) return;
    if (unknown && settings.data?.confirm_unknown_cost && !force) {
      setConfirm(true);
      return;
    }
    setConfirm(false);
    setBusy(true);
    try {
      const { ids } = await api.run(spec);
      set((st) => ({ current: ids[0], session: [...ids, ...st.session.filter((x) => !ids.includes(x))].slice(0, 24), selected: [] }));
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["generations"] });
      onRan?.(ids);
    } catch (e) {
      toast({ text: e instanceof HttpError && e.status === 401 ? "Comfy Router refused your API key. Check it in Settings, or pick a local engine." : errMsg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const run_ = useRef(run);
  run_.current = run;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() === "r" && !document.querySelector("[role=dialog]")) {
        e.preventDefault();
        void run_.current();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  return { run, busy, blocked, reasons, confirm, setConfirm, isLocal };
}

/** Sticky run footer: cost, anything blocking the run, then the one primary button. */
export function RunCard({ s, set, spec, compose, estimate, label, times = 1, onRan, extra }: {
  mode: Mode; s: StudioState; set: SetStudio; spec: Spec; compose?: Composed;
  estimate?: Estimate | null; label: string; times?: number; onRan?: (ids: string[]) => void; extra?: ReactNode;
}) {
  const { run, busy, blocked, reasons, confirm, setConfirm, isLocal } = useRunner({ s, set, spec, compose, estimate, onRan });

  return (
    <div className="flex flex-col gap-2.5">
      <LocalNeeds spec={spec} />
      {reasons.length > 0 && (
        <ul aria-label="Before you can run" className="m-0 p-0 list-none flex flex-col gap-1">
          {reasons.map((r, i) => (
            <li key={i} className="flex items-start gap-1.5 text-xs text-orange-text"><span aria-hidden className="mt-[5px] w-1 h-1 rounded-full bg-orange shrink-0" />{r}</li>
          ))}
        </ul>
      )}
      <CostPill estimate={isLocal ? { source: "local" } : estimate} times={times} />
      {confirm ? (
        <div role="alertdialog" aria-label="Unknown cost" className="flex flex-col gap-2 p-2.5 rounded-lg bg-orange/10 border border-orange/25">
          <span className="text-sm text-soft">Router can't price this run. It's charged to your Comfy workspace at the provider's rate.</span>
          <div className="flex gap-1.5">
            <Button tone="primary" size="md" className="flex-1" onClick={() => run(true)} autoFocus>Run anyway</Button>
            <Button size="md" onClick={() => setConfirm(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={blocked} onClick={() => run()} aria-keyshortcuts="R"
          className="mk-btn group h-9 border-0 rounded-lg bg-yellow text-ink text-base font-semibold flex items-center justify-center gap-2 shadow-run hover:bg-yellow-light disabled:bg-raised disabled:text-faint disabled:shadow-none disabled:cursor-not-allowed">
          {busy ? <Spinner /> : label}
          {!busy && <Kbd className="!border-ink/25 !text-ink/70 group-disabled:!border-line2 group-disabled:!text-faint">R</Kbd>}
        </button>
      )}
      {extra}
    </div>
  );
}

/* -------------------------------------------------------------- run status */

/** Current run's generation + job, with a live elapsed timer. */
export function useCurrent(id: string | null) {
  const generation = useQuery({ queryKey: ["generation", id], queryFn: () => api.generation(id!), enabled: !!id, retry: false });
  const { data: jobs = [] } = useJobs();
  const job = jobs.find((j) => j.id === id) ?? null;
  const t = useElapsed(job?.started ?? job?.created, job?.finished);
  return { generation: generation.data ?? null, job, elapsed: t, missing: generation.isError };
}

/** One-line run status for the stage bar. */
export function RunStatus({ m, job, t }: { m: Manifest | null; job: ReturnType<typeof useCurrent>["job"]; t: number }) {
  if (job && job.state !== "done") {
    const live = ["running", "queued", "estimating", "waiting", "rate_limited", "downloading"].includes(job.state);
    return (
      <span className="shrink-0 flex items-center gap-2 text-xs text-muted min-w-0">
        <StateBadge job={job} />
        {live ? (
          <span className="font-mono tabular text-soft">{elapsed(t)}{job.kind === "local" && job.progress?.value != null ? ` · ${Math.round(job.progress.value * 100)}%` : ""}</span>
        ) : (
          <span className="truncate max-w-[260px]">{describeFailure(job.state, job.error, job.detail).title}</span>
        )}
      </span>
    );
  }
  if (!m?.result || m.status !== "done") return null;
  const r = m.result;
  const local = m.engine.kind === "local";
  return (
    <span className="shrink-0 flex items-center gap-2 text-xs text-muted">
      <StateBadge job={{ state: "done", queue_position: null }} />
      <span className="max-lg:hidden">{r.elapsed ? elapsed(r.elapsed) : ""}{r.elapsed ? " · " : ""}{local ? "no credits" : r.cost_reported ? `${r.cost_reported} credits` : "cost not reported"}</span>
    </span>
  );
}

export function OutcomeBar({ m }: { m: Manifest }) {
  const qc = useQueryClient();
  const [note, setNote] = useState(m.notes);
  const [saved, setSaved] = useState(false);
  useEffect(() => setNote(m.notes), [m.id, m.notes]);
  const save = async (p: Parameters<typeof api.patch>[1]) => {
    const next = await api.patch(m.id, p);
    qc.setQueryData(["generation", m.id], (old: Manifest | undefined) => (old ? { ...old, ...next } : next));
    qc.invalidateQueries({ queryKey: ["generations"] });
    if ("notes" in p) { setSaved(true); setTimeout(() => setSaved(false), 1400); }
  };
  return (
    <div className="flex-1 min-w-[280px] flex items-center gap-2">
      <OutcomeToggle value={m.outcome} onChange={(outcome) => save({ outcome })} size="sm" />
      <label className="flex-1 min-w-0 relative flex">
        <span className="sr-only">Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== m.notes && save({ notes: note })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          placeholder="Add a note on what worked" className="field w-full h-7 px-2.5 text-sm" />
        {saved && <Check size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-mint" aria-label="Saved" />}
      </label>
    </div>
  );
}

/** This session's runs as a filmstrip under the stage. */
export function SessionStrip({ mode, s, set, onPick }: { mode: Mode; s: StudioState; set: SetStudio; onPick?: (id: string) => void }) {
  const items = useQueries({ queries: s.session.slice(0, 16).map((id) => ({ queryKey: ["generation", id], queryFn: () => api.generation(id), retry: false, staleTime: 10_000 })) });
  const list = items.map((q) => q.data).filter(Boolean) as Manifest[];
  if (!list.length) return null;
  return (
    <section aria-label="This session" className="shrink-0 border-t border-line px-3 py-2 flex items-center gap-2">
      <span className="eyebrow shrink-0 w-14 leading-tight">Session</span>
      <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto scroll-y pb-0.5">
        {list.map((m) => {
          const firstFile = m.inputs.find((i) => i.file)?.file;
          const poster = m.result?.poster ? fileUrl(m.id, m.result.poster) : firstFile ? fileUrl(m.id, mode === "motion" && m.inputs.some((i) => i.slot.startsWith("video:")) ? "driving/poster.webp" : firstFile) : null;
          const on = s.current === m.id;
          const failed = m.status === "failed" || m.status === "moderated";
          const label = m.status === "running" ? "Running" : failed ? "Failed" : m.status === "cancelled" ? "Cancelled" : m.outcome ? OUTCOME[m.outcome].word : m.title;
          return (
            <button key={m.id} type="button" aria-pressed={on} title={`${m.title} · ${label}`} onClick={() => { set({ current: m.id }); onPick?.(m.id); }}
              className={cx("mk-btn relative shrink-0 w-[72px] h-[46px] rounded-md overflow-hidden border-0 p-0 bg-raised", on ? "ring-2 ring-text ring-offset-1 ring-offset-bg" : "opacity-80 hover:opacity-100")}>
              {poster ? <img src={poster} alt="" className={cx("w-full h-full object-cover block", (m.status === "running" || failed) && "opacity-50")} /> : null}
              {m.status === "running" && <span aria-hidden className="absolute inset-0 stage-shimmer" />}
              <span className={cx("absolute left-1 bottom-1 w-1.5 h-1.5 rounded-full", m.status === "running" ? "bg-orange animate-pulse" : failed ? "bg-rose" : m.status === "done" ? (m.outcome ? "" : "bg-white/40") : "bg-white/20")}
                style={m.status === "done" && m.outcome ? { background: OUTCOME[m.outcome].color } : undefined} />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Fields named by compose warnings or Router 422s, for red outlines. */
export function invalidFields(compose?: { warnings: { field: string; level: string }[] }, jobError?: { validation?: { loc: (string | number)[] }[] } | null) {
  const out = new Set<string>();
  for (const w of compose?.warnings ?? []) if (w.level === "error") out.add(w.field);
  for (const v of jobError?.validation ?? []) if (v.loc?.[1] != null) out.add(String(v.loc[1]));
  return out;
}

/** Empty stage: one clear call to action, also a drop target. */
export function EmptyStage({ icon, title, children, onPick, onDrop, busy, meta }: {
  icon: ReactNode; title: string; children: ReactNode; onPick?: () => void; onDrop?: (files: File[]) => void; busy?: boolean; meta?: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const Tag = onPick ? "button" : "div";
  return (
    <Tag type={onPick ? "button" : undefined} onClick={onPick} data-own-drop={onDrop ? "" : undefined}
      onDragOver={onDrop ? (e: React.DragEvent) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } } : undefined}
      onDragLeave={onDrop ? () => setOver(false) : undefined}
      onDrop={onDrop ? (e: React.DragEvent) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); onDrop([...e.dataTransfer.files]); } : undefined}
      className={cx("mk-btn flex-1 min-h-[280px] w-full rounded-lg border border-dashed flex flex-col items-center justify-center gap-2.5 text-center p-6 transition-colors",
        over ? "border-violet bg-violet/[0.06]" : "border-line2 bg-white/[0.01]", onPick && "hover:border-white/25 hover:bg-white/[0.02] cursor-pointer")}>
      <span className="w-11 h-11 rounded-xl bg-surface border border-line flex items-center justify-center text-muted">{busy ? <Spinner size={18} /> : icon}</span>
      <span className="text-md font-semibold text-text">{title}</span>
      <span className="text-sm text-muted max-w-[400px]">{children}</span>
      {meta && <span className="text-xs text-faint">{meta}</span>}
    </Tag>
  );
}
