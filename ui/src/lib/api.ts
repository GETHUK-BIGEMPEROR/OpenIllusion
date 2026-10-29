// Thin client for the OpenIllusion server's /api. The API key and the proxy token
// never come back from the server; only whether they are set.

export const API = "/api";

// The key and the proxy token live in this browser's localStorage, never on the server's
// disk: each request carries them, so a restarted server has them back at the first call.
type Held = { key?: string; token?: string };
const HELD = "oi.secrets";
const held = (): Held => {
  try { return JSON.parse(localStorage.getItem(HELD) || "{}") as Held; } catch { return {}; }
};
const hold = (patch: Held) => {
  try { localStorage.setItem(HELD, JSON.stringify({ ...held(), ...patch })); } catch { /* storage blocked: the server's memory still has it */ }
};

export type Mode = "motion" | "edit";
export type Outcome = "worked" | "partly" | "didnt";
export type JobState =
  | "estimating" | "waiting" | "queued" | "running" | "rate_limited"
  | "downloading" | "done" | "failed" | "moderated" | "cancelled";

export interface ParamSpec {
  key: string;
  label: string;
  type: "int" | "segmented" | "bool" | "seed" | "string" | "select" | "number" | "text" | "aspect";
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  /** The values the model takes; "" means Auto (the model decides, nothing is sent). */
  options?: (string | number)[];
  /** What people see for a value, when it isn't the value itself ("std" → "720p"). */
  labels?: Record<string, string>;
  unit?: string;
  help?: string;
  hint?: string;
  /** Shown under Advanced rather than with the other settings. */
  advanced?: boolean;
}

export type MediaType = "image" | "video" | "audio";


/**
 * One thing a template takes, in the order the studio shows it. Photos and clips are keyed `image:N` / `video:N`,
 * the prompt `prompt`, settings by name. `bind` says where the value goes in the workflow (or cloud body).
 */
export type Field = (
  | { type: MediaType; size?: string; window?: [number, number]; fps?: [number, number]; fit?: Fit; role?: string; sample?: (Asset & { slot: string }) | null }
  | Omit<ParamSpec, "key" | "label">
  /** A declared output size: the width and height it writes come from the shape and step picked under Output. */
  | { type: "size"; aspect?: string; aspects?: string[]; default?: string; steps?: number[] }
) & { key: string; label: string; hint?: string; help?: string; required?: boolean; advanced?: boolean; bind?: unknown[][] };

export const isMedia = (f: Field): f is Field & { type: MediaType } => f.type === "image" || f.type === "video" || f.type === "audio";

export interface EngineInfo {
  id: string;
  mode: Mode;
  label: string;
  provider: string;
  blurb: string;
  max_images: number;
  min_images: number;
  needs_video: boolean;
  video_window: [number, number] | null;
  fps_window: [number, number];
  url_only: boolean;
  params: ParamSpec[];
  curated: boolean;
  /** cloud: a Comfy Router model. local: a ComfyUI workflow run through Comfy API v2. */
  kind: "cloud" | "local";
  source: string | null;
  prompt?: { label?: string; required?: boolean } | null;
  /** Prompts known to work, shown as chips. */
  /** Whether two runs with the same inputs can differ (the workflow re-rolls a seed). Variants need it. */
  varies?: boolean;
  /** The photos and clips it takes (a view of `fields`). */
  inputs?: { slot: string; label?: string; hint?: string }[];
  /** Everything it takes, in order: photos and clips, the prompt, settings. Empty for raw Router models. */
  fields?: Field[];
  /** Model files and node types a local template needs in ComfyUI. */
  requires?: { models: { name: string; folder: string; url?: string | null }[]; nodes: string[] };
  /** shipped with the app, or from the user's templates folder. */
  origin?: "shipped" | "user" | null;
  /** A shipped template the user changed; can be reset. */
  edited?: boolean;
  /** Tile poster URL: the user's pick, else the one the template ships with. */
  cover?: string | null;
  /** Optional short muted loop played over the poster. */
  cover_video?: string | null;
  /** Poster width / height, so the wall lays out before images load. */
  cover_aspect?: number | null;
  /** True when the user picked the cover, so it can be reset. */
  cover_custom?: boolean;
  /** The input the cover was made from (its lead photo or clip), shown beside it; null when unknown. */
  cover_before?: { url: string; kind: "image" | "video" } | null;
  /** Whether the result is made over the lead input (an edit, a first frame), so the two compare; false for references. */
  before?: boolean;
  /** The model, shown under the name: a Router model's own name, a workflow's as its author gave it. */
  model_name?: string;
  /** A workflow's model as its author typed it ("" when not given); null on Router templates. */
  workflow_model?: string | null;
  /** Built but not published: no cover until one of its own results becomes it. Hidden from the wall. */
  /** How the app crops and sizes images before the run (server/prep.py). */
  size?: SizeSpec | null;
  /** What the template opens with: a prompt, and a sample for each slot (assets like uploads). */
  defaults?: { prompt: string; inputs: (Asset & { slot: string })[] };
  /** Made in the template builder (can be deleted). */
  built?: boolean;
  /** Saved in the Builder and not published yet: in Create, off Explore, until a finished run of it publishes it. */
  draft?: boolean;
  /** Cloud: how the prompt names each file, by kind ("<<<image_{n}>>>"); {} when the model has no names. */
  mentions?: Record<string, string>;
  /** A shipped template taken off Explore (Settings puts it back). */
  hidden?: boolean;
  /** When a run of it last started, and how many runs (server/usage.py): kept when the runs are deleted. */
  used_at?: number | null;
  uses?: number;
  /** Cloud templates: the Router model they send to. */
  model?: string | null;
}

