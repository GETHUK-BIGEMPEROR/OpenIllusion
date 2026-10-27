import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { I, PageHead, useStatus } from "../components/oi";
import type { IconName } from "../components/sprite";
import { tplName } from "../components/TemplateCard";
import { isImage, isVideo, useFileDrop } from "../components/Drop";
import { useUploader } from "../components/Refs";
import { cx, Spinner } from "../components/ui";
import {
  api, type Asset, type BuildParamType, type BuildPreset, type BuildSpec, type MediaKind, type Mode, type RouterAdapter, type WorkflowAnalysis,
} from "../lib/api";
import { confirm } from "../lib/confirm";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { autorun, useApp } from "../lib/store";

// ---- state ---------------------------------------------------------------------

interface MediaRow {
  key: string;
  on: boolean;
  kind: MediaKind;
  label: string;
  hint: string;
  required: boolean;
  sample: Asset | null;
  /** The sample came from you, not from the workflow or the template it was opened from. */
  own?: boolean;
  where: string; // what it maps to, shown small
  node?: string;
  input?: string;
  /** Cloud: the adapter input this row fills (by index), and how many files that input takes. */
  slot?: number;
  max?: number;
  /** Local: a loader ComfyUI marks as a file input, or a setting that holds a file name. */
  found?: "loader" | "setting";
  value?: string | null;
  /** Clips: what the template accepts. Unset, the workflow's loader decides. */
  window?: [number, number] | null;
  fps?: [number, number] | null;
}

interface ParamRow {
  id: string;
  on: boolean;
  label: string;
  type: BuildParamType;
  value: unknown;
  orig: unknown;
  group: string;
  name: string;
  min?: number | null;
  max?: number | null;
  step?: number | null;
  options?: (string | number)[];
  help?: string | null;
  suggested: boolean;
  node?: string;
  input?: string;
  key?: string; // the template's name for it, when opened from a template
}

interface PromptState {
  pick: string; // "node|input" for workflows, "prompt" for Router models, "" for none
  label: string;
  hint: string;
  def: string;
  required: boolean;
}

interface Details { label: string; blurb: string; mode: Mode; tags: string }

/** Local: the node a run's result comes from, and where a declared output size goes ("" when the workflow sizes itself). */
interface OutputState { result: string; size: string; keep?: { label?: string; aspect?: string; default?: string } }

type Source =
  | { kind: "local"; a: WorkflowAnalysis }
  | { kind: "cloud"; a: RouterAdapter };

