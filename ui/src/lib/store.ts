import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import type { Asset, Box, ImportReview, Manifest, Mode } from "./api";
import { fileUrl } from "./api";

export interface Media {
  asset: string; // upload id or gen:<id>/<rel>
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
  /** One of the template's sample inputs, not the user's own. */
  sample?: boolean;
}

/** Which image:N a tray entry is sent as. */
export const slotOf = (r: Pick<RefSlot, "slot">, i: number) => r.slot ?? i + 1;

export interface VideoSlot extends Media {
  trim: [number, number];
  maxHeight?: number;
  license: string;
  contains_person: boolean;
  consent: boolean;
  publicUrl?: string;
}

export interface StudioState {
  engine: string;
  title: string;
  video: VideoSlot | null;
  refs: RefSlot[];
  prompt: string;
  params: Record<string, unknown>;
  boxes: Box[];
  variants: number;
  raw: string | null;
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
const DRAFT_KEYS = ["title", "video", "refs", "prompt", "params", "boxes", "raw", "forked_from", "chain", "tags", "current", "group", "selected", "returnRole", "seeded"] as const;

/** A studio on a template, from scratch: the draft is cleared, the run history and variant count stay. */
const fresh = (prev: StudioState, engine: string): StudioState => {
  const blank = blankStudio();
  return { ...prev, ...Object.fromEntries(DRAFT_KEYS.map((k) => [k, blank[k]])), engine };
};

const blankStudio = (): StudioState => ({
  engine: "", // filled from Settings' default, else the mode's first template (useStudio)
  title: "",
  video: null,
  refs: [],
  prompt: "",
  params: {},
  boxes: [],
  variants: 1,
  raw: null,
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

export const fromAsset = (a: Asset): Media => ({ ...a });

export const newKey = () => Math.random().toString(36).slice(2, 10);

export interface Toast {
  id: string;
  text: string;
  tone?: "ok" | "warn" | "error";
  action?: { label: string; run: () => void };
}

interface AppState {
  motion: StudioState;
  edit: StudioState;
  queueOpen: boolean;
  shareFor: string | null;
  review: ImportReview | null;
  search: string;
  toasts: Toast[];
  setStudio: (mode: Mode, patch: Partial<StudioState> | ((s: StudioState) => Partial<StudioState>)) => void;
  /** Open a template with a fresh draft, even when it is the one already open. */
  openTemplate: (mode: Mode, engine: string) => void;
  loadGeneration: (m: Manifest, opts?: { engine?: string; dropVideo?: boolean }) => Mode;
  setQueue: (open: boolean) => void;
  share: (id: string | null) => void;
  setReview: (r: ImportReview | null) => void;
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
      queueOpen: false,
      shareFor: null,
      review: null,
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
            width: i.width ?? undefined,
            height: i.height ?? undefined,
            role: i.role,
            license: i.license,
            contains_person: i.contains_person,
            consent: i.consent,
            publicUrl: i.url ?? undefined,
          }));
        const v = m.inputs.find((i) => i.slot.startsWith("video:"));
        const video: VideoSlot | null =
          v && v.file && !opts.dropVideo
            ? {
                asset: src(v.file),
                name: "driving.mp4",
                kind: "video",
                url: fileUrl(m.id, v.file),
                poster: fileUrl(m.id, "driving/poster.webp"),
                duration: v.duration ?? undefined,
                trim: [0, v.duration ?? 0],
                license: v.license,
                contains_person: v.contains_person,
                consent: v.consent,
                publicUrl: v.url ?? undefined,
              }
            : null;
        const prev = get()[mode];
        const engine = opts.engine ?? m.engine.model;
        const next: StudioState = {
          ...blankStudio(),
          variants: prev.variants,
          engine,
          title: m.title,
          video,
          refs,
          prompt: m.prompt,
          params: { ...m.params },
          boxes: m.boxes ?? [],
          forked_from: m.id,
          chain: m.lineage.chain ?? [],
          tags: m.tags ?? [],
          session: get()[mode].session,
        };
        set({ [mode]: next } as Partial<AppState>);
        return mode;
      },
      setQueue: (queueOpen) => set({ queueOpen }),
      share: (shareFor) => set({ shareFor }),
      setReview: (review) => set({ review }),
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
      partialize: (s) => ({ motion: s.motion, edit: s.edit }),
      // v2: the built-in cloud engines were removed; drafts pointing at one start without an engine.
      version: 2,
      migrate: (old, from) => {
        const st = old as Partial<AppState>;
        if (from < 2) for (const m of ["motion", "edit"] as const) if (st[m] && !st[m]!.engine.startsWith("local/")) st[m] = { ...st[m]!, engine: "" };
        return st as AppState;
      },
    },
  ),
);
