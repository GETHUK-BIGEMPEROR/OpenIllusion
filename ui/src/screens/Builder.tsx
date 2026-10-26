import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { I, PageHead, useStatus } from "../components/oi";
import { isImage, isVideo, useFileDrop } from "../components/Drop";
import { useUploader } from "../components/Refs";
import { cx, Spinner } from "../components/ui";
import {
  api, type Asset, type BuildParamType, type BuildPreset, type BuildSpec, type MediaKind, type Mode, type SchemaAnalysis, type WorkflowAnalysis,
} from "../lib/api";
import { confirm } from "../lib/confirm";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

// ---- state ---------------------------------------------------------------------

interface MediaRow {
  key: string;
  on: boolean;
  kind: MediaKind;
  label: string;
  hint: string;
  required: boolean;
  sample: Asset | null;
  where: string; // what it maps to, shown small
  node?: string;
  input?: string;
  field?: string;
  many?: boolean;
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
  field?: string;
  key?: string; // the template's name for it, when opened from a template
}

interface PromptState {
  pick: string; // "node|input" for workflows, the field for cloud, "" for none
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
  | { kind: "cloud"; a: SchemaAnalysis };

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
  const params: ParamRow[] = a.params.map((p) => ({
    id: `${p.node}|${p.input}`, on: p.suggested, label: human(p.input), type: p.type, value: p.value, orig: p.value,
    group: `${p.title} · #${p.node}`, name: p.input, min: p.min, max: p.max, step: p.step, options: p.options, help: p.help,
    suggested: p.suggested, node: p.node, input: p.input,
  }));
  const details: Details = { label: fileTitle(a.source), blurb: "", mode: a.mode, tags: "" };
  const output: OutputState = { result: a.outputs[0] ?? "", size: a.size?.node ?? "" };
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
      size: p.size?.node ?? "",
      keep: p.size ? { label: p.size.label, aspect: p.size.aspect, default: p.size.default } : undefined,
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

function fromSchema(a: SchemaAnalysis, model: string) {
  const media: MediaRow[] = a.media.map((m) => ({
    key: `${m.field}#0`, on: true, kind: m.kind, label: m.many ? `${KIND_NOUN[m.kind]} 1` : human(m.field), hint: m.help ?? "",
    required: m.required, sample: null, where: m.many ? `${m.field}[0]` : m.field, field: m.field, many: m.many, max: m.max,
  }));
  const prompt: PromptState = { pick: a.prompt?.field ?? "", label: "Prompt", hint: "Describe what you want", def: "", required: a.prompt?.required ?? true };
  const params: ParamRow[] = a.params.map((p) => ({
    id: p.field, on: p.suggested, label: p.title, type: p.type, value: p.value ?? null, orig: p.value ?? null, group: "Request",
    name: p.field, min: p.min, max: p.max, step: p.step, options: p.options, help: p.help, suggested: p.suggested, field: p.field,
  }));
  const details: Details = { label: model.split("/").pop()!.replace(/[-_]+/g, " "), blurb: "", mode: a.mode, tags: "" };
  return { media, prompt, params, details, output: { result: "", size: "" } as OutputState };
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

  const load = (s: Source, model?: string) => {
    const init = s.kind === "local" ? fromWorkflow(s.a) : fromSchema(s.a, model ?? s.a.model);
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
  const pickModel = async (model: string) => {
    setReading(model);
    setReadErr(null);
    try {
      load({ kind: "cloud", a: await api.buildSchema(model) }, model);
    } catch (e) {
      setReadErr(errMsg(e));
    } finally {
      setReading(null);
    }
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
    if (src) return;
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
  }, [src]);

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!details.label.trim()) p.push("Give the template a name");
    if (src && !media.some((m) => m.on) && !prompt.pick) p.push("Ask for at least one input or a prompt");
    if (media.some((m) => m.on && !m.label.trim())) p.push("Name every input");
    if (params.some((r) => r.on && !r.label.trim())) p.push("Name every control");
    const bad = (v?: [number, number] | null) => !!v && !(v[0] > 0 && v[0] <= v[1]);
    if (media.some((m) => m.on && (bad(m.window) || bad(m.fps)))) p.push("Clip limits run from a lowest to a highest value");
    if (src?.kind === "local" && !output.result) p.push("Pick the node the result comes from");
    return p;
  }, [details.label, media, prompt.pick, params, src, output.result]);

  // Width and height on the output size's node belong to it, not to the controls.
  const sizeOwns = (r: ParamRow) => !!output.size && r.node === output.size && (r.input === "width" || r.input === "height");

  const spec = (): BuildSpec | null => {
    if (!src) return null;
    const on = media.filter((m) => m.on);
    const shown = params.filter((r) => r.on && !sizeOwns(r));
    const base = {
      label: details.label.trim(), blurb: details.blurb.trim(), mode: details.mode,
      tags: details.tags.split(",").map((t) => t.trim()).filter(Boolean),
      media: on.map((m) => ({
        node: m.node, input: m.input, field: m.field, many: m.many, kind: m.kind, label: m.label.trim(), hint: m.hint.trim(), required: m.required, sample: m.sample?.asset ?? null,
        ...(m.kind === "video" ? { window: m.window ?? undefined, fps: m.fps ?? undefined } : {}),
      })),
      prompt: prompt.pick ? {
        label: prompt.label.trim() || "Prompt", hint: prompt.hint.trim(), default: prompt.def, required: prompt.required,
        ...(src.kind === "local" ? { node: prompt.pick.split("|")[0], input: prompt.pick.split("|")[1] } : { field: prompt.pick }),
      } : null,
      params: shown.map((r) => ({ node: r.node, input: r.input, field: r.field, key: r.key ?? r.name.split(".").pop(), type: r.type, label: r.label.trim(), min: r.min, max: r.max, step: r.step, options: r.options, default: r.value, help: r.help })),
    };
    if (src.kind === "local") {
      const fixed = params.filter((r) => !r.on && !sizeOwns(r) && JSON.stringify(r.value) !== JSON.stringify(r.orig)).map((r) => ({ node: r.node!, input: r.input!, value: r.value }));
      const size = output.size ? { node: output.size, ...(output.keep ?? {}) } : null;
      return { kind: "local", token: src.a.token, base: src.a.preset?.base, ...base, fixed, outputs: [output.result], size };
    }
    const fixed = Object.fromEntries(params.filter((r) => !r.on && r.value !== null && r.value !== undefined && r.value !== "" && JSON.stringify(r.value) !== JSON.stringify(r.orig)).map((r) => [r.field!, r.value]));
    return { kind: "cloud", model: src.a.model, ...base, fixed };
  };

  const save = async (then: "save" | "try") => {
    setTried(true);
    if (problems.length) return;
    const s = spec();
    if (!s) return;
    setSaving(then);
    setSaveErr(null);
    try {
      const e = await api.saveTemplate(s);
      await qc.invalidateQueries({ queryKey: ["engines"] });
      if (then === "try") {
        openTemplate(e.mode, e.id);
        go({ name: e.mode });
        toast({ text: `${e.label} saved as a draft. Run it, then publish the result you like.`, tone: "ok" });
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

  const reset = async () => {
    if (src) {
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
        <PageHead title={src ? "New template" : "Build a template"} actions={src ? <button className="btn ghost" type="button" onClick={() => void reset()}><I n="undo" />Start over</button> : undefined} />
        {!src ? (
          <Start reading={reading} error={readErr} onFile={readFile} onModel={pickModel} />
        ) : (
          <div className="bld-wrap">
            <div className="bld-main">
              <SourceBar src={src} onReplace={reset} />
              <InputsSection src={src} rows={media} setRows={setMedia} />
              <PromptSection src={src} p={prompt} setP={setPrompt} />
              {src.kind === "local" && <OutputSection a={src.a} o={output} setO={setOutput} mode={details.mode} setMode={(mode) => setDetails((d) => ({ ...d, mode }))} />}
              <ControlsSection n={src.kind === "local" ? 4 : 3} src={src} rows={params.filter((r) => !sizeOwns(r))} setRows={setParams} />
              <DetailsSection n={src.kind === "local" ? 5 : 4} d={details} setD={setDetails} invalid={tried && !details.label.trim()} />
            </div>
            <aside className="bld-side">
              <Preview details={details} media={media} prompt={prompt} params={params.filter((r) => !sizeOwns(r))} kind={src.kind} sized={output.size ? [output.keep?.aspect, output.keep?.default].filter(Boolean).join(" · ") || "shape · MP" : null} />
              <div className="bld-save">
                {tried && problems.length > 0 && <ul className="bld-problems" role="alert">{problems.map((p) => <li key={p}><I n="alert" />{p}</li>)}</ul>}
                {saveErr && <div className="errbox" role="alert"><b>Couldn't save</b><p>{saveErr}</p></div>}
                <div className="bld-save-row">
                  <button className="btn" type="button" disabled={!!saving} onClick={() => save("save")}>{saving === "save" ? <Spinner size={13} /> : <I n="check" />}Save draft</button>
                  <button className="btn primary" type="button" disabled={!!saving} onClick={() => save("try")}>{saving === "try" ? <Spinner size={13} /> : <I n="play" />}Save and run it</button>
                </div>
                <p className="help">Saved as a draft. It goes on Explore once you publish a result, and that result becomes its cover. Nothing runs and nothing installs until you press Run.</p>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- start -----------------------------------------------------------------------

function Start({ reading, error, onFile, onModel }: { reading: string | null; error: string | null; onFile: (f: File) => void; onModel: (m: string) => void }) {
  const status = useStatus();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [q, setQ] = useState("");
  const hasKey = !!status.data?.has_key;
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, enabled: hasKey, staleTime: 600_000 });
  const models = (catalog.data ?? []).filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase())).slice(0, 40);
  const comfyUp = !!status.data?.local.comfyui;

  return (
    <div className="bld-start" data-own-drop
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
      <div className="bld-intro">
        <h2>Turn a workflow into a template.</h2>
        <p>Pick what people drop in and type. Everything else stays as you set it. Run it once and publish a result: it goes on Explore next to the built-in ones, with that result as its cover.</p>
      </div>
      {error && <div className="errbox bld-err" role="alert"><b>Couldn't read that</b><p>{error}</p></div>}
      <div className="bld-choices">
        <section className={cx("bld-choice", over && "over")} aria-labelledby="bc-local">
          <div className="bc-top"><span className="bc-ic local"><I n="cpu" /></span><span className="pill"><i className="dot" />Local</span></div>
          <h3 id="bc-local">From a ComfyUI workflow</h3>
          <p>Runs on your GPU. Drop the workflow you saved from ComfyUI, or any image or video ComfyUI made: it carries its workflow inside.</p>
          <button type="button" className="bc-drop" onClick={() => input.current?.click()} disabled={!!reading}>
            {reading && !reading.includes("/") ? <><Spinner size={16} /><span>Reading {reading}…</span></> : <><I n="upload" /><span><b>Drop a workflow</b> or click to choose</span><small>.json (saved or API export), .png, .webp, .mp4 · or paste the JSON</small></>}
          </button>
          {!comfyUp && status.data && <p className="bc-warn"><I n="alert" />ComfyUI isn't running. The builder reads node definitions from it, so start it first.</p>}
          <input ref={input} type="file" hidden accept=".json,.png,.webp,.mp4,.webm,.mov,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
        </section>

        <section className="bld-choice" aria-labelledby="bc-cloud">
          <div className="bc-top"><span className="bc-ic cloud"><I n="cloud" /></span><span className="pill"><i className="dot violet" />Cloud</span></div>
          <h3 id="bc-cloud">From a cloud model</h3>
          <p>Runs on Comfy Router. Pick a model and decide which of its settings people see; the rest you fix once.</p>
          {!hasKey ? (
            <div className="bc-locked"><span>Needs a Comfy API key.</span><a className="btn sm" href="#/settings">Add a key</a></div>
          ) : (
            <div className="bc-models">
              <div className="bc-search"><I n="search" /><input className="input" placeholder="Search models" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search models" /></div>
              <div className="bc-list" role="listbox" aria-label="Models">
                {catalog.isLoading ? <div className="bc-empty"><Spinner size={14} />Loading models</div>
                  : catalog.isError ? <div className="bc-empty">{errMsg(catalog.error)}</div>
                  : models.length ? models.map((m) => (
                    <button key={m.id} type="button" role="option" aria-selected={false} className="bc-model" disabled={!!reading} onClick={() => onModel(m.id)}>
                      <span className="mono">{m.provider}</span><b>{m.model}</b>{reading === m.id ? <Spinner size={12} /> : <I n="right" />}
                    </button>
                  )) : <div className="bc-empty">No model matches “{q}”.</div>}
              </div>
            </div>
          )}
        </section>
      </div>
      <ol className="bld-how">
        <li><b>1</b><span><strong>Bring a recipe.</strong> A workflow you trust, or a model.</span></li>
        <li><b>2</b><span><strong>Choose the inputs.</strong> Which pictures, which words, which knobs.</span></li>
        <li><b>3</b><span><strong>Run it and publish.</strong> Your best result becomes the cover.</span></li>
      </ol>
    </div>
  );
}

// ---- sections ------------------------------------------------------------------

function Sec({ n, title, desc, aside, children }: { n: number; title: string; desc: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="bld-sec" aria-labelledby={`bld-s${n}`}>
      <header>
        <span className="bld-n">{n}</span>
        <div><h2 id={`bld-s${n}`}>{title}</h2><p>{desc}</p></div>
        {aside}
      </header>
      {children}
    </section>
  );
}

function SourceBar({ src, onReplace }: { src: Source; onReplace: () => void }) {
  const [open, setOpen] = useState(false);
  if (src.kind === "cloud") {
    return (
      <div className="bld-source">
        <span className="bc-ic cloud"><I n="cloud" /></span>
        <div><b className="mono">{src.a.model}</b><span>Comfy Router · {src.a.input_modalities.join(", ") || "text"} → {src.a.output_modalities.join(", ") || "?"}</span></div>
        <button className="btn sm ghost" type="button" onClick={onReplace}>Change</button>
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
        <button className="btn sm ghost" type="button" onClick={onReplace}>Change</button>
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

function InputsSection({ src, rows, setRows }: { src: Source; rows: MediaRow[]; setRows: (f: (r: MediaRow[]) => MediaRow[]) => void }) {
  const { upload, busy } = useUploader();
  const up = (key: string, p: Partial<MediaRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const pickSample = async (r: MediaRow, f?: File) => {
    if (!f) return;
    const [a] = await upload([f], r.kind === "audio" ? undefined : r.kind);
    if (a) up(r.key, { sample: a });
  };
  // Cloud array fields can take more than one picture: one slot each.
  const addSlot = (field: string) => setRows((rs) => {
    const same = rs.filter((r) => r.field === field);
    const last = same[same.length - 1];
    const n = same.length;
    const row: MediaRow = { ...last, key: `${field}#${n}`, label: `${KIND_NOUN[last.kind]} ${n + 1}`, hint: "", required: false, sample: null, where: `${field}[${n}]`, on: true };
    const at = rs.indexOf(last) + 1;
    return [...rs.slice(0, at), row, ...rs.slice(at)];
  });
  const removeSlot = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  const local = src.kind === "local";
  return (
    <Sec n={1} title="Inputs" desc={local ? "Every image and video loader in the workflow, and any setting that holds a file name. Ask for it, or keep the file that's in the workflow." : "The media fields this model takes."}>
      {!rows.length ? (
        <p className="bld-none">{local ? "This workflow loads no images or videos. People only type a prompt." : "This model takes no media. People only type a prompt."}</p>
      ) : (
        <div className="bld-media">
          {rows.map((r) => {
            const lastOfField = r.many && rows.filter((x) => x.field === r.field).slice(-1)[0]?.key === r.key;
            const count = rows.filter((x) => x.field === r.field).length;
            return (
              <div key={r.key} className={cx("bld-mrow", !r.on && "off")}>
                <SampleThumb r={r} busy={busy > 0} onFile={(f) => void pickSample(r, f)} />
                <div className="bld-mbody">
                  <div className="bld-mhead">
                    <span className="tag">{KIND_NOUN[r.kind]}</span>
                    {r.found === "setting" && <span className="tag" title="Not a loader ComfyUI marks as one: a setting whose value is a file name. Turn it on to send a file name here.">File setting</span>}
                    <span className="mono bld-where">{r.where}</span>
                    {r.sample && <button className="bld-x" type="button" onClick={() => up(r.key, { sample: null })}>Remove sample</button>}
                  </div>
                  {r.on ? (
                    <>
                      <div className="bld-mfields">
                        <input className="input" aria-label="Input name" placeholder="Name, like Photo or Outfit" value={r.label} maxLength={40} onChange={(e) => up(r.key, { label: e.target.value })} />
                        <input className="input" aria-label="Hint" placeholder="Hint: what makes a good one" value={r.hint} maxLength={160} onChange={(e) => up(r.key, { hint: e.target.value })} />
                      </div>
                      {local && r.kind === "video" && (
                        <div className="bld-limits">
                          <Range label="Length" unit="s" value={r.window ?? null} max={600} onChange={(window) => up(r.key, { window })} />
                          <Range label="Frame rate" unit="fps" value={r.fps ?? null} max={240} onChange={(fps) => up(r.key, { fps })} />
                          <p className="help">Optional. Clips outside these get flagged before a run, and the frame rate is fitted in. Left empty, the clip goes in as trimmed and the workflow's loader decides the rest.</p>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="bld-kept">{local ? <>Keeps <code>{r.value ?? "the workflow's file"}</code>. {r.found === "setting" ? "Turn it on to ask for a file here." : "People don't see this input."}</> : "Left out of the request."}</p>
                  )}
                  <div className="bld-mfoot">
                    <Check checked={r.on} onChange={(v) => up(r.key, { on: v })}>Ask for it</Check>
                    {r.on && <Check checked={r.required} onChange={(v) => up(r.key, { required: v })}>Required</Check>}
                    {r.many && count > 1 && <button className="bld-x" type="button" onClick={() => removeSlot(r.key)}>Remove slot</button>}
                    {lastOfField && count < (r.max ?? 1) && <button className="btn sm ghost" type="button" onClick={() => addSlot(r.field!)}><I n="plus" />Another {KIND_NOUN[r.kind].toLowerCase()}</button>}
                  </div>
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
    ? src.a.texts.map((t) => ({ id: `${t.node}|${t.input}`, label: `${t.title} · ${human(t.input)}`, tag: t.polarity === "negative" ? "Negative" : t.polarity === "positive" ? "Positive" : null, value: t.value }))
    : src.a.prompt ? [{ id: src.a.prompt.field, label: human(src.a.prompt.field), tag: null, value: "" }] : [];
  const choose = (id: string) => setP((x) => {
    const o = options.find((v) => v.id === id);
    return { ...x, pick: id, def: o && (!x.def || options.some((v) => v.value === x.def)) ? o.value : x.def };
  });
  return (
    <Sec n={2} title="Prompt" desc="The text box people type into. It opens with the whole prompt, so anyone can change any word of it. Nothing is added out of sight.">
      {!options.length ? (
        <p className="bld-none">{src.kind === "local" ? "No text box in this workflow takes a prompt." : "This model has no prompt field."}</p>
      ) : (
        <div className="bld-card">
          {src.kind === "local" && !p.pick && !src.a.prompt && src.a.texts.filter((t) => t.polarity !== "negative").length > 1 && (
            <p className="bld-note"><I n="info" />More than one text box could be the prompt, so none is picked. Pick the one people write in.</p>
          )}
          <div className="ofield">
            <label htmlFor="bp-pick">Prompt goes into</label>
            <select id="bp-pick" className="select" style={{ width: "100%" }} value={p.pick} onChange={(e) => choose(e.target.value)}>
              <option value="">No prompt box</option>
              {options.map((o) => <option key={o.id} value={o.id}>{o.label}{o.tag ? ` (${o.tag.toLowerCase()})` : ""}</option>)}
            </select>
          </div>
          {p.pick && (
            <>
              <div className="bld-2">
                <div className="ofield"><label htmlFor="bp-label">Label</label><input id="bp-label" className="input" value={p.label} maxLength={40} onChange={set("label")} /></div>
                <div className="ofield"><label htmlFor="bp-hint">Placeholder</label><input id="bp-hint" className="input" value={p.hint} maxLength={160} onChange={set("hint")} /></div>
              </div>
              <div className="ofield">
                <label htmlFor="bp-def">Opens with</label>
                <textarea id="bp-def" className="textarea" rows={Math.min(10, Math.max(3, Math.ceil(p.def.length / 60)))} value={p.def} maxLength={4000} onChange={set("def")} placeholder="The prompt the template starts with" />
              </div>
              <Check checked={p.required} onChange={(v) => setP((x) => ({ ...x, required: v }))}>People must write something</Check>
            </>
          )}
        </div>
      )}
    </Sec>
  );
}

/** Local: which node's image or video a run keeps, and whether people pick the output size or the workflow sets it. */
function OutputSection({ a, o, setO, mode, setMode }: { a: WorkflowAnalysis; o: OutputState; setO: (f: (o: OutputState) => OutputState) => void; mode: Mode; setMode: (m: Mode) => void }) {
  const node = a.sizes.find((s) => s.node === o.size);
  const steps = a.canvas.steps[mode] ?? [];
  const keep = (p: Partial<NonNullable<OutputState["keep"]>>) => setO((x) => ({ ...x, keep: { ...x.keep, ...p } }));
  const pickResult = (id: string) => {
    setO((x) => ({ ...x, result: id }));
    const r = a.results.find((x) => x.node === id);
    if (r) setMode(r.kind === "video" ? "motion" : "edit");
  };
  return (
    <Sec n={3} title="Output" desc="What a run keeps, and its size. The workflow does the work; the template only writes what you set here.">
      <div className="bld-card">
        {!a.results.length ? (
          <p className="bld-note warn"><I n="alert" />No node saves an image or a video. Add a Save Image or Save Video node in ComfyUI and load the workflow again.</p>
        ) : (
          <div className="ofield">
            <label htmlFor="bo-result">Result comes from</label>
            {a.results.length > 1 ? (
              <select id="bo-result" className="select" style={{ width: "100%" }} value={o.result} onChange={(e) => pickResult(e.target.value)}>
                {!o.result && <option value="">Pick a node</option>}
                {a.results.map((r) => <option key={r.node} value={r.node}>{r.title} · {r.kind} · #{r.node}</option>)}
              </select>
            ) : <p className="bld-val-line mono" id="bo-result">{a.results[0].title} · {a.results[0].kind} · #{a.results[0].node}</p>}
            {a.results.length > 1 && <p className="help">The other output nodes still run as the workflow has them; their files aren't kept.</p>}
          </div>
        )}
        <div className="ofield">
          <label>Output size</label>
          <div className="seg" role="group" aria-label="Output size">
            <button type="button" aria-pressed={!o.size} onClick={() => setO((x) => ({ ...x, size: "" }))}>Set by the workflow</button>
            <button type="button" aria-pressed={!!o.size} disabled={!a.sizes.length} onClick={() => setO((x) => ({ ...x, size: x.size || a.size?.node || a.sizes[0]?.node || "" }))}>People pick it</button>
          </div>
          <p className="help">
            {!a.sizes.length ? "No node here takes a width and a height, so the workflow sets the size."
              : o.size ? "People pick a shape and a size in Create; the template writes width and height on this node and nothing else."
              : "The result comes out the size the workflow makes it. With photo or video inputs, that usually follows them."}
          </p>
        </div>
        {o.size && (
          <>
            <div className="ofield">
              <label htmlFor="bo-node">Width and height go to</label>
              <select id="bo-node" className="select" style={{ width: "100%" }} value={o.size} onChange={(e) => setO((x) => ({ ...x, size: e.target.value }))}>
                {a.sizes.map((s) => <option key={s.node} value={s.node}>{s.title} · {s.width}×{s.height} · #{s.node}</option>)}
              </select>
            </div>
            <div className="bld-2">
              <div className="ofield">
                <label htmlFor="bo-aspect">Opens at shape</label>
                <select id="bo-aspect" className="select" style={{ width: "100%" }} value={o.keep?.aspect ?? ""} onChange={(e) => keep({ aspect: e.target.value || undefined })}>
                  <option value="">Nearest to {node ? `${node.width}×${node.height}` : "the workflow's"}</option>
                  {a.canvas.aspects.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
              <div className="ofield">
                <label htmlFor="bo-step">Opens at size</label>
                <select id="bo-step" className="select" style={{ width: "100%" }} value={o.keep?.default && steps.includes(o.keep.default) ? o.keep.default : ""} onChange={(e) => keep({ default: e.target.value || undefined })}>
                  <option value="">Nearest to {node ? `${(node.width * node.height / 1e6).toFixed(1)} MP` : "the workflow's"}</option>
                  {steps.map((x) => <option key={x} value={x}>{x}</option>)}
                </select>
              </div>
            </div>
          </>
        )}
      </div>
    </Sec>
  );
}

/** An optional lowest–highest pair; both empty means no limit. */
function Range({ label, unit, value, max, onChange }: { label: string; unit: string; value: [number, number] | null; max: number; onChange: (v: [number, number] | null) => void }) {
  const [lo, setLo] = useState(value ? String(value[0]) : "");
  const [hi, setHi] = useState(value ? String(value[1]) : "");
  const commit = (a: string, b: string) => {
    setLo(a);
    setHi(b);
    onChange(a === "" && b === "" ? null : [parseFloat(a || b), parseFloat(b || a)]);
  };
  return (
    <div className="bld-range">
      <span>{label}</span>
      <input className="input sm mono" type="number" min={0} max={max} step="any" placeholder="any" aria-label={`Lowest ${label.toLowerCase()}`} value={lo} onChange={(e) => commit(e.target.value, hi)} />
      <span aria-hidden>to</span>
      <input className="input sm mono" type="number" min={0} max={max} step="any" placeholder="any" aria-label={`Highest ${label.toLowerCase()}`} value={hi} onChange={(e) => commit(lo, e.target.value)} />
      <span className="hint">{unit}</span>
    </div>
  );
}

function ControlsSection({ n, src, rows, setRows }: { n: number; src: Source; rows: ParamRow[]; setRows: (f: (r: ParamRow[]) => ParamRow[]) => void }) {
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const up = (id: string, p: Partial<ParamRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const changed = (r: ParamRow) => JSON.stringify(r.value) !== JSON.stringify(r.orig);
  const shown = rows.filter((r) => (all ? (!q || `${r.group} ${r.name} ${r.label}`.toLowerCase().includes(q.toLowerCase())) : r.on || r.suggested || changed(r)));
  const groups = shown.reduce<Record<string, ParamRow[]>>((g, r) => ((g[r.group] ??= []).push(r), g), {});
  const on = rows.filter((r) => r.on).length;
  return (
    <Sec n={n} title="Controls" desc={src.kind === "local" ? "Settings people can change. The rest run with the value in the workflow; change one here to fix it without showing it." : "Request fields people can change. Hidden ones use the value you set, or the model's default."}
      aside={<span className="hint">{on} shown</span>}>
      {!rows.length ? <p className="bld-none">Nothing else to set.</p> : (
        <div className="bld-card bld-ctrls">
          {all && <div className="bc-search"><I n="search" /><input className="input" placeholder={`Search ${rows.length} settings`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search settings" /></div>}
          {Object.entries(groups).map(([g, rs]) => (
            <div key={g} className="bld-group">
              <div className="bld-gh mono">{g}</div>
              {rs.map((r) => (
                <div key={r.id} className={cx("bld-prow", r.on && "on")}>
                  <Check checked={r.on} onChange={(v) => up(r.id, { on: v })} label={`Show ${r.name}`} />
                  <div className="bld-pname">
                    {r.on ? <input className="input sm" aria-label={`Label for ${r.name}`} value={r.label} maxLength={40} onChange={(e) => up(r.id, { label: e.target.value })} />
                      : <span>{human(r.name)}{changed(r) && <em> · fixed</em>}</span>}
                    {r.help && <small title={r.help}>{r.help}</small>}
                  </div>
                  <ValueEdit r={r} onChange={(v) => up(r.id, { value: v })} />
                  {changed(r) && <button className="icon-btn sm" type="button" aria-label="Back to the workflow's value" title="Back to the workflow's value" onClick={() => up(r.id, { value: r.orig })}><I n="undo" /></button>}
                </div>
              ))}
            </div>
          ))}
          <button type="button" className="bld-fold" aria-expanded={all} onClick={() => { setAll(!all); setQ(""); }}><I n={all ? "down" : "right"} />{all ? "Show only the usual ones" : `Show all ${rows.length} settings`}</button>
        </div>
      )}
    </Sec>
  );
}

function ValueEdit({ r, onChange }: { r: ParamRow; onChange: (v: unknown) => void }) {
  if (r.type === "seed") {
    return <span className="bld-val mono">{r.on ? "Random each run" : String(r.value ?? "model default")}</span>;
  }
  if (r.type === "bool") {
    return <button type="button" role="switch" className="switch" aria-checked={!!r.value} aria-label={r.name} onClick={() => onChange(!r.value)} />;
  }
  if (r.type === "select") {
    return (
      <select className="select bld-val" aria-label={r.name} value={r.value == null ? "" : String(r.value)}
        onChange={(e) => { const o = r.options?.find((x) => String(x) === e.target.value); onChange(o ?? e.target.value); }}>
        {r.value == null && <option value="">Model default</option>}
        {r.options?.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
      </select>
    );
  }
  if (r.type === "int" || r.type === "number") {
    return (
      <input className="input sm bld-val mono" type="number" aria-label={r.name} value={r.value == null ? "" : String(r.value)}
        min={r.min ?? undefined} max={r.max ?? undefined} step={r.step ?? (r.type === "int" ? 1 : "any")} placeholder="default"
        onChange={(e) => onChange(e.target.value === "" ? null : r.type === "int" ? parseInt(e.target.value, 10) : parseFloat(e.target.value))} />
    );
  }
  return <input className="input sm bld-val" aria-label={r.name} value={r.value == null ? "" : String(r.value)} onChange={(e) => onChange(e.target.value)} />;
}

function DetailsSection({ n, d, setD, invalid }: { n: number; d: Details; setD: (f: (d: Details) => Details) => void; invalid: boolean }) {
  const set = (k: "label" | "blurb" | "tags") => (e: { target: { value: string } }) => setD((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Sec n={n} title="Details" desc="How it shows up on Explore.">
      <div className="bld-card">
        <div className="bld-2">
          <div className="ofield">
            <label htmlFor="bd-label">Name</label>
            <input id="bd-label" className="input" value={d.label} maxLength={80} onChange={set("label")} aria-invalid={invalid || undefined} style={invalid ? { borderColor: "var(--rose)" } : undefined} />
          </div>
          <div className="ofield">
            <label>Shows under</label>
            <div className="seg" role="group" aria-label="Mode">
              <button type="button" aria-pressed={d.mode === "edit"} onClick={() => setD((x) => ({ ...x, mode: "edit" }))}><I n="image" />Image</button>
              <button type="button" aria-pressed={d.mode === "motion"} onClick={() => setD((x) => ({ ...x, mode: "motion" }))}><I n="film" />Video</button>
            </div>
          </div>
        </div>
        <div className="ofield"><label htmlFor="bd-blurb">What it does</label><textarea id="bd-blurb" className="textarea" rows={2} value={d.blurb} maxLength={400} onChange={set("blurb")} placeholder="One or two sentences: what goes in, what comes out." /></div>
        <div className="ofield"><label htmlFor="bd-tags">Tags</label><input id="bd-tags" className="input" value={d.tags} onChange={set("tags")} placeholder="portrait, relight" /><p className="help">Comma separated. Tags two templates share become filters on Explore.</p></div>
      </div>
    </Sec>
  );
}

/** A media input's sample: click to pick a file, or drop one on it. */
function SampleThumb({ r, busy, onFile }: { r: MediaRow; busy: boolean; onFile: (f: File) => void }) {
  const toast = useApp((s) => s.toast);
  const fits = (f: File) => (r.kind === "audio" ? f.type.startsWith("audio/") : r.kind === "video" ? isVideo(f) : isImage(f));
  const drop = useFileDrop((files) => onFile(files[0]), {
    accept: fits, disabled: busy,
    onReject: (files) => toast({ text: `${files[0].name} isn't ${r.kind === "image" ? "an image" : `a ${r.kind === "video" ? "video" : "sound"}`}.`, tone: "warn" }),
  });
  return (
    <label className={cx("bld-thumb", drop.over && "drop")} title={r.sample ? "Replace the sample: click or drop a file" : "Add a sample people start from: click or drop a file"} {...drop.props}>
      {busy ? <span><Spinner size={14} /></span> : r.sample ? <img src={r.sample.poster ?? r.sample.url} alt="" /> : <span><I n={KIND_ICON[r.kind]} /></span>}
      <span className="bld-thumb-cap">{drop.over ? "Drop" : r.sample ? "Sample" : "+ Sample"}</span>
      <input type="file" hidden accept={r.kind === "video" ? "video/*" : r.kind === "image" ? "image/*" : "audio/*"} disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </label>
  );
}

// ---- preview -------------------------------------------------------------------

function Preview({ details, media, prompt, params, kind, sized }: { details: Details; media: MediaRow[]; prompt: PromptState; params: ParamRow[]; kind: "local" | "cloud"; sized: string | null }) {
  const on = media.filter((m) => m.on);
  const ctrls = params.filter((r) => r.on);
  return (
    <div className="bld-preview" aria-label="Preview">
      <div className="eyebrow">How it looks in Create</div>
      <div className="bp-card">
        <div className="bp-cover">
          <span className="bp-nocover"><I n="image" /><small>Your first published result</small></span>
          <span className="pill bp-kind"><i className={cx("dot", kind === "cloud" && "violet")} />{kind === "local" ? "Local" : "Cloud"}</span>
        </div>
        <div className="bp-body">
          <b className="bp-title">{details.label || "Untitled template"}</b>
          {details.blurb && <p className="bp-blurb">{details.blurb}</p>}
          {on.length > 0 && (
            <div className="bp-slots">
              {on.map((m) => (
                <div key={m.key} className="bp-slot">
                  {m.sample ? <img src={m.sample.poster ?? m.sample.url} alt="" /> : <span><I n={KIND_ICON[m.kind]} /></span>}
                  <small>{m.label || KIND_NOUN[m.kind]}{!m.required && " · optional"}</small>
                </div>
              ))}
            </div>
          )}
          {prompt.pick && (
            <div className="bp-prompt">
              <small>{prompt.label || "Prompt"}</small>
              <p className={prompt.def ? undefined : "ph"}>{prompt.def || prompt.hint || "Describe what you want"}</p>
            </div>
          )}
          {sized && <div className="bp-ctrls"><div><span>Output size</span><span className="mono">{sized}</span></div></div>}
          {ctrls.length > 0 && (
            <div className="bp-ctrls">
              {ctrls.map((r) => <div key={r.id}><span>{r.label || human(r.name)}</span><span className="mono">{r.type === "seed" ? "random" : r.type === "bool" ? (r.value ? "on" : "off") : String(r.value ?? "default")}</span></div>)}
            </div>
          )}
          <div className="bp-run">Run</div>
        </div>
      </div>
    </div>
  );
}

function Check({ checked, onChange, children, label }: { checked: boolean; onChange: (v: boolean) => void; children?: ReactNode; label?: string }) {
  return (
    <label className="bld-check-l">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="bld-box" aria-hidden><I n="check" /></span>
      {children && <span>{children}</span>}
    </label>
  );
}