const human = (s: string) => {
  const t = s.split(".").pop()!.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
const cap = (t: string) => t.trim().charAt(0).toUpperCase() + t.trim().slice(1);
const KIND_NOUN: Record<MediaKind, string> = { image: "Image", video: "Video", audio: "Audio" };
const KIND_ICON: Record<MediaKind, "image" | "film" | "zap"> = { image: "image", video: "film", audio: "zap" };
// "image_qwen_image_2_1_background_removal.json" -> "Qwen image 2.1 background removal"
const fileTitle = (name: string) => cap(name.replace(/\.[a-z0-9]+$/i, "").replace(/^(image|video|audio|utility|api|templates?)[-_]+/i, "")
  .replace(/(\d)[-_](\d)(?![a-z0-9])/gi, "$1.$2").replace(/[-_]+/g, " ").replace(/\s+/g, " "));

function mediaLabels<T extends { kind: MediaKind; title?: string; class_type?: string }>(rows: T[]): string[] {
  const n: Record<string, number> = {};
  const total = (k: MediaKind) => rows.filter((r) => r.kind === k).length;
  return rows.map((r) => {
    n[r.kind] = (n[r.kind] ?? 0) + 1;
    if (r.title && r.class_type && r.title !== r.class_type) return r.title.slice(0, 40);
    if (r.kind === "image") return total("image") > 1 ? `Image ${n.image}` : "Photo";
    if (r.kind === "video") return "Clip";
    return "Audio";
  });
}

function fromWorkflow(a: WorkflowAnalysis) {
  const labels = mediaLabels(a.media);
  const media: MediaRow[] = a.media.map((m, i) => ({
    key: `${m.node}|${m.input}`, on: m.suggested, kind: m.kind, label: labels[i], hint: "", required: true, sample: m.sample,
    where: m.found === "setting" ? `${m.title} · ${m.input} · #${m.node}` : `${m.title} · #${m.node}`, node: m.node, input: m.input,
    found: m.found, value: m.value,
  }));
  const pick = a.prompt ? `${a.prompt.node}|${a.prompt.input}` : "";
  const text = a.texts.find((t) => `${t.node}|${t.input}` === pick);
  const prompt: PromptState = { pick, label: "Prompt", hint: "Describe what you want", def: text?.value ?? "", required: true };
  // The workflow is a black box: a template writes its inputs and its prompt, nothing else.
  const params: ParamRow[] = [];
  const details: Details = { label: fileTitle(a.source), blurb: "", mode: a.mode, tags: "" };
  const output: OutputState = { result: a.outputs[0] ?? "", size: "" };
  return a.preset ? withPreset(a.preset, { media, prompt, params, details, output }) : { media, prompt, params, details, output };
}

/** Opened from a template: start from what it asks for, with its names, hints and defaults. */
function withPreset(p: BuildPreset, init: { media: MediaRow[]; prompt: PromptState; params: ParamRow[]; details: Details; output: OutputState }) {
  const at = (x: { node: string; input: string }) => `${x.node}|${x.input}`;
  const pm = new Map(p.media.map((m) => [at(m), m]));
  const pp = new Map(p.params.map((x) => [at(x), x]));
  return {
    media: init.media.map((r) => {
      const m = pm.get(r.key);
      return m ? { ...r, on: true, label: m.label ?? r.label, hint: m.hint ?? "", required: m.required ?? true, window: m.window ?? null, fps: m.fps ?? null } : { ...r, on: false };
    }),
    output: {
      result: p.outputs.find((o) => o) ?? init.output.result,
      size: "",
    },
    prompt: p.prompt
      ? { pick: at(p.prompt), label: p.prompt.label ?? "Prompt", hint: p.prompt.hint ?? "", def: p.prompt.default, required: p.prompt.required ?? true }
      : { ...init.prompt, pick: "" },
    params: init.params.map((r) => {
      const x = pp.get(r.id);
      return x ? { ...r, on: true, label: x.label, key: x.key, help: x.help ?? r.help } : { ...r, on: false };
    }),
    details: { label: p.label, blurb: p.blurb, mode: p.mode, tags: p.tags.join(", ") },
  };
}

/** A way a Router model runs, and the adapter inputs it shows. */
type RouterMode = { id: string; label: string; inputs: number[] };

const SET_LABEL: Record<string, string> = { frames: "Image to video", references: "From references", edit: "Video edit", extend: "Extend a video", style: "Style reference" };

/** The modes a Router model has, read off its adapter: its `models` routes, else its input sets. One mode or none: no picker. */
function routerModes(a: RouterAdapter): RouterMode[] {
  const idx = (roles: string[]) => a.inputs.flatMap((x, i) => (roles.includes(x.role) ? [i] : []));
  const text = { id: "text", label: a.mode === "motion" ? "Text to video" : "Text to image", inputs: [] };
  if (a.models?.length) {
    return a.models.map((m) => {
      const inputs = idx(m.takes);
      return inputs.length ? { id: m.model, label: runMode(a, inputs.map((i) => ({ sample: true, slot: i }))), inputs } : { ...text, id: m.model };
    });
  }
  const sets = [...new Set(a.inputs.flatMap((x) => x.set ?? []))];
  if (!sets.length) return [];
  const loose = a.inputs.flatMap((x, i) => (x.set?.length ? [] : [i]));
  return [text, ...sets.map((s) => ({
    id: s, label: SET_LABEL[s] ?? s, inputs: a.inputs.flatMap((x, i) => (x.set?.includes(s) ? [i] : [])).concat(loose).sort((x, y) => x - y),
  }))];
}

/** The mode the shown rows are in. */
const modeOf = (modes: RouterMode[], rows: MediaRow[]) => {
  const on = [...new Set(rows.filter((r) => r.on).map((r) => r.slot!))].sort((x, y) => x - y).join();
  return modes.find((m) => m.inputs.join() === on);
};

/** Show only the inputs a mode takes. Files in inputs it doesn't take are dropped: they'd be sent otherwise. */
const toMode = (m: RouterMode, rows: MediaRow[]): MediaRow[] =>
  rows.map((r) => (m.inputs.includes(r.slot!) ? { ...r, on: true } : { ...r, on: false, sample: null, own: false }));

/** A Router model: one row per input its adapter takes, all empty. The ones you fill are the template's inputs.
 *  A model with modes starts on its first: only that mode's inputs show. */
function fromAdapter(a: RouterAdapter) {
  const rows: MediaRow[] = a.inputs.map((x, i) => ({
    key: `${i}:0`, on: true, kind: x.type, label: x.role, hint: "", required: false, sample: null, where: x.role, slot: i, max: x.max,
  }));
  const first = routerModes(a)[0];
  const media = first ? toMode(first, rows) : rows;
  const prompt: PromptState = { pick: "prompt", label: "Prompt", hint: "", def: "", required: true };
  // Labels read "Name · Model": the model half is set, the name is yours to write.
  const details: Details = { label: ` · ${a.name}`, blurb: "", mode: a.mode, tags: "" };
  return { media, prompt, params: [] as ParamRow[], details, output: { result: "", size: "" } as OutputState };
}

/** What a Router model can't take together, among the inputs you filled: the same rules the server checks. */
function adapterProblems(a: RouterAdapter, rows: MediaRow[]): string[] {
  const roles = filledInputs(a, rows);
  const p: string[] = [];
  const clash = roles.flatMap((x, i) => roles.slice(i + 1).map((y) => [x, y] as const))
    .find(([x, y]) => x.set?.length && y.set?.length && !x.set.some((s) => y.set!.includes(s)));
  if (clash) p.push(`${a.name} takes ${clash[0].role} or ${clash[1].role}, not both`);
  for (const r of roles) if (r.needs && !roles.some((x) => x.role === r.needs)) p.push(`${r.role} needs a ${r.needs} as well`);
  const names = roles.map((r) => r.role);
  if (!clash && a.models?.length && !a.models.some((m) => names.every((n) => m.takes.includes(n))))
    p.push(`${a.name} can't take ${names.join(" and ")} together`);
  // A mode other than text needs a file in it, and an edit or extend needs its clip.
  const m = modeOf(routerModes(a), rows);
  if (m?.inputs.length) {
    const clip = m.inputs.find((i) => a.inputs[i].role.startsWith("Video to"));
    if (clip !== undefined && !roles.includes(a.inputs[clip])) p.push(`${m.label} needs a ${a.inputs[clip].role}`);
    else if (!roles.length) p.push(`${m.label} needs a file. Fill one of its inputs, or pick ${routerModes(a)[0].label}`);
  }
  return p;
}

type Filled = { sample: unknown; slot?: number };

/** The adapter inputs that have a file, in the adapter's order. */
const filledInputs = (a: RouterAdapter, rows: Filled[]) =>
  [...new Set(rows.filter((r) => r.sample).map((r) => r.slot!))].sort((x, y) => x - y).map((i) => a.inputs[i]);

/** What a Router run does, read off the inputs it fills: the same model makes different things from different inputs. */
function runMode(a: RouterAdapter, rows: Filled[]): string {
  const has = (role: string) => filledInputs(a, rows).some((r) => r.role === role);
  const any = rows.some((r) => r.sample);
  if (a.mode === "edit") return any ? "Photo edit" : "Text to image";
  if (has("Video to edit")) return "Video edit";
  if (has("Video to extend")) return "Extend a video";
  if (has("First frame")) return has("Last frame") ? "First and last frame" : "Image to video";
  return any ? "From references" : "Text to video";
}

// A workflow handed over from elsewhere (Import, a drop on another page).
let pending: File | null = null;
export function openInBuilder(file: File) {
  pending = file;
  go({ name: "build" });
}

/** A dropped or imported file that is a ComfyUI workflow goes to the builder. Returns true when it did. */
export async function workflowToBuilder(f: File): Promise<boolean> {
  if (!/\.json$/i.test(f.name) && f.type !== "application/json") return false;
  if (f.size > 50 * 1024 * 1024 || !looksLikeWorkflow(await f.text())) return false;
  openInBuilder(f);
  return true;
}

/** Media ComfyUI saved carries its workflow; offer to build from it when it isn't a generation. */
export const buildAction = (f: File) =>
  /\.(png|webp|mp4|webm|mov)$/i.test(f.name) ? { label: "Make a template from it", run: () => openInBuilder(f) } : undefined;

/** Does this text look like a ComfyUI workflow rather than a generation? */
export function looksLikeWorkflow(text: string): boolean {
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    if (Array.isArray(d.nodes) && "links" in d) return true;
    const vals = Object.values(d);
    return vals.length > 0 && vals.every((v) => !!v && typeof v === "object" && "class_type" in (v as object));
  } catch {
    return false;
  }
}