// ---- template builder --------------------------------------------------------

export type MediaKind = "image" | "video" | "audio";
export type BuildParamType = "int" | "number" | "bool" | "seed" | "select" | "segmented" | "string";

/** Where a local template can take a photo or clip: a loader ComfyUI marks as one, or a setting that holds a file name (off until the author turns it on). */
export interface BuildMedia {
  node: string; input: string; kind: MediaKind; title: string; class_type: string; value: string | null; slot: string; sample: Asset | null;
  found: "loader" | "setting"; suggested: boolean;
}
/** An output node that writes an image or a video: where a run's result can come from. */
export interface BuildResult { node: string; title: string; class_type: string; kind: "image" | "video" }
/** A node with a width and a height: where a declared output size can go. */
export interface BuildSize { node: string; title: string; class_type: string; width: number; height: number }
/** A multiline text box in the workflow. */
export interface BuildText { node: string; input: string; title: string; class_type: string; value: string; polarity: "positive" | "negative" | null }
/** A widget value that could become a control. */
export interface BuildParam {
  node: string; input: string; title: string; class_type: string; value: unknown; type: BuildParamType;
  min?: number | null; max?: number | null; step?: number | null; options?: (string | number)[]; help?: string | null; suggested: boolean;
}
export interface LocalCheckResult { ok: boolean; missing_nodes: { class_type: string; node_ids: string[] }[]; missing_models: { node_id: string; input: string; value: string }[]; bad_values: { node_id: string; class_type: string; input: string; value: unknown }[] }
export interface WorkflowAnalysis {
  token: string; source: string; format: "ui" | "api"; outputs: string[]; nodes: number; notes: string[];
  media: BuildMedia[]; texts: BuildText[]; prompt: { node: string; input: string } | null; params: BuildParam[];
  mode: Mode; check: LocalCheckResult;
  /** Every node a result can come from; `outputs` holds the suggested one. */
  results: BuildResult[];
  /** Every node an output size can go to; `size` holds the suggested one, if any. */
  sizes: BuildSize[]; size: { node: string } | null;
  /** The shapes and steps a declared output size can offer, by mode. */
  canvas: { aspects: string[]; steps: Record<Mode, string[]> };
  /** Opened from a template: how that template set the workflow up. */
  preset?: BuildPreset;
}
type At = { node: string; input: string };
export interface BuildPreset {
  base: string; label: string; model_name?: string; blurb: string; mode: Mode;
  media: (At & { slot: string; label?: string; hint?: string; required?: boolean; window?: [number, number]; fps?: [number, number] })[];
  prompt: (At & { label?: string; hint?: string; required?: boolean; default: string }) | null;
  params: (At & { key: string; label: string; default?: unknown; help?: string | null; type?: BuildParamType; options?: (string | number)[]; unit?: string; min?: number; max?: number; step?: number })[];
  size: { node: string; label?: string; aspect?: string; default?: string } | null;
  outputs: string[];
}
/** A Router model the builder can make a template from: its adapter's inputs, by role.
 *  `set`: inputs of different sets can't go together. `needs`: the role that has to be filled too. */
