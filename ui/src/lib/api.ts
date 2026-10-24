// Thin client for the OpenIllusion server's /api. The API key and the proxy token
// never come back from the server; only whether they are set.

export const API = "/api";

export type Mode = "motion" | "edit";
export type Outcome = "worked" | "partly" | "didnt";
export type JobState =
  | "estimating" | "waiting" | "queued" | "running" | "rate_limited"
  | "downloading" | "done" | "failed" | "moderated" | "cancelled";

export interface ParamSpec {
  key: string;
  label: string;
  type: "int" | "segmented" | "bool" | "seed" | "string" | "select" | "number";
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  options?: string[];
  unit?: string;
  help?: string;
}

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
  /** Local templates can name and hint their prompt box. */
  prompt?: { label?: string; hint?: string; required?: boolean } | null;
  /** Sample prompts, shown as chips. */
  examples?: string[];
  tips?: string[];
  tags?: string[];
  /** What each image slot is for. */
  inputs?: { slot: string; label?: string; hint?: string }[];
  /** Model files and node types a local template needs in ComfyUI. */
  requires?: { models: { name: string; folder: string; url?: string | null }[]; nodes: string[] };
  /** The fixed text wrapped around the user's prompt (local templates that declare it). */
  instruction?: { start?: string; end?: string } | null;
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
  /** How the app crops and sizes images before the run (openillusion/prep.py). */
  size?: SizeSpec | null;
  /** What the template opens with: a prompt, and a sample for each slot (assets like uploads). */
  defaults?: { prompt: string; inputs: (Asset & { slot: string })[] };
}

/** A template's size options. px: about px x px pixels at the picture's shape; 0 keeps its own size. */
export interface SizeSpec {
  options: { label: string; px: number }[];
  default: string;
  multiple: number;
  /** The image whose shape sets the output, e.g. "image:1". */
  follows: string;
}

/** What prep will do to one image: the kept box in source pixels and the size it ends at. */
export interface PrepPlan {
  source: [number, number];
  box: [number, number, number, number];
  width: number;
  height: number;
}

