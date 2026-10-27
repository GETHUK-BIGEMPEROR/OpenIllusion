import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { ImportReview, Manifest, Mode, RestoreReview } from "./api";
import { fileUrl } from "./api";

export interface Media {
  asset: string; // upload id or gen:<id>/<rel>
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
  thumb?: string | null; // Recipe-only generations: a placeholder thumbnail
  missing?: boolean; // in the recipe but not on disk; "use your own"
}

export interface RefSlot extends Media {
  key: string;
  role: string;
  license: string;
  contains_person: boolean;
  consent: boolean;
  publicUrl?: string;
  /** Template input this image fills (1 = image:1). Unset: its place in the tray decides. */
  slot?: number;
  /** Kept part of the image as fractions [x, y, w, h]; the server crops before the run. */
  crop?: [number, number, number, number];
  /** The size it runs at (a size option label); unset means the template's default for its slot. */
  size?: string;
  /** One of the template's sample inputs, not the user's own. */
  sample?: boolean;
}

/** Which image:N a tray entry is sent as. */
export const slotOf = (r: Pick<RefSlot, "slot">, i: number) => r.slot ?? i + 1;

export interface VideoSlot extends Media {
  /** The template input this clip fills, like "video:1". */
  slot: string;
  trim: [number, number];
  /** Kept part of every frame as fractions [x, y, w, h]; the server crops before the run. */
  crop?: [number, number, number, number];
  /** The size it runs at (a size option label); unset means the template's default for its slot. */
  size?: string;
  license: string;
  contains_person: boolean;
  consent: boolean;
  publicUrl?: string;
  /** The template's sample clip, not the user's own. */
  sample?: boolean;
}

export interface SoundSlot extends Media {
  /** The template input this sound fills, like "audio:1". */
  slot: string;
  license: string;
  /** The template's sample sound, not the user's own. */
  sample?: boolean;
}

export interface StudioState {
  engine: string;
  title: string;
  /** One clip per video input, by slot. */
  videos: VideoSlot[];
  /** One sound per audio input, by slot. Missing in drafts saved before audio inputs. */
  sounds?: SoundSlot[];
  refs: RefSlot[];
  prompt: string;
  params: Record<string, unknown>;
  variants: number;
  forked_from: string | null;
  chain: string[];
  tags: string[];
  current: string | null;
  session: string[];
  selected: string[]; // starred variants (edit)
  returnRole: string | null; // "Edit this frame": role it returns to Motion as
  group: string[]; // the generations of the last run (variants)
  /** The template whose samples and default prompt this draft was opened with (filled once). */
  seeded?: string;
}

/** What belongs to one template's draft. Engine-independent studio settings (variants, session) stay put. */
const DRAFT_KEYS = ["title", "videos", "sounds", "refs", "prompt", "params", "forked_from", "chain", "tags", "current", "group", "selected", "returnRole", "seeded"] as const;

/** A studio on a template, from scratch: the draft is cleared, the run history and variant count stay. */
const fresh = (prev: StudioState, engine: string): StudioState => {
  const blank = blankStudio();
  return { ...prev, ...Object.fromEntries(DRAFT_KEYS.map((k) => [k, blank[k]])), engine };
};

const blankStudio = (): StudioState => ({
  engine: "", // filled from Settings' default, else the mode's first template (useStudio)
  title: "",
  videos: [],
  sounds: [],
  refs: [],
  prompt: "",
  params: {},
  variants: 1,
  forked_from: null,
  chain: [],
  tags: [],
  current: null,
  session: [],
  selected: [],
  returnRole: null,
  group: [],
  seeded: "",
});

export const newKey = () => Math.random().toString(36).slice(2, 10);
/** A template to run once as soon as Create opens it: the Builder's "Run once". Not persisted. */
export const autorun: { engine: string | null } = { engine: null };

/** A generation's clip poster: driving/driving.mp4 → driving/poster.webp, driving/driving-2.mp4 → driving/poster-2.webp. */
export const posterOf = (file: string) => file.replace(/driving(-\d+)?\.mp4$/, "poster$1.webp");