// ---- the page ------------------------------------------------------------------

/** Build a template: drop a ComfyUI workflow (local) or pick a Router model (cloud), choose what people fill in, name it. */
export function Builder({ from }: { from?: string }) {
  const toast = useApp((s) => s.toast);
  const openTemplate = useApp((s) => s.openTemplate);
  const qc = useQueryClient();
  const [src, setSrc] = useState<Source | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [prompt, setPrompt] = useState<PromptState>({ pick: "", label: "", hint: "", def: "", required: true });
  const [params, setParams] = useState<ParamRow[]>([]);
  const [details, setDetails] = useState<Details>({ label: "", blurb: "", mode: "edit", tags: "" });
  const [output, setOutput] = useState<OutputState>({ result: "", size: "" });
  const [saving, setSaving] = useState<"save" | "try" | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [track, setTrack] = useState<Track>("local");

  const load = (s: Source) => {
    const init = s.kind === "local" ? fromWorkflow(s.a) : fromAdapter(s.a);
    setSrc(s);
    setMedia(init.media);
    setPrompt(init.prompt);
    setParams(init.params);
    setDetails(init.details);
    setOutput(init.output);
    setSaveErr(null);
    setTried(false);
  };

  const readFile = async (f: File) => {
    setTrack("local");
    setReading(f.name);
    setReadErr(null);
    try {
      load({ kind: "local", a: await api.buildFromFile(f) });
    } catch (e) {
      setReadErr(errMsg(e));
    } finally {
      setReading(null);
    }
  };
  const readText = async (text: string) => {
    setReading("pasted workflow");
    setReadErr(null);
    try {
      load({ kind: "local", a: await api.buildFromText(text) });
    } catch (e) {
      setReadErr(errMsg(e));
    } finally {
      setReading(null);
    }
  };
  const pickModel = (a: RouterAdapter) => {
    setReadErr(null);
    load({ kind: "cloud", a });
  };

  useEffect(() => {
    if (pending) {
      const f = pending;
      pending = null;
      void readFile(f);
    }
  }, []);

  // #/build?from=<template>: its workflow, set up the way that template has it.
  useEffect(() => {
    if (!from) return;
    let live = true;
    setReading(from.split("/").pop() ?? from);
    setReadErr(null);
    api.buildFromTemplate(from)
      .then((a) => { if (live) load({ kind: "local", a }); })
      .catch((e) => { if (live) setReadErr(errMsg(e)); })
      .finally(() => { if (live) setReading(null); });
    return () => { live = false; };
  }, [from]);

  // Pasting a workflow anywhere on the start screen reads it.
  useEffect(() => {
    if (src || track !== "local") return;
    const on = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (looksLikeWorkflow(text)) {
        e.preventDefault();
        void readText(text);
      }
    };
    window.addEventListener("paste", on);
    return () => window.removeEventListener("paste", on);
  }, [src, track]);

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!details.label.split(" · ")[0].trim()) p.push("Give the template a name");
    if (src && !media.some((m) => m.on) && !prompt.pick) p.push("Ask for at least one input or a prompt");
    if (params.some((r) => r.on && !r.label.trim())) p.push("Name every control");
    if (src?.kind === "local" && !output.result) p.push("Pick the node the result comes from");
    if (src && prompt.pick && prompt.required && !prompt.def.trim()) p.push("Write the prompt the first run uses");
    if (src?.kind === "cloud") p.push(...adapterProblems(src.a, media));
    return p;
  }, [details.label, media, prompt.pick, prompt.required, prompt.def, params, src, output.result]);

  // Width and height on the output size's node belong to it, not to the controls.
  const sizeOwns = (r: ParamRow) => !!output.size && r.node === output.size && (r.input === "width" || r.input === "height");

  const spec = (): BuildSpec | null => {
    if (!src) return null;
    // A Router template is frozen to the inputs its first run fills: empty ones aren't in it.
    const on = media.filter((m) => m.on && (src.kind === "local" || m.sample));
    const shown = params.filter((r) => r.on && !sizeOwns(r));
    const base = {
      label: details.label.trim(), blurb: details.blurb.trim(), mode: details.mode,  // mode: the server reads it off the result node for workflows
      tags: details.tags.split(",").map((t) => t.trim()).filter(Boolean),
      media: on.map((m) => ({
        node: m.node, input: src.kind === "cloud" ? m.slot : m.input, kind: m.kind, label: "", hint: "", required: src.kind === "cloud" || m.required, sample: m.sample?.asset ?? null,
      })),
      prompt: prompt.pick ? {
        label: "Prompt", hint: "", default: prompt.def, required: prompt.required,
        ...(src.kind === "local" ? { node: prompt.pick.split("|")[0], input: prompt.pick.split("|")[1] } : {}),
      } : null,
      params: shown.map((r) => ({ node: r.node, input: r.input, key: r.key ?? r.name.split(".").pop(), type: r.type, label: r.label.trim(), min: r.min, max: r.max, step: r.step, options: r.options, default: r.value, help: r.help })),
    };
    if (src.kind === "local") {
      const fixed = params.filter((r) => !r.on && !sizeOwns(r) && JSON.stringify(r.value) !== JSON.stringify(r.orig)).map((r) => ({ node: r.node!, input: r.input!, value: r.value }));
      const size = output.size ? { node: output.size, ...(output.keep ?? {}) } : null;
      return { kind: "local", token: src.a.token, base: src.a.preset?.base, ...base, fixed, outputs: [output.result], size };
    }
    // The adapter writes the request: the files go where it says, the rest is the model's defaults.
    return { kind: "cloud", model: src.a.model, ...base };
  };

  // A first run needs something in every input it asks for.
  const noSample = media.find((m) => m.on && m.required && !m.sample);
  const why = problems[0] ?? (noSample ? `Drop a sample into ${slotNames(media.filter((m) => m.on))[media.filter((m) => m.on).indexOf(noSample)]} first.` : "");

  const save = async (then: "save" | "try") => {
    setTried(true);
    if (problems.length || (then === "try" && why)) return;
    const s = spec();
    if (!s) return;
    setSaving(then);
    setSaveErr(null);
    try {
      const e = await api.saveTemplate(s);
      await qc.invalidateQueries({ queryKey: ["engines"] });
      if (then === "try") {
        openTemplate(e.mode, e.id);
        autorun.engine = e.id;
        go({ name: e.mode });
        toast({ text: `${e.label} saved as a draft and running once. Publish the result you like: it becomes the cover.`, tone: "ok" });
      } else {
        go({ name: "explore", t: e.id });
        toast({ text: `${e.label} saved to your drafts. It goes on Explore once you publish a result.`, tone: "ok" });
      }
    } catch (e) {
      setSaveErr(errMsg(e));
    } finally {
      setSaving(null);
    }
  };

  // Back to step 1. Asks first only when there's something of yours to lose.
  const reset = async () => {
    if (src && (details.label.split(" · ")[0].trim() || media.some((m) => m.own))) {
      const res = await confirm({ tone: "neutral", icon: "undo", view: () => ({ title: "Start over?", body: "What you set up for this template is lost. Nothing is saved yet.", action: "Start over" }) });
      if (!res.ok) return;
    }
    setSrc(null);
    setReadErr(null);
    if (from) go({ name: "build" });
  };

  return (
    <div className="page">
      <div className="scroll">
        <PageHead title="Build a template" />
        <div className={cx("build", src && "wide")}>
          {!src && (
            <div className="build-h">
              <Tabs track={track} setTrack={(t) => { setTrack(t); setReadErr(null); }} />
              <h2>{track === "cloud" ? "Turn a Comfy Router model into a template." : "Turn a ComfyUI workflow into a template."}</h2>
              <p>{track === "cloud"
                ? "Pick a model and what it does, fill its inputs, run it once. The result becomes its cover on Explore."
                : "Bring a workflow that already works, drop in samples, run it once. The result becomes its cover on Explore."}</p>
            </div>
          )}
          <Steps at={src ? 2 : 1} cloud={src ? src.kind === "cloud" : track === "cloud"} onBack={() => void reset()} />
          {!src ? (
            <Start track={track} reading={reading} error={readErr} onFile={readFile} onModel={pickModel} />
          ) : (
            <>
              <button className="btn sm ghost bld-back" type="button" onClick={() => void reset()}><I n="left" />{src.kind === "cloud" ? "Back to models" : "Back to workflows"}</button>
              <TitleField d={details} setD={setDetails} invalid={tried && !details.label.split(" · ")[0].trim()} />
              <SourceBar src={src} />
              <div className="bform">
                <InputsSection src={src} rows={media} setRows={setMedia} />
                <PromptSection src={src} p={prompt} setP={setPrompt} />
                {src.kind === "local" && src.a.results.length !== 1 && <ResultSection a={src.a} o={output} setO={setOutput} />}
              </div>
              <div className="build-foot">
                {saveErr && <div className="errbox" role="alert"><b>Couldn't save</b><p>{saveErr}</p></div>}
                <div className="bf-row">
                  <button className="btn ghost" type="button" onClick={() => void reset()}><I n="left" /><span className="lbl">Back</span></button>
                  <p className={cx("help", why && "why")} role={tried && why ? "alert" : undefined}>{why || "Runs it with these samples. Publish the result you like: it becomes the cover."}</p>
                  <button className="btn primary" type="button" disabled={!!saving || !!why} onClick={() => save("try")} title={why || undefined}>{saving ? <Spinner size={13} /> : <I n="zap" />}Run</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Steps({ at, cloud, onBack }: { at: 1 | 2; cloud?: boolean; onBack: () => void }) {
  const steps = cloud
    ? [["Pick a model", "On Comfy Router"], ["Fill inputs", "Only what you fill is kept"], ["Run and publish", "The result is the cover"]]
    : [["Bring a workflow", "Saved or exported from ComfyUI"], ["Check inputs", "Found in the workflow"], ["Run and publish", "The result is the cover"]];
  return (
    <ol className="steps" aria-label="Steps">
      {steps.map(([t, sub], i) => (
        <li key={t} className={cx(at === i + 1 && "on", at > i + 1 && "done")} aria-current={at === i + 1 ? "step" : undefined}>
          {at > i + 1 ? (
            <button type="button" className="steps-back" onClick={onBack} title={`Back to ${t.toLowerCase()}`}>
              <span className="n"><I n="check" /></span><span><b>{t}</b><span>Back to this step</span></span>
            </button>
          ) : (
            <><span className="n">{i + 1}</span><span><b>{t}</b><span>{sub}</span></span></>
          )}
        </li>
      ))}
    </ol>
  );
}

// ---- start -----------------------------------------------------------------------

type Track = "local" | "cloud";

function Tabs({ track, setTrack }: { track: Track; setTrack: (t: Track) => void }) {
  return (
    <div className="seg bld-tabs" role="tablist" aria-label="Build from">
      {([["local", "cpu", "Local workflow"], ["cloud", "cloud", "Comfy Router"]] as const).map(([t, icon, label]) => (
        <button key={t} type="button" role="tab" aria-selected={track === t} aria-pressed={track === t} onClick={() => setTrack(t)}>
          <I n={icon} />{label}
        </button>
      ))}
    </div>
  );
}

function Start({ track, reading, error, onFile, onModel }: { track: Track; reading: string | null; error: string | null; onFile: (f: File) => void; onModel: (a: RouterAdapter) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div className="bld-start" data-own-drop
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
      {error && <div className="errbox bld-err" role="alert"><b>{track === "cloud" ? "Couldn't read that model" : "Couldn't read that"}</b><p>{error}</p></div>}
      {track === "local" ? <LocalStart reading={reading} over={over} onFile={onFile} /> : <RouterStart onModel={onModel} />}
    </div>
  );
}

function LocalStart({ reading, over, onFile }: { reading: string | null; over: boolean; onFile: (f: File) => void }) {
  const status = useStatus();
  const input = useRef<HTMLInputElement>(null);
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const comfyUp = !!status.data?.local.comfyui;
  const sample = engines.data?.find((e) => e.id === "local/qwen21-add-hat");
  const busy = !!reading && !reading.includes("/");
  return (
    <>
      <button type="button" className={cx("dropwf", over && "drag")} onClick={() => input.current?.click()} disabled={busy}>
        <span className="ic">{busy ? <Spinner size={20} /> : <I n="upload" />}</span>
        <b>{busy ? `Reading ${reading}…` : over ? "Drop it" : "Drop a ComfyUI workflow"}</b>
        <p>The .json you saved or exported from ComfyUI, or a .png, .webp or .mp4 ComfyUI made: they carry the workflow inside. Pasting the JSON works too.</p>
      </button>
      <input ref={input} type="file" hidden accept=".json,.png,.webp,.mp4,.webm,.mov,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      {!comfyUp && status.data && <p className="bc-warn"><I n="alert" />ComfyUI isn't running. The builder reads node definitions from it, so start it first.</p>}
      {sample && (
        <div className="try-wf"><button className="btn ghost" type="button" disabled={!!reading} onClick={() => go({ name: "build", from: sample.id })}>
          {reading === sample.id.split("/").pop() ? <Spinner size={13} /> : <I n="play" />}Try it with the {tplName(sample)} workflow
        </button></div>
      )}
      <div className="contract">
        <div><b>It works in ComfyUI first</b>If the workflow runs there, it runs here. Missing nodes and models are listed for you, never installed.</div>
        <div><b>Inputs and a prompt, nothing else</b>People drop in photos or clips and edit the prompt. The workflow runs as a black box, exactly as you saved it.</div>
        <div><b>One run, then publish</b>Your first good result becomes the cover on Explore. No result, no template.</div>
      </div>
    </>
  );
}

function RouterStart({ onModel }: { onModel: (a: RouterAdapter) => void }) {
  const status = useStatus();
  const hasKey = !!status.data?.has_key;
  const models = useQuery({ queryKey: ["builder-models"], queryFn: api.builderModels, staleTime: Infinity });
  return (
    <>
      {!hasKey ? (
        <div className="dropwf bc-gate">
          <span className="ic"><I n="key" /></span>
          <b>Add a Comfy API key</b>
          <p>Router models are paid and run on your Comfy account. The key pays for the first run.</p>
          <a className="btn primary" href="#/settings">Add a key in Settings</a>
        </div>
      ) : (
        models.isLoading ? <div className="bc-empty"><Spinner size={14} />Loading models</div>
          : models.isError ? <div className="bc-empty">{errMsg(models.error)}</div>
          : (["motion", "edit"] as const).map((mode) => {
            const list = (models.data ?? []).filter((m) => m.mode === mode);
            return list.length > 0 && (
              <section key={mode} className="bc-group" aria-label={mode === "motion" ? "Video models" : "Photo models"}>
                <h3><I n={mode === "motion" ? "film" : "image"} />{mode === "motion" ? "Make video" : "Make photos"}<span className="mono">{list.length}</span></h3>
                <div className="bc-grid">{list.map((m) => <ModelCard key={m.model} m={m} onPick={() => onModel(m)} />)}</div>
              </section>
            );
          })
      )}
      <div className="contract">
        <div><b>Ten models, every mode</b>Pick a model, then what it does: text to video, frames, references, an edit. Each mode shows only the inputs it takes.</div>
        <div><b>Inputs and a prompt, nothing else</b>Fill the inputs you want and leave the rest empty. The template asks for exactly what you filled, every run.</div>
        <div><b>One run, then publish</b>The first run costs credits. Its result becomes the cover on Explore.</div>
      </div>
    </>
  );
}

const MAKER: Record<string, string> = { kling: "Kuaishou", byteplus: "ByteDance", veo: "Google", vertexai: "Google", wan: "Alibaba", openai: "OpenAI", bfl: "Black Forest Labs", xai: "xAI" };

/** What a Router model can do, in the Builder's mode names: its tabs, or for a one-mode photo model, text and edit. */
const modeNames = (a: RouterAdapter) => {
  const tabs = routerModes(a).map((m) => m.label);
  if (tabs.length) return tabs;
  return a.mode === "edit" ? (a.inputs.length ? ["Text to image", "Photo edit"] : ["Text to image"]) : ["Text to video"];
};

/** One Router model on the start screen: who makes it, what it does, what it takes. */
function ModelCard({ m, onPick }: { m: RouterAdapter; onPick: () => void }) {
  const provider = m.model.split("/")[0];
  const video = m.mode === "motion";
  return (
    <button type="button" className={cx("bc-card", video ? "v" : "p")} onClick={onPick} aria-label={`${m.name}: ${modeNames(m).join(", ")}`}>
      <span className="bc-top">
        <span className="bc-mono" aria-hidden>{m.name.slice(0, 2)}</span>
        <span className="bc-mt"><b>{m.name}</b><span>{MAKER[provider] ?? provider}<i className="mono">{m.model.split("/")[1]}</i></span></span>
        <I n="arrow" className="bc-go" />
      </span>
      <span className="bc-row"><span className="bc-lab">Does</span>
        <span className="bc-chips">{modeNames(m).map((n) => <span key={n} className="bc-mode">{n}</span>)}</span>
      </span>
      <span className="bc-row takes"><span className="bc-lab">Takes</span>
        <span className="bc-chips">
          {m.inputs.length ? m.inputs.map((x) => (
            <span key={x.role} className="bc-role" title={x.needs ? `Needs a ${x.needs}` : undefined}>
              <I n={KIND_ICON[x.type]} />{x.role}{x.max > 1 && <span className="mono">×{x.max}</span>}
            </span>
          )) : <span className="bc-role none">Prompt only</span>}
        </span>
      </span>
    </button>
  );
}

// ---- sections ------------------------------------------------------------------

function Sec({ id, icon, color, title, desc, aside, children }: { id: string; icon: IconName; color?: string; title: string; desc: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="bsec" aria-labelledby={`bld-${id}`} style={color ? ({ "--c": color } as CSSProperties) : undefined}>
      <div className="bsec-h">
        <span className="ic"><I n={icon} /></span>
        <div><h3 id={`bld-${id}`}>{title}</h3><p>{desc}</p></div>
        {aside}
      </div>
      {children}
    </section>
  );
}

function SourceBar({ src }: { src: Source }) {
  const [open, setOpen] = useState(false);
  if (src.kind === "cloud") {
    return (
      <div className="bld-source">
        <span className="bc-ic cloud"><I n="cloud" /></span>
        <div><b>{src.a.name}</b><span className="mono">{src.a.model} · Comfy Router · makes {src.a.mode === "motion" ? "video" : "photos"}</span></div>
      </div>
    );
  }
  const a = src.a;
  const c = a.check;
  const loaders = new Set(a.media.map((m) => m.node));
  const bad = c.bad_values.filter((b) => !loaders.has(b.node_id));
  const missing = c.missing_nodes.length + c.missing_models.length;
  return (
    <div className="bld-source-wrap">
      <div className="bld-source">
        <span className="bc-ic local"><I n="graph" /></span>
        <div>
          <b className="mono">{a.source}</b>
          <span>{a.nodes} nodes · {a.preset ? "from the template, set up as it is" : a.format === "ui" ? "converted from the saved workflow" : "API format"}</span>
        </div>
        {missing ? <span className="pill rose"><I n="alert" />{missing} missing</span> : <span className="pill"><i className="dot" />Ready to run</span>}
      </div>
      {(missing > 0 || bad.length > 0 || a.notes.length > 0) && (
        <div className={cx("bld-check", missing > 0 && "warn")}>
          {missing > 0 && <p><b>Your ComfyUI is missing things this workflow uses.</b> The template saves anyway; runs fail until they're installed.</p>}
          <button type="button" className="bld-fold" aria-expanded={open} onClick={() => setOpen(!open)}><I n={open ? "down" : "right"} />{open ? "Hide details" : "Show details"}</button>
          {open && (
            <ul>
              {c.missing_nodes.map((m) => <li key={m.class_type}><span className="tag">Node</span><code>{m.class_type}</code></li>)}
              {c.missing_models.map((m) => <li key={m.node_id + m.input}><span className="tag">Model</span><code>{m.value}</code></li>)}
              {bad.map((b) => <li key={b.node_id + b.input}><span className="tag">Value</span><code>{b.class_type}.{b.input} = {String(b.value)}</code></li>)}
              {a.notes.map((n) => <li key={n}><span className="tag">Note</span>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** "Image 1", "Video 1": an input is named by its place among its kind, the same way Create shows it. */
const slotNames = (rows: { kind: MediaKind }[]) => {
  const n: Record<string, number> = {};
  return rows.map((r) => `${KIND_NOUN[r.kind]} ${(n[r.kind] = (n[r.kind] ?? 0) + 1)}`);
};

function InputsSection({ src, rows, setRows }: { src: Source; rows: MediaRow[]; setRows: (f: (r: MediaRow[]) => MediaRow[]) => void }) {
  const { upload, busy } = useUploader();
  const up = (key: string, p: Partial<MediaRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const pickSample = async (r: MediaRow, f?: File) => {
    if (!f) return;
    const [a] = await upload([f], r.kind);
    if (a) up(r.key, { sample: a, own: true });
  };
  // A Router input that takes several files gets one row each.
  const group = (r: MediaRow) => (r.slot !== undefined ? `in${r.slot}` : r.key);
  const addSlot = (r0: MediaRow) => setRows((rs) => {
    const same = rs.filter((r) => group(r) === group(r0));
    const last = same[same.length - 1];
    const row: MediaRow = { ...last, key: `${last.slot}:${same.length}`, sample: null, own: false };
    const at = rs.indexOf(last) + 1;
    return [...rs.slice(0, at), row, ...rs.slice(at)];
  });
  const cloud = src.kind === "cloud";
  const shown = rows.filter((r) => r.on);
  // "Image 1", "Image 2": a Router template's inputs are the filled rows, in order.
  const filled = slotNames(shown.filter((r) => !cloud || r.sample));
  let k = 0;
  const names = shown.map((r) => (!cloud || r.sample ? filled[k++] : r.label));
  const modes = cloud ? routerModes(src.a) : [];
  const mode = modeOf(modes, rows);
  return (
    <Sec id="in" icon="upload" color="var(--mint)" title="Inputs"
      desc={cloud
        ? `${modes.length ? `Pick what this template does, then fill` : "Fill"} the inputs it uses: it asks for exactly those, and empty ones aren't in it.`
        : "Found in the workflow. Drop a sample into each: the first run uses it, and it ships as the template's default."}
      aside={cloud ? (modes.length ? undefined : <span className="mono">{runMode(src.a, shown)}</span>) : shown.length ? <span className="mono">{shown.length}</span> : undefined}>
      {modes.length > 0 && (
        <div className="seg bld-modes" role="radiogroup" aria-label="What this template does">
          {modes.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode?.id === m.id} aria-pressed={mode?.id === m.id}
              onClick={() => setRows((rs) => toMode(m, rs))}>{m.label}</button>
          ))}
        </div>
      )}
      {!shown.length ? (
        <p className="help">{src.kind === "local" ? "No photo or video loaders in this workflow. People only write the prompt."
          : modes.length ? "No files: people only write the prompt." : "This model takes no media. People only write the prompt."}</p>
      ) : (
        <div className="bslots">
          {shown.map((r, i) => {
            const lastOfField = (r.max ?? 1) > 1 && shown.filter((x) => group(x) === group(r)).slice(-1)[0]?.key === r.key;
            const count = shown.filter((x) => group(x) === group(r)).length;
            const noun = r.kind === "video" ? "clip" : r.kind === "audio" ? "sound" : "photo";
            return (
              <div key={r.key} className={cx("bslot", r.sample && "has")} style={{ "--i": i } as CSSProperties}>
                <SlotDrop r={r} name={names[i]} busy={busy > 0} onFile={(f) => void pickSample(r, f)} />
                <div className="bmeta">
                  <div className="bmeta-top"><b>{names[i]}</b>{(!cloud || r.sample) && <span className="nd" title={r.where}>{r.where}</span>}</div>
                  <div className="bsub">
                    {r.sample ? <><span className={r.own ? "tag-own" : "tag-sample"}>{r.own ? "YOURS" : "SAMPLE"}</span><span className="mono" title={r.sample.name}>{r.sample.width && r.sample.height ? `${r.sample.width}×${r.sample.height}` : r.sample.name}</span>
                      <button className="bld-x" type="button" onClick={() => up(r.key, { sample: null, own: false })}>Remove</button></>
                      : <span className={r.required ? "need" : undefined}>{r.required ? `Needs a sample ${noun}` : cloud ? "Empty: not in the template" : "Optional"}</span>}
                  </div>
                  {lastOfField && count < (r.max ?? 1) && <div className="bmeta-foot"><button className="btn sm ghost" type="button" onClick={() => addSlot(r)}><I n="plus" />Another {noun}</button></div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Sec>
  );
}

function PromptSection({ src, p, setP }: { src: Source; p: PromptState; setP: (f: (p: PromptState) => PromptState) => void }) {
  const set = (k: keyof PromptState) => (e: { target: { value: string } }) => setP((x) => ({ ...x, [k]: e.target.value }));
  const options = src.kind === "local"
    ? src.a.texts.map((t) => ({ id: `${t.node}|${t.input}`, node: t.node, label: `${t.title} · ${human(t.input)}`, tag: t.polarity === "negative" ? "Negative" : t.polarity === "positive" ? "Positive" : null, value: t.value }))
    : [{ id: "prompt", node: "", label: "Prompt", tag: null, value: "" }];
  const choose = (id: string) => setP((x) => {
    const o = options.find((v) => v.id === id);
    return { ...x, pick: id, def: o && (!x.def || options.some((v) => v.value === x.def)) ? o.value : x.def };
  });
  const unsure = src.kind === "local" && !p.pick && !src.a.prompt && src.a.texts.filter((t) => t.polarity !== "negative").length > 1;
  return (
    <Sec id="pr" icon="pencil" color="var(--violet)" title="Prompt" desc="What the template opens with. People can change any word on Create; it's sent exactly as written.">
      {!options.length ? (
        <p className="help">No text box in this workflow takes a prompt. The template runs on its inputs alone.</p>
      ) : (
        <>
          {unsure && <p className="bwarn"><I n="alert" />{src.a.texts.length} text boxes could be the prompt, so none is picked. Pick the one people write in.</p>}
          {(options.length > 1 || !p.pick) && <div className="bchoice" role="radiogroup" aria-label="Prompt goes into">
            {options.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={p.pick === o.id} onClick={() => choose(o.id)} title={o.label}>
                {o.node && <span className="nd">#{o.node}</span>}
                <span className="tx">{o.value || o.label}</span>
                {o.tag && <span className="tag">{o.tag}</span>}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={!p.pick} onClick={() => setP((x) => ({ ...x, pick: "" }))}><span className="tx">No prompt. The text stays as saved.</span></button>
          </div>}
          {p.pick && (
            <textarea className="textarea bprompt" aria-label="The prompt the template opens with" rows={Math.min(10, Math.max(3, Math.ceil(p.def.length / 70)))} value={p.def} maxLength={4000} onChange={set("def")} placeholder="The prompt the template starts with" spellCheck={false} />
          )}
        </>
      )}
    </Sec>
  );
}

/** Local: the save node a run keeps. Only asked when the workflow has more than one, or none. */
function ResultSection({ a, o, setO }: { a: WorkflowAnalysis; o: OutputState; setO: (f: (o: OutputState) => OutputState) => void }) {
  const pick = (id: string) => setO((x) => ({ ...x, result: id }));
  return (
    <Sec id="rs" icon="check" color="var(--yellow)" title="The result" desc="This workflow saves more than one thing. Pick the one a run keeps.">
      {!a.results.length ? (
        <p className="bwarn err"><I n="alert" />No save node. Add Save Image or Save Video in ComfyUI, then drop the workflow again.</p>
      ) : (
        <>
          <div className="bchoice" role="radiogroup" aria-label="Result node">
            {a.results.map((r) => (
              <button key={r.node} type="button" role="radio" aria-checked={o.result === r.node} onClick={() => pick(r.node)}>
                <span className="nd">#{r.node}</span><span className="tx">{r.title}</span>
                <span className={cx("pill kind", r.kind === "video" && "v")}><I n={r.kind === "video" ? "film" : "image"} />{r.kind === "video" ? "Video" : "Photo"}</span>
              </button>
            ))}
          </div>
          {a.results.length > 1 && <p className="help">The other save nodes still run as the workflow has them; their files aren't kept.</p>}
        </>
      )}
    </Sec>
  );
}

/** The template's name, up top: it's what Explore, Create and the Library show. */
function TitleField({ d, setD, invalid }: { d: Details; setD: (f: (d: Details) => Details) => void; invalid: boolean }) {
  // Labels read "Name · Model"; the model half rides along untouched.
  const [name, ...rest] = d.label.split(" · ");
  const model = rest.join(" · ");
  return (
    <div className={cx("bname", invalid && "bad")}>
      <label htmlFor="bd-label">Template name</label>
      <div className="bname-in">
        <span className="bname-f">
          <input id="bd-label" value={name} maxLength={60} placeholder="Name your template" spellCheck={false} aria-invalid={invalid || undefined}
          onChange={(e) => { const v = e.target.value.replace(/ · /g, " "); setD((x) => ({ ...x, label: model ? `${v} · ${model}` : v })); }} />
          <I n="pencil" />
        </span>
        {model && <span className="pill bname-m" title="The model, shown under the name on Explore">{model}</span>}
      </div>
      {invalid && <span className="bname-err" role="alert">Give it a name. Explore, Create and your Library show it.</span>}
    </div>
  );
}

/** A media input's sample: a drop zone in the input's shape. Click to pick a file, or drop one on it. */
function SlotDrop({ r, name, busy, onFile }: { r: MediaRow; name: string; busy: boolean; onFile: (f: File) => void }) {
  const toast = useApp((s) => s.toast);
  const fits = (f: File) => (r.kind === "audio" ? f.type.startsWith("audio/") : r.kind === "video" ? isVideo(f) : isImage(f));
  const noun = r.kind === "video" ? "clip" : r.kind === "audio" ? "sound" : "photo";
  const drop = useFileDrop((files) => onFile(files[0]), {
    accept: fits, disabled: busy || !r.on,
    onReject: (files) => toast({ text: `${name} takes a ${r.kind === "video" ? "video clip" : noun}. ${files[0].name} isn't one.`, tone: "warn" }),
  });
  return (
    <label className={cx("bdrop", r.kind === "video" && "v", drop.over && "drag")} title={r.sample ? "Replace the sample: click or drop a file" : `Choose a ${noun}`} {...drop.props}>
      {busy ? <span className="bd-ic"><Spinner size={16} /></span>
        : r.sample ? <>
          <img src={r.sample.poster ?? r.sample.url} alt={`${name} sample`} />
          {r.kind === "video" && <span className="play"><I n="play" /></span>}
          <span className="swap"><I n="upload" />Replace</span>
        </> : <>
          <span className="bd-ic"><I n={KIND_ICON[r.kind]} /></span>
          <b>{drop.over ? "Drop it" : `Drop a ${noun}`}</b>
          <span>or click to choose</span>
        </>}
      <input type="file" hidden accept={r.kind === "video" ? "video/*" : r.kind === "image" ? "image/*" : "audio/*"} disabled={busy || !r.on} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </label>
  );
}

