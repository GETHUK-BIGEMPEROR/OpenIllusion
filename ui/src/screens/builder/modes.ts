// Router models: the jobs each one does, the inputs each job takes, and what a set of filled inputs makes.
import type { AdapterSetting, Asset, Fit, Range, RouterAdapter } from "../../lib/api";
import type { Details, MediaRow, OutputState, ParamRow, PromptState } from "./model";

/** What a job asks of an input: always, only if you want it, or at least one of the "any" ones. */
export type Need = "yes" | "no" | "any";

export type JobKind = "text" | "photos" | "frames" | "refs" | "vedit" | "extend" | "style";

/** One thing a Router model does, and the adapter inputs (by index) it takes. */
export type RouterJob = { id: string; kind: JobKind; label: string; desc: string; inputs: number[]; need: Record<number, Need> };

/** The same words for the same job on every model. */
const JOB: Record<JobKind, { label: string; desc: string }> = {
  text: { label: "Text to video", desc: "Only a prompt" },
  photos: { label: "Edit or combine photos", desc: "Photos and a prompt" },
  frames: { label: "Animate a photo", desc: "A start frame" },
  refs: { label: "From references", desc: "Keep characters, objects, sounds" },
  vedit: { label: "Edit a video", desc: "A clip and what to change" },
  extend: { label: "Extend a video", desc: "A clip that keeps going" },
  style: { label: "Match a style", desc: "The look of one image" },
};

/** One line under each input: what the model does with it. */
export const ROLE_HINT: Record<string, string> = {
  Photo: "Edit one photo, or combine several into one",
  "First frame": "The video starts on this image",
  "Last frame": "The video ends on this image",
  "Reference image": "A character, product or place to keep",
  "Reference video": "Motion or camera to follow",
  "Reference audio": "A voice, sound or music to use",
  "Video to edit": "The clip that gets changed",
  "Video to extend": "The clip that gets carried on",
  "Style image": "Its look is copied, not what's in it",
};

const SET_KIND: Record<string, JobKind> = { frames: "frames", references: "refs", edit: "vedit", extend: "extend", style: "style" };

/** A job named by what its inputs are, for adapters that split modes over model ids. */
function kindOf(roles: string[]): JobKind {
  if (!roles.length) return "text";
  if (roles.includes("Video to edit")) return "vedit";
  if (roles.includes("Video to extend")) return "extend";
  if (roles.includes("First frame")) return "frames";
  if (roles.includes("Style image")) return "style";
  return "refs";
}

function job(a: RouterAdapter, id: string, kind: JobKind, inputs: number[]): RouterJob {
  const roles = inputs.map((i) => a.inputs[i]);
  // The clip a job works on and a first frame are always asked for; a job's only input is too. With none of those, one of them will do.
  const must = (r: (typeof roles)[number]) => r.role.startsWith("Video to") || r.role === "First frame" || roles.length === 1;
  const anyMust = roles.some(must);
  const need = Object.fromEntries(inputs.map((i) => [i, must(a.inputs[i]) ? "yes" : anyMust ? "no" : "any"])) as Record<number, Need>;
  const base = JOB[kind];
  const photo = a.mode === "edit";
  const label = kind === "text" ? (photo ? "Text to image" : "Text to video") : base.label;
  let desc = base.desc;
  if (kind === "frames" && roles.some((r) => r.role === "Last frame")) desc = "A start frame, and an end frame if you like";
  if (kind === "refs" && roles.every((r) => r.type === "image")) desc = "Keep characters, objects, places";
  return { id, kind, label, desc, inputs, need };
}

/** The jobs a Router model does, read off its adapter: its `models` routes, else its input sets, else text and photos. */
export function routerJobs(a: RouterAdapter): RouterJob[] {
  const text = job(a, "text", "text", []);
  if (a.models?.length) {
    return a.models.map((m) => {
      const inputs = a.inputs.flatMap((x, i) => (m.takes.includes(x.role) ? [i] : []));
      return job(a, m.model, kindOf(inputs.map((i) => a.inputs[i].role)), inputs);
    });
  }
  const sets = [...new Set(a.inputs.flatMap((x) => x.set ?? []))];
  const all = a.inputs.map((_, i) => i);
  if (!sets.length) return all.length ? [text, job(a, "inputs", a.mode === "edit" ? "photos" : kindOf(a.inputs.map((x) => x.role)), all)] : [text];
  const loose = a.inputs.flatMap((x, i) => (x.set?.length ? [] : [i]));
  return [text, ...sets.map((s) => {
    const inputs = a.inputs.flatMap((x, i) => (x.set?.includes(s) ? [i] : [])).concat(loose).sort((x, y) => x - y);
    return job(a, s, SET_KIND[s] ?? kindOf(inputs.map((i) => a.inputs[i].role)), inputs);
  })];
}

