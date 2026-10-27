import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, HttpError, type EngineInfo, type Estimate, type LocalStatus, type Mode, type Spec } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { errMsg } from "../lib/format";
import { useElapsed, useJobs } from "../lib/live";
import { go, href } from "../lib/route";
import { clipSlots, clipWindow, roleOf } from "../lib/fields";
import { toSpec } from "../lib/spec";
import { newKey, useApp, type StudioState } from "../lib/store";
import { typing } from "./ABPlayer";
import { AlertTriangle, Brush, Check, Chevron, Copy, Download, External, Motion, Refresh, XCircle } from "./Icons";
import { gpuName } from "./Shell";
import { Button, Empty, Notice, Spinner, cx } from "./ui";

export function useStudio(mode: Mode) {
  const s = useApp((st) => st[mode]);
  const set = useApp((st) => st.setStudio);
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  // A studio without a template, or on one that's gone, opens on the mode's first template.
  useEffect(() => {
    if (!engines.data || engines.isFetching || engines.data.some((e) => e.id === s.engine)) return;
    const pick = engines.data.find((e) => e.mode === mode);
    if (pick && pick.id !== s.engine) set(mode, { engine: pick.id });
  }, [mode, s.engine, engines.data, engines.isFetching, set]);
  // A template opens ready to run: its samples in the slots, its default prompt in the box. Once per fresh draft;
  // a draft that already has content (a remix) is left as it is.
  useEffect(() => {
    const e = engines.data?.find((x) => x.id === s.engine);
    if (!e || s.seeded === e.id) return;
    if (s.refs.length || s.prompt || s.videos.length || s.sounds?.length || !e.defaults) return set(mode, { seeded: e.id });
    set(mode, seedFrom(e));
  }, [mode, s.engine, s.seeded, engines.data, set]);
  return [s, (p: Partial<StudioState> | ((s: StudioState) => Partial<StudioState>)) => set(mode, p)] as const;
}

/** A fresh draft of ``e``: its samples in the slots and its default prompt in the box. */
export function seedFrom(e: EngineInfo): Partial<StudioState> {
  if (!e.defaults) return { seeded: e.id };
  const slots = clipSlots(e, e.mode);
  return {
    seeded: e.id,
    prompt: e.defaults.prompt,
    videos: e.defaults.inputs.filter((i) => slots.includes(i.slot)).map((i) => {
      const d = i.duration ?? 0;
      const win = clipWindow(e, i.slot);
      return { ...i, trim: [0, win ? Math.min(d, win[1]) : d] as [number, number], sample: true, license: "generated", contains_person: false, consent: false };
    }),
    refs: e.defaults.inputs.filter((i) => i.slot.startsWith("image:")).map((i) => ({
      ...i, key: newKey(), slot: Number(i.slot.split(":")[1]), sample: true, license: "generated", contains_person: false, consent: false, role: roleOf(e, i.slot),
    })),
    sounds: e.defaults.inputs.filter((i) => i.slot.startsWith("audio:")).map((i) => ({ ...i, sample: true, license: "generated" })),
  };
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
    <Empty className="flex-1" icon={mode === "motion" ? <Motion size={18} /> : <Brush size={18} />} title={`No ${mode === "motion" ? "video" : "image"} templates yet`}
      action={<>
        <Button tone="primary" size="md" onClick={() => go({ name: "build" })}>Build one</Button>
        {hasOther && <Button size="md" onClick={() => go({ name: other })}>Show {other === "edit" ? "image" : "video"} templates</Button>}
      </>}>
      Turn a ComfyUI workflow into a template in Build, and it opens here.
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

type Composed = { template: Record<string, unknown>; warnings: { field: string; level: string; text: string }[] };

/** Everything that decides whether Run works, and Run itself. R runs from anywhere outside a text field. */
export function useRunner({ set, spec, compose, estimate, onRan }: {
  set: SetStudio; spec: Spec; compose?: Composed; estimate?: Estimate | null; onRan?: (ids: string[]) => void;
}) {
  const qc = useQueryClient();
  const toast = useApp((st) => st.toast);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const errors = compose?.warnings.filter((w) => w.level === "error") ?? [];
  const isLocal = spec.engine.startsWith("local/");
  const check = useLocalCheck(spec);
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const split = isLocal && status.data?.local.upstream_match === false && !status.data.local.managed;
  const missing = split || (isLocal && !!check.data && !check.data.ok && check.data.reachable !== false);
  const unknown = !isLocal && (!estimate || estimate.source === "unknown");
  const noKey = !isLocal && status.data && !status.data.has_key;
  const blocked = errors.length > 0 || busy || missing || !!noKey;
  const reasons = [
    ...(noKey ? ["Add a Comfy API key in Settings to run cloud engines"] : []),
    ...errors.map((w) => w.text),
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

/** Current run's generation + job, with a live elapsed timer. */
export function useCurrent(id: string | null) {
  const generation = useQuery({ queryKey: ["generation", id], queryFn: () => api.generation(id!), enabled: !!id, retry: false });
  const { data: jobs = [] } = useJobs();
  const job = jobs.find((j) => j.id === id) ?? null;
  const t = useElapsed(job?.started ?? job?.created, job?.finished);
  return { generation: generation.data ?? null, job, elapsed: t, missing: generation.isError };
}

/** Fields named by compose warnings or Router 422s, for red outlines. */
export function invalidFields(compose?: { warnings: { field: string; level: string }[] }, jobError?: { validation?: { loc: (string | number)[] }[] } | null) {
  const out = new Set<string>();
  for (const w of compose?.warnings ?? []) if (w.level === "error") out.add(w.field);
  for (const v of jobError?.validation ?? []) if (v.loc?.[1] != null) out.add(String(v.loc[1]));
  return out;
}
