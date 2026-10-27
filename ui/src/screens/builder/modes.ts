// Router models: their input sets as modes, and which mode a set of filled inputs runs.
import type { RouterAdapter } from "../../lib/api";
import type { Details, MediaRow, OutputState, ParamRow, PromptState } from "./model";

/** A way a Router model runs, and the adapter inputs it shows. */
type RouterMode = { id: string; label: string; inputs: number[] };

const SET_LABEL: Record<string, string> = { frames: "Image to video", references: "From references", edit: "Video edit", extend: "Extend a video", style: "Style reference" };

/** The modes a Router model has, read off its adapter: its `models` routes, else its input sets. One mode or none: no picker. */
export function routerModes(a: RouterAdapter): RouterMode[] {
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
export const modeOf = (modes: RouterMode[], rows: MediaRow[]) => {
  const on = [...new Set(rows.filter((r) => r.on).map((r) => r.slot!))].sort((x, y) => x - y).join();
  return modes.find((m) => m.inputs.join() === on);
};

/** Show only the inputs a mode takes. Files in inputs it doesn't take are dropped: they'd be sent otherwise. */
export const toMode = (m: RouterMode, rows: MediaRow[]): MediaRow[] =>
  rows.map((r) => (m.inputs.includes(r.slot!) ? { ...r, on: true } : { ...r, on: false, sample: null, own: false }));

/** A Router model: one row per input its adapter takes, all empty. The ones you fill are the template's inputs.
 *  A model with modes starts on its first: only that mode's inputs show. */
export function fromAdapter(a: RouterAdapter) {
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
export function adapterProblems(a: RouterAdapter, rows: MediaRow[]): string[] {
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
export function runMode(a: RouterAdapter, rows: Filled[]): string {
  const has = (role: string) => filledInputs(a, rows).some((r) => r.role === role);
  const any = rows.some((r) => r.sample);
  if (a.mode === "edit") return any ? "Photo edit" : "Text to image";
  if (has("Video to edit")) return "Video edit";
  if (has("Video to extend")) return "Extend a video";
  if (has("First frame")) return has("Last frame") ? "First and last frame" : "Image to video";
  return any ? "From references" : "Text to video";
}