/** The job the shown rows are in. */
export const jobOf = (jobs: RouterJob[], rows: MediaRow[]) => {
  const on = [...new Set(rows.filter((r) => r.on).map((r) => r.slot!))].sort((x, y) => x - y).join();
  return jobs.find((j) => j.inputs.join() === on);
};

let made = 0;

/**
 * Files into the inputs that are on: ``at`` (the input they were dropped on) takes the first, then each
 * goes to the first empty input of its kind, ``at``'s own role first. A Router role with room left (``a``)
 * takes another file. What fits nowhere comes back in ``left``.
 */
export function placeFiles(rows: MediaRow[], files: Asset[], a?: RouterAdapter, at?: { key: string; add?: boolean }): { rows: MediaRow[]; left: Asset[] } {
  let rs = rows;
  const left: Asset[] = [];
  const put = (key: string, x: Asset) => { rs = rs.map((y) => (y.key === key ? { ...y, sample: x, own: true } : y)); };
  const add = (slot: number, x: Asset) => {
    const i = rs.map((y) => y.slot).lastIndexOf(slot);
    rs = [...rs.slice(0, i + 1), { ...rs[i], key: `${slot}:${Date.now()}:${made++}`, sample: x, own: true }, ...rs.slice(i + 1)];
  };
  const home = at ? rows.find((r) => r.key === at.key) : undefined;
  const queue = [...files];
  if (home && queue[0]?.kind === home.kind) {
    const x = queue.shift()!;
    if (at!.add && a) add(home.slot!, x);
    else put(home.key, x);
  }
  // Display order: the role dropped on, then what the job must have, then the rest.
  const j = a ? jobOf(routerJobs(a), rows) : undefined;
  const roles = j ? [...j.inputs].sort((x, y) => +(y === home?.slot) - +(x === home?.slot) || +(j.need[y] === "yes") - +(j.need[x] === "yes")) : [];
  const rank = (r: MediaRow) => (a ? roles.indexOf(r.slot!) : 0);
  for (const x of queue) {
    const empty = rs.filter((r) => r.on && r.kind === x.kind && !r.sample).sort((p, q) => rank(p) - rank(q))[0];
    if (empty) { put(empty.key, x); continue; }
    const room = a ? roles.find((i) => a.inputs[i].type === x.kind && rs.some((r) => r.on && r.slot === i)
      && rs.filter((r) => r.on && r.slot === i && r.sample).length < maxOf(a, i, rs)) : undefined;
    if (room != null) add(room, x);
    else left.push(x);
  }
  return { rows: rs, left };
}

/** Why ``left`` found no input: "Every photo input is full" or "Nothing here takes a sound". */
export function placeMiss(rows: MediaRow[], left: Asset[]): string | null {
  const x = left[0];
  if (!x) return null;
  const noun = x.kind === "video" ? "clip" : x.kind === "audio" ? "sound" : "photo";
  const more = left.length > 1 ? ` ${left.length} files weren't used.` : "";
  return rows.some((r) => r.on && r.kind === x.kind)
    ? `Every ${noun} input is full. Drop on one to replace its sample.${more}`
    : `Nothing here takes a ${noun}.${more}`;
}

/** Show only the inputs a job takes. Files in inputs it doesn't take are dropped: they'd be sent otherwise. */
export const toJob = (j: RouterJob, rows: MediaRow[]): MediaRow[] => {
  const seen = new Set<number>();
  // An input it doesn't take goes back to one empty row, so coming back to the job starts clean.
  return rows.flatMap((r): MediaRow[] => {
    if (j.inputs.includes(r.slot!)) return [{ ...r, on: true }];
    if (seen.has(r.slot!)) return [];
    seen.add(r.slot!);
    return [{ ...r, key: `${r.slot}:0`, on: false, sample: null, own: false }];
  });
};