/** What a model takes in one file (server/fit.py): [least, most] ranges, null for open. Runs make files fit. */
export type Range = [number | null, number | null];
export interface Fit { short?: Range; long?: Range; pixels?: Range; aspect?: Range; seconds?: Range; fps?: Range; mb?: number; total?: number }

export interface RouterAdapter {
  model: string; name: string; mode: Mode;
  /** set: groups of inputs that go together (two filled inputs must share one). needs: another input this one needs.
   *  max_with: a lower max while any of its roles is filled. */
  inputs: { role: string; type: MediaKind; max: number; max_with?: { roles: string[]; max: number }; set?: string[]; needs?: string; fit?: Fit }[];
  /** A family on several model ids: the first whose takes covers every filled role gets the run. */
  models?: { model: string; takes: string[] }[];
  /** What people choose about the result (shape, size, resolution, length, sound). `off_with`: roles that decide it
   *  instead, so it isn't asked; `only_with`: roles it needs. */
  settings: AdapterSetting[];
  /** How the prompt names each file, by kind; {} when the model has no names for them. */
  mentions: Record<string, string>;
}

export type AdapterSetting = Omit<ParamSpec, "type"> & {
  type: "aspect" | "select" | "segmented" | "int" | "bool" | "size";
  off_with: string[]; only_with: string[];
  /** The value the request gets for each option, when it isn't the option itself. */
  send?: Record<string, unknown>;
  /** Picking `option` gives the result the own sound of the clip in `role`; offered only with that clip. */
  keep_sound?: { option: string; role: string };
  /** size: the shapes and megapixel steps, the shape it opens at, and the model's limits. */
  aspects?: string[]; aspect?: string; steps?: number[]; sides?: [number, number]; pixels?: [number, number]; multiple?: number;
};

export interface BuildPrompt { node?: string; input?: string; label: string; hint: string; default: string; required: boolean }
/** A cloud template opened in the Builder: its Router model, the adapter input each file fills, its prompt and settings. */
export interface CloudPreset {
  kind: "cloud"; base: string; model: string; label: string; blurb: string; mode: Mode;
  media: { slot: string; kind: MediaKind; input: number; sample: Asset | null }[];
  prompt: { default: string };
  settings: Record<string, { value: unknown; locked: boolean }>;
}

export interface BuildSpec {
  kind: "local" | "cloud"; token?: string; model?: string; replace?: string;
  /** The template this one was built from: it keeps that one's sizing, tips and model hints. */
  base?: string;
  label: string; blurb: string; mode: Mode;
  /** A workflow's model, as its author names it; Router templates show their model's own name. */
  model_name?: string;
  media: {
    /** Local: the loader's node and input. Cloud: the adapter input the file goes to, by index. */
    node?: string; input?: string | number; kind: MediaKind; label: string; hint: string; required: boolean; sample?: string | null;
    /** Clips: what the template accepts, checked before a run. Unset, the workflow's loader decides. */
    window?: [number, number]; fps?: [number, number];
  }[];
  prompt: BuildPrompt | null;
  params: { node?: string; input?: string; field?: string; key?: string; type: BuildParamType; label: string; min?: number | null; max?: number | null; step?: number | null; options?: (string | number)[]; unit?: string; default?: unknown; help?: string | null }[];
  fixed?: { node: string; input: string; value: unknown }[] | Record<string, unknown>;
  outputs?: string[];
  /** The node a declared output size writes width and height on, and the shape and step it opens at. */
  size?: { node: string; aspect?: string; default?: string } | null;
  /** Cloud: the model's settings this job asks for, at these values. Locked ones stay fixed; the rest are asked in Create. */
  settings?: { key: string; value: unknown; locked: boolean }[];
}

/** How a template's inputs can be sized. px: about px x px pixels at the input's shape (mp = px² / 1e6); 0 keeps its own size. */
export interface SizeSpec {
  options: { label: string; px: number; mp?: number }[];
  multiple: number;
  /** A declared output size: the shapes offered, and the shape and step it opens at. Absent, the workflow sizes its own output. */
  canvas?: {
    aspects: string[]; aspect: string; size: string;
    /** A cloud model's size: its own megapixel steps and limits (server/prep.py fit_dims). */
    steps?: number[]; multiple?: number; sides?: [number, number]; pixels?: [number, number];
  };
  /** Each input's default size (an option label); "Original" unless the template says otherwise. */
  inputs: Record<string, string>;
  /** The label of the option that keeps an input's own size. */
  original: string;
  /** No input runs bigger than about cap x cap pixels (Original included); 0 when the cap is lifted in Settings. */
  cap: number;
}

