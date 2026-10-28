// The builder's state: input, prompt, setting and result rows, read from a workflow analysis or a preset.
import type { Asset, BuildParamType, BuildPreset, MediaKind, Mode, RouterAdapter, WorkflowAnalysis } from "../../lib/api";

export interface MediaRow {
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

export interface ParamRow {
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
  unit?: string;
  help?: string | null;
  suggested: boolean;
  node?: string;
  input?: string;
  key?: string; // the template's name for it, when opened from a template
}

export interface PromptState {
  pick: string; // "node|input" for workflows, "prompt" for Router models, "" for none
  label: string;
  hint: string;
  def: string;
  required: boolean;
}

export interface Details { label: string; blurb: string; mode: Mode }

/** Local: the node a run's result comes from, and where a declared output size goes ("" when the workflow sizes itself). */
export interface OutputState { result: string; size: string; keep?: { label?: string; aspect?: string; default?: string } }

export type Source =
  | { kind: "local"; a: WorkflowAnalysis }
  | { kind: "cloud"; a: RouterAdapter };

export const human = (s: string) => {
  const t = s.split(".").pop()!.replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};

const cap = (t: string) => t.trim().charAt(0).toUpperCase() + t.trim().slice(1);

export const KIND_NOUN: Record<MediaKind, string> = { image: "Image", video: "Video", audio: "Audio" };

export const KIND_ICON: Record<MediaKind, "image" | "film" | "sound"> = { image: "image", video: "film", audio: "sound" };

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

export function fromWorkflow(a: WorkflowAnalysis): { media: MediaRow[]; prompt: PromptState; params: ParamRow[]; details: Details; output: OutputState } {
  const labels = mediaLabels(a.media);
  const media: MediaRow[] = a.media.map((m, i) => ({
    key: `${m.node}|${m.input}`, on: m.suggested, kind: m.kind, label: labels[i], hint: "", required: true, sample: m.sample,
    where: m.found === "setting" ? `${m.title} · ${m.input} · #${m.node}` : `${m.title} · #${m.node}`, node: m.node, input: m.input,
    found: m.found, value: m.value,
  }));
  const pick = a.prompt ? `${a.prompt.node}|${a.prompt.input}` : "";
  const text = a.texts.find((t) => `${t.node}|${t.input}` === pick);
  const prompt: PromptState = { pick, label: "Prompt", hint: "Describe what you want", def: text?.value ?? "", required: true };
  // Every widget value could be a setting people change on Create. All start off: the workflow runs as saved
  // until the author turns one on (the likely ones are listed first).
  const params: ParamRow[] = a.params.map((p) => ({
    id: `${p.node}|${p.input}`, on: false, label: human(p.input), type: p.type, value: p.value, orig: p.value,
    group: `${p.title} · #${p.node}`, name: p.input, min: p.min, max: p.max, step: p.step, options: p.options, help: p.help,
    suggested: p.suggested, node: p.node, input: p.input,
  }));
  const details: Details = { label: fileTitle(a.source), blurb: "", mode: a.mode };
  // Made from words alone with one place to set width and height: people pick the output's shape and size.
  const output: OutputState = { result: a.outputs[0] ?? "", size: a.size?.node ?? "" };
  return a.preset ? withPreset(a.preset, { media, prompt, params, details, output }) : { media, prompt, params, details, output };
}

/** Opened from a template: start from what it asks for, with its names, hints and defaults. */
function withPreset(p: BuildPreset, init: { media: MediaRow[]; prompt: PromptState; params: ParamRow[]; details: Details; output: OutputState }) {
  const at = (x: { node: string; input: string }) => `${x.node}|${x.input}`;
  const pm = new Map(p.media.map((m) => [at(m), m]));
  const pp = new Map(p.params.map((x) => [at(x), x]));
  // The template's inputs first, in its order (the order Create shows and a save keeps), then the workflow's other loaders.
  const rank = (r: MediaRow) => { const i = p.media.findIndex((m) => at(m) === r.key); return i < 0 ? p.media.length : i; };
  return {
    media: [...init.media].sort((a, b) => rank(a) - rank(b)).map((r) => {
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
      // The template's own control: its type, options and unit (Duration 3/5/8 s, not a bare number box).
      const own = x ? Object.fromEntries((["type", "options", "unit", "min", "max", "step"] as const).filter((k) => x[k] !== undefined).map((k) => [k, x[k]])) : {};
      return x ? { ...r, ...own, on: true, label: x.label, key: x.key, value: x.default ?? r.value, help: x.help ?? r.help } : { ...r, on: false };
    }),
    details: { label: p.label, blurb: p.blurb, mode: p.mode },
  };
}