/** The clip in a video input, if one is there. */
export const clipIn = (s: Pick<StudioState, "videos">, slot: string) => s.videos.find((v) => v.slot === slot) ?? null;
/** The studio's clips with one input's clip put in, changed, or (null) taken out. */
export const withClip = (s: Pick<StudioState, "videos">, slot: string, v: Omit<VideoSlot, "slot"> | null): VideoSlot[] => {
  const rest = s.videos.filter((x) => x.slot !== slot);
  return v ? [...rest, { ...v, slot }].sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true })) : rest;
};
/** The sound in an audio input, if one is there. */
export const soundIn = (s: Pick<StudioState, "sounds">, slot: string) => (s.sounds ?? []).find((x) => x.slot === slot) ?? null;
/** The studio's sounds with one input's sound put in, or (null) taken out. */
export const withSound = (s: Pick<StudioState, "sounds">, slot: string, x: Omit<SoundSlot, "slot"> | null): SoundSlot[] => {
  const rest = (s.sounds ?? []).filter((y) => y.slot !== slot);
  return x ? [...rest, { ...x, slot }].sort((a, b) => a.slot.localeCompare(b.slot, undefined, { numeric: true })) : rest;
};

export interface Toast {
  id: string;
  text: string;
  tone?: "ok" | "warn" | "error";
  action?: { label: string; run: () => void };
}

interface AppState {
  motion: StudioState;
  edit: StudioState;
  /** The studio last open, so Create returns to it (image or video). */
  lastStudio: Mode;
  queueOpen: boolean;
  palette: boolean;
  /** The Library wall's order, so the viewer can step through it. */
  libList: string[];
  shareFor: string | null;
  review: ImportReview | null;
  search: string;
  toasts: Toast[];
  setStudio: (mode: Mode, patch: Partial<StudioState> | ((s: StudioState) => Partial<StudioState>)) => void;
  /** Open a template with a fresh draft, even when it is the one already open. */
  openTemplate: (mode: Mode, engine: string) => void;
  loadGeneration: (m: Manifest, opts?: { engine?: string; dropVideo?: boolean }) => Mode;
  setQueue: (open: boolean) => void;
  setPalette: (open: boolean) => void;
  setLibList: (ids: string[]) => void;
  share: (id: string | null) => void;
  setReview: (r: ImportReview | null) => void;
  /** A dropped backup: its name while the server checks it, then what restoring would add. */
  restoring: { name: string; review?: RestoreReview } | null;
  setRestoring: (r: { name: string; review?: RestoreReview } | null) => void;
  setSearch: (q: string) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: string) => void;
}