/** What prep will do to one image: the kept box in source pixels and the size it ends at. */
export interface PrepPlan {
  source: [number, number];
  box: [number, number, number, number];
  width: number;
  height: number;
  /** The size option it ran at (recorded on generations). */
  size?: string;
}

export interface TemplatePatch {
  label?: string;
  /** A workflow's model, shown under the name. */
  model_name?: string;
  blurb?: string;
  /** The prompt's default, by input key. */
  inputs?: Record<string, { default?: string }>;
}

export interface MissingModel {
  node_id: string;
  class_type: string;
  input: string;
  value: string;
  url?: string | null;
  folder?: string | null;
  size?: string | null;
}

export interface LocalCheck {
  ok: boolean;
  reachable?: boolean;
  message?: string;
  missing_nodes: { class_type: string; node_ids: string[]; package?: string | null }[];
  missing_models: MissingModel[];
  bad_values: { node_id: string; class_type: string; input: string; value: unknown; options?: unknown[] }[];
}

/** Edits for /media/edit, all optional: turned first, then cropped (fractions of the turned picture), then sized. */
export interface MediaOps {
  rotate?: 0 | 90 | 180 | 270;
  flip?: "h" | "v" | null;
  crop?: [number, number, number, number] | null;
  width?: number | null;
  height?: number | null;
  start?: number | null;
  end?: number | null;
  fps?: number | null;
  mute?: boolean;
}

export interface Asset {
  asset: string;
  name: string;
  kind: "image" | "video" | "audio";
  url: string;
  poster?: string | null;
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  bytes?: number;
  has_audio?: boolean;
}

export interface InputItem {
  slot: string;
  role: string;
  file?: string | null;
  sha256?: string | null;
  license: string;
  contains_person: boolean;
  consent: boolean;
  thumb?: string | null;
  url?: string | null;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  trim?: [number, number] | null;
  label?: string | null;
  /** How it was cropped and sized for the run. */
  prep?: PrepPlan | null;
}

export interface Result {
  file?: string | null;
  poster?: string | null;
  kind?: "image" | "video" | null;
  seed?: number | null;
  elapsed?: number | null;
  provider?: string | null;
  output_file?: string | null;
  error?: Record<string, unknown> | null;
}

export interface Manifest {
  format: "openillusion.generation";
  version: number;
  id: string;
  title: string;
  mode: Mode;
  created: number;
  engine: { kind: string; model: string; provider?: string | null; schema_version?: string | null };
  inputs: InputItem[];
  prompt: string;
  params: Record<string, unknown>;
  request_template: Record<string, unknown>;
  result: Result | null;
  status: "draft" | "running" | "done" | "failed" | "moderated" | "cancelled";
  outcome: Outcome | null;
  notes: string;
  tags: string[];
  starred: boolean;
  lineage: { forked_from: string | null; parent: string | null; chain: string[]; sent_to: string[] };
  attest: { sfw: boolean; rights: boolean };
  variant: "full" | "light" | "recipe" | null;
  _shelf?: string;
  _variants?: GenerationRow[];
}

export interface GenerationRow {
  id: string;
  title: string;
  mode: Mode;
  model: string;
  provider: string | null;
  status: string;
  outcome: Outcome | null;
  shelf: string;
  created: number;
  tags: string[];
  has_driving: boolean;
  ref_count: number;
  poster: string | null;
  preview: string | null;
  result_kind: "image" | "video" | null;
  starred: boolean;
  parent: string | null;
  variant: string | null;
  prompt: string | null;
  /** Result size in pixels (else the main input's), so walls lay out before media loads. */
  width: number | null;
  height: number | null;
  elapsed: number | null;
  seed: number | null;
  /** Why it failed, one line; null unless failed. */
  error: string | null;
}

export interface RouterError {
  status: number;
  error_type: string;
  message: string;
  validation: { loc: (string | number)[]; msg: string; type?: string }[];
  request_id: string | null;
}