/** A Router model: one row per input its adapter takes, all empty. The ones you fill are the template's inputs.
 *  It starts on its first job: only that job's inputs show. */
export function fromAdapter(a: RouterAdapter) {
  const rows: MediaRow[] = a.inputs.map((x, i) => ({
    key: `${i}:0`, on: true, kind: x.type, label: x.role, hint: "", required: false, sample: null, where: x.role, slot: i, max: x.max,
  }));
  const media = toJob(routerJobs(a)[0], rows);
  const prompt: PromptState = { pick: "prompt", label: "Prompt", hint: "", def: "", required: true };
  // Labels read "Name · Model": the model half is set, the name is yours to write.
  const details: Details = { label: ` · ${a.name}`, blurb: "", mode: a.mode, tags: "" };
  return { media, prompt, params: [] as ParamRow[], details, output: { result: "", size: "" } as OutputState };
}

/** The model's settings a job with these rows filled asks for: none an input decides (off_with), none missing a role they need
 *  (only_with). A keep_sound option ("Keep the clip's") is offered only with its clip, as the server does. */
export function settingsFor(a: RouterAdapter, rows: Filled[]): AdapterSetting[] {
  const roles = new Set(filledSlots(rows).map((i) => a.inputs[i].role));
  return (a.settings ?? [])
    .filter((s) => !s.off_with.some((r) => roles.has(r)) && (!s.only_with.length || s.only_with.some((r) => roles.has(r))))
    .map((s) => {
      const ks = s.keep_sound;
      if (!ks || roles.has(ks.role)) return s;
      const { keep_sound: _, ...rest } = s;
      return { ...rest, options: s.options?.filter((o) => o !== ks.option) };
    });
}

/** A setting's starting value: a size is its shape and step. */
export const settingDefault = (s: AdapterSetting): unknown => s.type === "size" ? { aspect: s.aspect, size: s.default } : s.default;

/** The value picked for `s`, or its default once the pick isn't offered any more (its clip was taken out). */
export const settingValue = (s: AdapterSetting, picked: unknown): unknown =>
  picked === undefined || (s.options && !s.options.some((o) => String(o) === String(picked))) ? settingDefault(s) : picked;

type Filled = { sample: unknown; slot?: number };

/** The adapter inputs that have a file, by index, in the adapter's order. */
const filledSlots = (rows: Filled[]) => [...new Set(rows.filter((r) => r.sample).map((r) => r.slot!))].sort((x, y) => x - y);

/** How many files input `i` takes as things stand: its max_with limit while one of those roles is filled, or the job requires one. */
export function maxOf(a: RouterAdapter, i: number, rows: Filled[]): number {
  const { max, max_with: mw } = a.inputs[i];
  if (!mw) return max;
  const j = jobOf(routerJobs(a), rows as MediaRow[]);
  const on = [...filledSlots(rows), ...(j ? j.inputs.filter((k) => j.need[k] === "yes") : [])].map((k) => a.inputs[k].role);
  return mw.roles.some((r) => on.includes(r)) ? mw.max : max;
}

/** 2.5 → "5:2". */
const ratio = (r: number) => {
  for (let d = 1; d <= 16; d++) if (Math.abs(r * d - Math.round(r * d)) < 1e-3) return `${Math.round(r * d)}:${d}`;
  return `${r.toFixed(2)}:1`;
};
const span = ([lo, hi]: Range, unit: string) => (lo && hi ? (lo === hi ? `${lo}${unit}` : `${lo}–${hi}${unit}`) : lo ? `≥ ${lo}${unit}` : `≤ ${hi}${unit}`);