const safeStorage = createJSONStorage(() => {
  try {
    const k = "__mk";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
});

export const useApp = create<AppState>()(
  persist(
    (set, get) => ({
      motion: blankStudio(),
      edit: blankStudio(),
      lastStudio: "edit",
      queueOpen: false,
      palette: false,
      libList: [],
      shareFor: null,
      review: null,
      restoring: null,
      search: "",
      toasts: [],
      setStudio: (mode, patch) =>
        set((s) => {
          const prev = s[mode];
          const p = typeof patch === "function" ? patch(prev) : patch;
          // Another template starts from scratch: nothing carries over from the last one.
          const switched = !!prev.engine && !!p.engine && p.engine !== prev.engine;
          return { [mode]: switched ? { ...fresh(prev, p.engine!), ...p } : { ...prev, ...p } } as Partial<AppState>;
        }),
      openTemplate: (mode, engine) => set((s) => ({ [mode]: fresh(s[mode], engine) }) as Partial<AppState>),
      loadGeneration: (m, opts = {}) => {
        // Remix: every input and setting goes back into the studio.
        const mode = m.mode;
        const src = (rel?: string | null) => (rel ? `gen:${m.id}/${rel}` : "");
        const refs: RefSlot[] = m.inputs
          .filter((i) => i.slot.startsWith("image:"))
          .map((i) => ({
            key: newKey(),
            asset: src(i.file),
            name: i.file?.split("/").pop() ?? i.slot,
            kind: "image",
            url: i.file ? fileUrl(m.id, i.file) : i.thumb ?? "",
            thumb: i.thumb,
            missing: !i.file,
            size: i.prep?.size,
            width: i.width ?? undefined,
            height: i.height ?? undefined,
            role: i.role,
            license: i.license,
            contains_person: i.contains_person,
            consent: i.consent,
            publicUrl: i.url ?? undefined,
          }));
        const videos: VideoSlot[] = opts.dropVideo ? [] : m.inputs
          .filter((v) => v.slot.startsWith("video:") && v.file)
          .map((v) => ({
                slot: v.slot,
                asset: src(v.file),
                name: v.file!.split("/").pop()!,
                kind: "video",
                url: fileUrl(m.id, v.file!),
                poster: fileUrl(m.id, posterOf(v.file!)),
                duration: v.duration ?? undefined,
                trim: [0, v.duration ?? 0],
                size: v.prep?.size,
                width: v.width ?? undefined,
                height: v.height ?? undefined,
                license: v.license,
                contains_person: v.contains_person,
                consent: v.consent,
                publicUrl: v.url ?? undefined,
          }));
        const sounds: SoundSlot[] = m.inputs
          .filter((a) => a.slot.startsWith("audio:") && a.file)
          .map((a) => ({ slot: a.slot, asset: src(a.file), name: a.file!.split("/").pop()!, kind: "audio", url: fileUrl(m.id, a.file!), license: a.license }));
        const prev = get()[mode];
        const engine = opts.engine ?? m.engine.model;
        const next: StudioState = {
          ...blankStudio(),
          variants: prev.variants,
          engine,
          // A remix is a new run: it takes its template's name unless someone renames it.
          title: "",
          videos,
          sounds,
          refs,
          prompt: m.prompt,
          params: { ...m.params },
          forked_from: m.id,
          chain: m.lineage.chain ?? [],
          tags: m.tags ?? [],
          session: get()[mode].session,
        };
        set({ [mode]: next } as Partial<AppState>);
        return mode;
      },
      setQueue: (queueOpen) => set({ queueOpen, ...(queueOpen ? { palette: false } : {}) }),
      setPalette: (palette) => set({ palette, ...(palette ? { queueOpen: false } : {}) }),
      setLibList: (libList) => set({ libList }),
      share: (shareFor) => set({ shareFor }),
      setReview: (review) => set({ review }),
      setRestoring: (restoring) => set({ restoring }),
      setSearch: (search) => set({ search }),
      toast: (t) => {
        const id = newKey();
        set((s) => ({ toasts: [...s.toasts.slice(-3), { ...t, id }] }));
        setTimeout(() => get().dismiss(id), t.action ? 9000 : 4500);
      },
      dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
    }),
    {
      name: "openillusion.studio.v1",
      storage: safeStorage,
      partialize: (s) => ({ motion: s.motion, edit: s.edit, lastStudio: s.lastStudio }),
      // v2: the built-in cloud engines were removed; drafts pointing at one start without an engine.
      // v3: one clip per video input instead of a single clip.
      version: 3,
      migrate: (old, from) => {
        const st = old as Partial<AppState>;
        if (from < 2) for (const m of ["motion", "edit"] as const) if (st[m] && !st[m]!.engine.startsWith("local/")) st[m] = { ...st[m]!, engine: "" };
        if (from < 3) {
          for (const m of ["motion", "edit"] as const) {
            const prev = st[m] as (StudioState & { video?: Omit<VideoSlot, "slot"> | null }) | undefined;
            if (!prev) continue;
            const { video, ...rest } = prev;
            st[m] = { ...rest, videos: video ? [{ ...video, slot: "video:1" }] : [] };
          }
        }
        return st as AppState;
      },
    },
  ),
);