export interface Job {
  id: string;
  title: string;
  mode: Mode;
  model: string;
  provider: string;
  /** Template id; model is what the provider runs. */
  engine?: string;
  prompt?: string;
  state: JobState;
  detail: string;
  created: number;
  started: number | null;
  finished: number | null;
  request_id: string | null;
  queue_position: number | null;
  error: (RouterError & Record<string, unknown>) | null;
  fixes: string[];
  poster: string | null;
  parent: string | null;
  kind: "cloud" | "local";
  progress: { value?: number | null; nodes_done?: number | null; nodes_total?: number | null; step?: number | null; steps?: number | null; current_node_class?: string | null } | null;
  preview: string | null;
  /** Seconds a finished run of this template usually took: the estimate where no progress comes (Comfy Router). */
  typical?: number | null;
}

export interface LocalStatus {
  ok: boolean;
  v2: boolean;
  comfyui: boolean;
  v2_url: string;
  comfyui_url: string;
  managed: boolean;
  proxy_installed: boolean;
  gpu?: string | null;
  /** Bytes, from ComfyUI's /system_stats. */
  vram_total?: number | null;
  vram_free?: number | null;
  comfyui_version?: string | null;
  reason?: string | null;
  /** The ComfyUI the v2 server says it forwards to, and whether that's the one we check. */
  upstream?: string | null;
  upstream_seen?: string | null;
  upstream_match?: boolean | null;
  /** OpenIllusion keeps comfy-api-proxy running on its own while ComfyUI is up. */
  autostart?: boolean;
}

export interface Status {
  version: string;
  has_key: boolean;
  router: { ok: boolean | null; reason: string | null; message?: string; status?: number };
  local: LocalStatus;
  onboarded: boolean;
}

/** A folder on the server's machine and the folders in it, for the folder picker (server/folders.py). */
export interface FolderListing {
  path: string;
  parent: string | null;
  dirs: { name: string; path: string }[];
  /** The folder couldn't be read. */
  denied: boolean;
  /** The path asked for isn't there; this is its nearest parent that is. */
  missing: boolean;
  writable: boolean;
  sep: string;
  roots: string[];
  places: { label: string; path: string }[];
  made?: string;
}

export interface Settings {
  has_key: boolean;
  key_hint: string;
  key_source: "browser" | "env" | null;
  router_base: string;
  output_folder: string;
  max_parallel: number;
  community_indexes: string[];
  strip_exif: boolean;
  uncap_size: boolean;
  local_v2_url: string;
  local_comfyui_url: string;
  local_autostart_proxy: boolean;
  has_local_token: boolean;
}

export interface Check {
  level: "pass" | "warn" | "info";
  text: string;
  detail: string;
}

/** A dropped file as the server took it: a template's .illusion is added at once, anything else is a review. */
export type Imported = ImportReview | { template: EngineInfo };

export interface ImportReview {
  token: string;
  manifest: Manifest;
  checks: Check[];
  source: { kind: "generation" | "png" | "mp4" | "link" | "json"; name: string };
  size: number;
  poster: string | null;
  has_driving: boolean;
  exists: boolean;
}

export interface Spec {
  engine: string;
  mode: Mode;
  title?: string;
  inputs: SpecInput[];
  prompt: string;
  params: Record<string, unknown>;
  variants?: number;
  forked_from?: string | null;
  chain?: string[];
  tags?: string[];
}

export interface SpecInput {
  slot: string;
  role: string;
  asset?: string;
  url?: string;
  license?: string;
  contains_person?: boolean;
  consent?: boolean;
  trim?: [number, number];
  duration?: number;
  label?: string;
  /** Kept part of the image as fractions [x, y, w, h]. */
  crop?: [number, number, number, number];
  /** The size it runs at (a size option label). */
  size?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

export interface TrashItem {
  id: string;
  title: string;
  prompt: string;
  mode: Mode;
  model: string;
  status: string;
  starred: boolean;
  created: number;
  deleted: number;
  purge_at: number;
  poster: string | null;
  preview: string | null;
  result_kind: "image" | "video" | null;
  width: number | null;
  height: number | null;
  bytes: number;
}

export type StorageBucket = "generations" | "trash" | "uploads" | "exports" | "backups" | "cache";

export interface BackupResult {
  file: string;
  name: string;
  size: number;
  url: string;
  counts: { generations: number; templates: number; covers: number; trash: number };
  skipped: { id: string; why: string }[];
}

/** What restoring a backup would add, before anything is written. */
export interface RestoreReview {
  token: string;
  created: number;
  app: string;
  size: number;
  generations: { total: number; new: number };
  trash: { total: number; new: number };
  templates: { total: number; new: number; conflicts: string[] };
  covers: number;
  skipped: { id: string; why: string }[];
}

export interface RestoreResult {
  generations: number;
  trash: number;
  templates: number;
  covers: number;
  settings: string[];
  damaged: { id: string; why: string }[];
  kept: string[];
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  const h = held();
  if (h.key) (init.headers as Record<string, string>)["X-Comfy-Key"] = h.key;
  if (h.token) (init.headers as Record<string, string>)["X-Comfy-Proxy-Token"] = h.token;
  if (body instanceof FormData || body instanceof Blob) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const res = await fetch(API + path, init);
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) throw new HttpError(res.status, data?.error ?? `HTTP ${res.status}`, data);
  return data as T;
}