/** A model's limits on one input, short: "3–10 s · 24–60 fps · ≥ 720 px · ≤ 200 MB". Runs crop, scale and cut files to them. */
export function fitText(f?: Fit): string {
  if (!f) return "";
  const px = f.short?.[0] && !f.short[1] ? `≥ ${f.short[0]} px` : f.long?.[1] && !f.long[0] ? `≤ ${f.long[1]} px` : "";
  return [
    f.seconds && span(f.seconds, " s") + (f.total ? ` (${f.total} s in all)` : ""),
    !f.seconds && f.total && `${f.total} s in all`,
    f.fps && span(f.fps, " fps"),
    f.short?.[0] && f.long?.[1] ? `${f.short[0]}–${f.long[1]} px` : px,
    f.aspect && `${ratio(f.aspect[0] ?? 0.0001)} to ${ratio(f.aspect[1] ?? 10000)}`,
    f.mb && `≤ ${f.mb} MB`,
  ].filter(Boolean).join(" · ");
}

const lower = (role: string) => role.charAt(0).toLowerCase() + role.slice(1);
const orList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`);
const andList = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What a Router model can't run from the inputs you filled: the same rules the server checks, plus what the job asks for. */
export function adapterProblems(a: RouterAdapter, rows: MediaRow[]): string[] {
  const slots = filledSlots(rows);
  const roles = slots.map((i) => a.inputs[i]);
  const p: string[] = [];
  const clash = roles.flatMap((x, i) => roles.slice(i + 1).map((y) => [x, y] as const))
    .find(([x, y]) => x.set?.length && y.set?.length && !x.set.some((s) => y.set!.includes(s)));
  if (clash) p.push(`${a.name} takes ${lower(clash[0].role)} or ${lower(clash[1].role)}, not both`);
  for (const r of roles) if (r.needs && !roles.some((x) => x.role === r.needs)) p.push(`The ${lower(r.role)} needs a ${lower(r.needs)} as well`);
  for (const i of slots) {
    const n = rows.filter((r) => r.slot === i && r.sample).length;
    const cap = maxOf(a, i, rows);
    if (n > cap) p.push(`${a.name} takes up to ${cap} ${lower(a.inputs[i].role)}s${cap < a.inputs[i].max ? ` with a ${orList(a.inputs[i].max_with!.roles.map(lower))}` : ""}. Remove ${n - cap}`);
  }
  const names = roles.map((r) => r.role);
  if (!clash && a.models?.length && !a.models.some((m) => names.every((n) => m.takes.includes(n))))
    p.push(`${a.name} can't take ${andList(names.map(lower))} together`);
  const j = jobOf(routerJobs(a), rows);
  if (j) {
    const miss = j.inputs.find((i) => j.need[i] === "yes" && !slots.includes(i));
    const anys = j.inputs.filter((i) => j.need[i] === "any");
    if (miss !== undefined) p.push(`${j.label} needs a ${lower(a.inputs[miss].role)}`);
    else if (anys.length && !anys.some((i) => slots.includes(i))) p.push(`${j.label} needs a ${orList(anys.map((i) => lower(a.inputs[i].role)))}`);
  }
  return [...new Set(p)];
}

/** What a run makes, in a sentence, from the job and the files in it. Only meaningful once adapterProblems is empty. */
export function runSays(a: RouterAdapter, rows: MediaRow[]): string {
  const j = jobOf(routerJobs(a), rows);
  const slots = filledSlots(rows);
  const count = (i: number) => rows.filter((r) => r.slot === i && r.sample).length;
  const used = slots.map((i) => (count(i) > 1 ? `${count(i)} ${lower(a.inputs[i].role)}s` : `a ${lower(a.inputs[i].role)}`));
  const has = (role: string) => slots.some((i) => a.inputs[i].role === role);
  // What else rides along with the clip an edit works on.
  const extra = used.filter((_, k) => !a.inputs[slots[k]].role.startsWith("Video to"));
  const what: Record<JobKind, string> = {
    text: a.mode === "edit" ? "a photo from the prompt alone" : "a video from the prompt alone",
    photos: count(slots[0]) > 1 ? `one new photo out of ${count(slots[0])} photos` : "a new version of the photo",
    frames: has("Last frame") ? "a video that runs from the first frame to the last" : "a video that starts on the first frame",
    refs: `a video that keeps what's in ${andList(used)}`,
    vedit: `the clip, changed the way the prompt says${extra.length ? `, with ${andList(extra)}` : ""}`,
    extend: "more of the clip, carried on from where it ends",
    style: "a video in the style image's look",
  };
  return `${a.name} makes ${what[j?.kind ?? "text"]}.`;
}