export interface TemplatePatch {
  label?: string;
  blurb?: string;
  tags?: string[];
  examples?: string[];
  tips?: string[];
  prompt?: { label?: string; hint?: string };
  default_prompt?: string;
  instruction?: { start?: string; end?: string };
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

export interface Asset {
  asset: string;
  name: string;
  kind: "image" | "video";
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
}

export interface Box {
  id: string;
  rect: [number, number, number, number]; // x, y, w, h as fractions
  label: string;
  from?: string;
}

export interface Result {
  file?: string | null;
  poster?: string | null;
  kind?: "image" | "video" | null;
  seed?: number | null;
  cost_reported?: string | null;
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
  boxes: Box[];
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
}

export interface Estimate {
  source: "exact" | "estimated" | "unknown" | "invalid" | "local";
  amount?: string;
  min_amount?: string;
  max_amount?: string;
  reason?: string;
  router?: RouterError;
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
  state: JobState;
  detail: string;
  created: number;
  started: number | null;
  finished: number | null;
  request_id: string | null;
  queue_position: number | null;
  estimate: Estimate | null;
  error: (RouterError & Record<string, unknown>) | null;
  fixes: string[];
  poster: string | null;
  parent: string | null;
  kind: "cloud" | "local";
  progress: { value?: number | null; nodes_done?: number | null; nodes_total?: number | null; step?: number | null; steps?: number | null; current_node_class?: string | null } | null;
  preview: string | null;
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
  router: { ok: boolean | null; reason: string | null; message?: string };
  local: LocalStatus;
  onboarded: boolean;
}

export interface Settings {
  has_key: boolean;
  key_hint: string;
  key_source: "settings" | "env" | null;
  router_base: string;
  default_motion_engine: string;
  default_edit_engine: string;
  output_folder: string;
  max_parallel: number;
  community_indexes: string[];
  strip_exif: boolean;
  grounding_default: boolean;
  confirm_unknown_cost: boolean;
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
  boxes?: Box[];
  params: Record<string, unknown>;
  raw?: Record<string, unknown> | null;
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
  max_height?: number;
  label?: string;
  /** Kept part of the image as fractions [x, y, w, h]. */
  crop?: [number, number, number, number];
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public body: any) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
  if (body instanceof FormData) init.body = body;
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
  testKey: (key: string, save = false) => req<Status["router"]>("POST", "/key/test", { key, save }),
  forgetKey: () => req<Settings>("POST", "/key/forget"),
  onboarded: () => req("POST", "/onboarded"),
  settings: () => req<Settings>("GET", "/settings"),
  saveSettings: (s: Partial<Settings> & { api_key?: string; local_token?: string }) => req<Settings>("POST", "/settings", s),
  engines: (mode?: Mode, reload = false) => req<EngineInfo[]>("GET", `/engines?${qs({ mode, reload: reload ? 1 : undefined })}`),
  setCover: (engine: string, from: { asset: string } | { generation: string }) => req<EngineInfo>("PUT", "/cover", { engine, ...from }),
  resetCover: (engine: string) => req<EngineInfo>("DELETE", `/cover?${qs({ engine })}`),
  editTemplate: (engine: string, patch: TemplatePatch) => req<EngineInfo>("PATCH", "/templates", { engine, ...patch }),
  resetTemplate: (engine: string) => req<EngineInfo>("DELETE", `/templates?${qs({ engine })}`),
  catalog: () => req<{ id: string; provider: string; model: string }[]>("GET", "/catalog"),
  schema: (model: string) => req<{ schema: any; input_modalities: string[]; output_modalities: string[]; version: string; authored: boolean }>("GET", `/schema?model=${encodeURIComponent(model)}`),
  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return req<Asset>("POST", "/upload", fd);
  },
  frame: (asset: string, t: number) => req<Asset>("POST", "/frame", { asset, t }),
  compose: (spec: Spec) => req<{ template: Record<string, unknown>; warnings: { field: string; level: string; text: string }[]; role_sentences: string; prep?: Record<string, PrepPlan> }>("POST", "/compose", spec),
  estimate: (spec: Spec) => req<Estimate>("POST", "/estimate", spec),
  localCheck: (spec: Spec, fresh = false) => req<LocalCheck>("POST", "/local/check", { ...spec, fresh }),
  startProxy: () => req<{ ok: boolean; reason?: string | null; local: LocalStatus }>("POST", "/local/proxy/start"),
  run: (spec: Spec) => req<{ ids: string[] }>("POST", "/run", spec),
  jobs: () => req<Job[]>("GET", "/jobs"),
  cancel: (id: string) => req("POST", `/jobs/${id}/cancel`),
  clearJobs: () => req<Job[]>("POST", "/jobs/clear"),
  generations: (f: Record<string, unknown>) => req<GenerationRow[]>("GET", `/generations?${qs(f)}`),
  facets: () => req<{ models: string[]; shelves: Record<string, number>; tags: string[] }>("GET", "/facets"),
  generation: (id: string) => req<Manifest>("GET", `/generations/${id}`),
  patch: (id: string, p: Partial<Pick<Manifest, "title" | "outcome" | "notes" | "tags" | "starred">>) => req<Manifest>("PATCH", `/generations/${id}`, p),
  remove: (id: string) => req("DELETE", `/generations/${id}`),
  trash: () => req<{ id: string; title: string; deleted: number }[]>("GET", "/trash"),
  restore: (id: string) => req<Manifest>("POST", `/trash/${id}/restore`),
  rerun: (id: string, engine?: string) => req<{ ids: string[] }>("POST", `/generations/${id}/rerun`, engine ? { engine } : {}),
  exportSizes: (id: string) => req<{ full: number; light: number; recipe: number; has_driving: boolean; link_ok: boolean }>("GET", `/generations/${id}/export/sizes`),
  recipe: (id: string) => req<{ recipe: Manifest; link: string; bytes: number }>("GET", `/generations/${id}/recipe`),
  exportGeneration: (id: string, b: { variant: string; strip_driving: boolean; embed_recipe: boolean; attest: { sfw: boolean; rights: boolean; consent: Record<string, boolean> } }) =>
    req<{ path: string; name: string; bytes: number; download: string }>("POST", `/generations/${id}/export`, b),
  importFile: (file: File) => {
    const fd = new FormData();
    fd.append("file", file, file.name);
    return req<ImportReview>("POST", "/import", fd);
  },
  importText: (text: string) => req<ImportReview>("POST", "/import", text.trim().startsWith("http") && !text.includes("#gen=") ? { url: text.trim() } : { text }),
  importUrl: (url: string) => req<ImportReview>("POST", "/import", { url }),
  commitImport: (token: string) => req<Manifest>("POST", `/import/${token}/commit`),
  community: (url: string) => req<{ name: string | null; generations: { url: string; title?: string; mode?: Mode; model?: string; poster?: string; author?: string; tags?: string[] }[] }>("GET", `/community?url=${encodeURIComponent(url)}`),
};

export const fileUrl = (id: string, rel: string) => `${API}/generations/${id}/file/${rel}`;
export const workflowUrl = (id: string) => `${API}/generations/${id}/workflow`;