const qs = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");

export const api = {
  status: (fresh = false) => req<Status>("GET", `/status${fresh ? "?fresh=1" : ""}`),
  testKey: async (key: string, save = false) => {
    const r = await req<Status["router"]>("POST", "/key/test", { key, save });
    if (r.ok && save && key) hold({ key });
    return r;
  },
  forgetKey: () => {
    hold({ key: "" });
    return req<Settings>("POST", "/key/forget");
  },
  onboarded: () => req("POST", "/onboarded"),
  folders: (path?: string) => req<FolderListing>("GET", `/folders${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  makeFolder: (parent: string, name: string) => req<FolderListing>("POST", "/folders", { parent, name }),
  settings: () => req<Settings>("GET", "/settings"),
  saveSettings: (s: Partial<Settings> & { local_token?: string; clear_local_token?: boolean }) => {
    if (s.local_token) hold({ token: s.local_token });
    if (s.clear_local_token) hold({ token: "" });
    return req<Settings>("POST", "/settings", s);
  },
  engines: (mode?: Mode, reload = false) => req<EngineInfo[]>("GET", `/engines?${qs({ mode, reload: reload ? 1 : undefined })}`),
  /** A finished run of the template becomes its cover; a draft's first one publishes it. */
  setCover: (engine: string, generation: string) => req<EngineInfo>("PUT", "/cover", { engine, generation }),
  resetCover: (engine: string) => req<EngineInfo>("DELETE", `/cover?${qs({ engine })}`),
  editTemplate: (engine: string, patch: TemplatePatch) => req<EngineInfo>("PATCH", "/templates", { engine, ...patch }),
  resetTemplate: (engine: string) => req<EngineInfo>("DELETE", `/templates?${qs({ engine })}`),
  buildFromFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return req<WorkflowAnalysis>("POST", "/builder/workflow", fd);
  },
  buildFromText: (text: string) => req<WorkflowAnalysis>("POST", "/builder/workflow", { text }),
  buildFromTemplate: (engine: string) => req<WorkflowAnalysis | CloudPreset>("POST", "/builder/from-template", { engine }),
  builderModels: () => req<RouterAdapter[]>("GET", "/builder/models"),
  saveTemplate: (spec: BuildSpec) => req<EngineInfo>("POST", "/builder/save", spec),
  duplicateTemplate: (engine: string) => req<EngineInfo>("POST", "/templates/duplicate", { engine }),
  publishTemplate: (engine: string, generation: string) => req<EngineInfo>("POST", "/templates/publish", { engine, generation }),
  hideTemplate: (engine: string, hidden: boolean) => req<{ ok: boolean }>("POST", "/templates/hide", { engine, hidden }),
  deleteTemplate: (engine: string) => req<{ ok: boolean }>("DELETE", `/builder/template?${qs({ engine })}`),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return req<Asset>("POST", "/upload", fd);
  },
  frame: (asset: string, t: number) => req<Asset>("POST", "/frame", { asset, t }),
  /** Crop, turn, resize, cut, resample or mute a file: a new upload, the original kept (server/edit.py). */
  mediaEdit: (asset: string, ops: MediaOps, name?: string) => req<Asset>("POST", "/media/edit", { asset, ops, name }),
  compose: (spec: Spec) => req<{ template: Record<string, unknown>; warnings: { field: string; level: string; text: string }[]; prep?: Record<string, PrepPlan> }>("POST", "/compose", spec),
  localCheck: (spec: Spec, fresh = false) => req<LocalCheck>("POST", "/local/check", { ...spec, fresh }),
  startProxy: () => req<{ ok: boolean; reason?: string | null; local: LocalStatus }>("POST", "/local/proxy/start"),
  run: (spec: Spec) => req<{ ids: string[] }>("POST", "/run", spec),
  jobs: () => req<Job[]>("GET", "/jobs"),
  cancel: (id: string) => req("POST", `/jobs/${id}/cancel`),
  clearJobs: () => req<Job[]>("POST", "/jobs/clear"),
  cancelAll: () => req<{ cancelled: number; jobs: Job[] }>("POST", "/jobs/cancel"),
  dismissJob: (id: string) => req<Job[]>("POST", `/jobs/${id}/dismiss`),
  generations: (f: Record<string, unknown>) => req<GenerationRow[]>("GET", `/generations?${qs(f)}`),
  facets: () => req<{ models: string[]; shelves: Record<string, number>; tags: string[] }>("GET", "/facets"),
  generation: (id: string) => req<Manifest>("GET", `/generations/${id}`),
  patch: (id: string, p: Partial<Pick<Manifest, "title" | "outcome" | "notes" | "tags" | "starred">>) => req<Manifest>("PATCH", `/generations/${id}`, p),
  remove: (id: string) => req("DELETE", `/generations/${id}`),
  trashMany: (ids: string[]) => req<{ moved: string[]; kept: string[]; trash_days: number }>("POST", "/generations/trash", { ids }),
  trash: () => req<TrashItem[]>("GET", "/trash"),
  restore: (id: string) => req<Manifest>("POST", `/trash/${id}/restore`),
  restoreMany: (ids: string[]) => req<{ restored: string[] }>("POST", "/trash/restore", { ids }),
  purge: (id: string) => req<{ ok: boolean }>("DELETE", `/trash/${id}`),
  purgeMany: (ids: string[]) => req<{ removed: string[] }>("POST", "/trash/purge", { ids }),
  emptyTrash: () => req<{ removed: number }>("DELETE", "/trash"),
  storage: () => req<Record<StorageBucket, { bytes: number; items: number; path: string }>>("GET", "/storage"),
  cleanStorage: (bucket: StorageBucket) => req<{ removed: number; bytes: number }>("POST", "/storage/clean", { bucket }),
  rerun: (id: string, engine?: string) => req<{ ids: string[] }>("POST", `/generations/${id}/rerun`, engine ? { engine } : {}),
  exportSizes: (id: string) => req<{ full: number; light: number; recipe: number; has_driving: boolean; link_ok: boolean }>("GET", `/generations/${id}/export/sizes`),
  recipe: (id: string) => req<{ recipe: Manifest; link: string; bytes: number }>("GET", `/generations/${id}/recipe`),
  exportGeneration: (id: string, b: { variant: string; strip_driving: boolean; embed_recipe: boolean; attest: { sfw: boolean; rights: boolean; consent: Record<string, boolean> } }) =>
    req<{ path: string; name: string; bytes: number; download: string }>("POST", `/generations/${id}/export`, b),
  importFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return req<Imported>("POST", "/import", fd);
  },
  importText: (text: string) => req<ImportReview>("POST", "/import", text.trim().startsWith("http") && !text.includes("#gen=") ? { url: text.trim() } : { text }),
  importUrl: (url: string) => req<ImportReview>("POST", "/import", { url }),
  commitImport: (token: string) => req<Manifest>("POST", `/import/${token}/commit`),
  backup: (trash: boolean) => req<BackupResult>("POST", "/backup", { trash }),
  /** The file goes as the raw body: a backup can be bigger than a form upload should be. */
  inspectBackup: (file: File) => req<RestoreReview>("POST", "/restore", file),
  restoreBackup: (token: string) => req<RestoreResult>("POST", `/restore/${token}`),
  community: (url: string) => req<{ name: string | null; generations: { url: string; title?: string; mode?: Mode; model?: string; poster?: string; author?: string; tags?: string[] }[] }>("GET", `/community?url=${encodeURIComponent(url)}`),
};

export const fileUrl = (id: string, rel: string) => `${API}/generations/${id}/file/${rel}`;
export const trashFileUrl = (id: string, rel: string) => `${API}/trash/${id}/file/${rel}`;
/** A local template as a ComfyUI workflow with its defaults; its samples land in ComfyUI's input folder. */
export const templateExportUrl = (engine: string) => `${API}/templates/export?engine=${encodeURIComponent(engine)}`;
export const templateWorkflowUrl = (engine: string) => `${API}/templates/workflow?engine=${encodeURIComponent(engine)}`;
export const workflowUrl = (id: string) => `${API}/generations/${id}/workflow`;
