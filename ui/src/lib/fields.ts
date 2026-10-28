import { isMedia, type EngineInfo, type Field, type Fit, type MediaType, type ParamSpec, type PromptIdea } from "./api";

/**
 * A template's inputs, read the same way everywhere. The studio draws whatever a template lists here;
 * nothing is special-cased by template or by mode.
 */

export const fieldsOf = (e?: EngineInfo): Field[] => e?.fields ?? [];

export type MediaField = Field & { type: MediaType };

/** What the model takes in this input (server/fit.py), or undefined when nothing is known. */
export function fitOf(e: EngineInfo | undefined, slot: string): Fit | undefined {
  return (mediaFields(e).find((x) => x.key === slot) as { fit?: Fit } | undefined)?.fit;
}

/** Photos and clips, in the template's order. */
export const mediaFields = (e?: EngineInfo): MediaField[] => fieldsOf(e).filter(isMedia);



export const videoField = (e?: EngineInfo): MediaField | undefined => mediaFields(e).find((f) => f.type === "video");

/** The video inputs: a template's own, or video:1 for a raw Router model opened for video. */
export const clipSlots = (e?: EngineInfo, mode?: string): string[] =>
  e?.fields?.length ? mediaFields(e).filter((f) => f.type === "video").map((f) => f.key) : mode === "motion" ? ["video:1"] : [];

/** The clip length a video input takes, if the template sets one. */
export const clipWindow = (e: EngineInfo | undefined, slot: string): [number, number] | null => {
  const f = mediaFields(e).find((x) => x.key === slot) as { window?: [number, number] } | undefined;
  return f?.window ?? (e?.fields?.length ? null : e?.video_window ?? null);
};

/** The frame rates a video input takes; a fixed rate when both ends match. */
export const clipFps = (e: EngineInfo | undefined, slot: string): [number, number] => {
  const f = mediaFields(e).find((x) => x.key === slot) as { fps?: [number, number] } | undefined;
  return f?.fps ?? (e?.fields?.length ? [1, 60] : e?.fps_window ?? [1, 60]);
};

export interface PromptField { key: "prompt"; label: string; hint?: string; required?: boolean; default?: string; examples?: PromptIdea[] }

/** The template's prompt. Raw Router models have no fields and always take one. */
export const promptField = (e?: EngineInfo): PromptField | undefined =>
  e?.fields?.length ? (e.fields.find((f) => f.key === "prompt") as PromptField | undefined) : e ? { key: "prompt", label: "Prompt", examples: e.examples } : undefined;

/** Settings: everything that isn't a photo, a clip or the prompt. `advanced` ones go under Advanced. */
export function settingsOf(e?: EngineInfo): { main: ParamSpec[]; advanced: ParamSpec[] } {
  if (!e?.fields?.length) return { main: [], advanced: e?.params ?? [] };
  const all = e.fields.filter((f) => !isMedia(f) && f.key !== "prompt" && f.type !== "size") as ParamSpec[];
  return { main: all.filter((p) => !p.advanced), advanced: all.filter((p) => p.advanced) };
}

/** The input the stage shows first and crops there: the clip if the template takes one, else its first photo. */
export const leadSlot = (e?: EngineInfo): string => videoField(e)?.key ?? mediaFields(e).find((f) => f.type === "image")?.key ?? "image:1";

/** Role sentences for cloud models: a template can name it; otherwise the first photo of a photo template is the canvas. */
export const roleOf = (e: EngineInfo | undefined, slot: string): string =>
  mediaFields(e).find((f) => f.key === slot)?.role ?? (slot === "image:1" && !videoField(e) ? "base" : "character");

export const slotNo = (slot: string) => Number(slot.split(":")[1]);

/** A file a cloud prompt can name: ``name`` is its card's ("Image 2"), what you write; ``token`` is what the model
 *  reads for it, numbered per kind in the order the run sends the files. The server swaps one for the other
 *  (engines/build.py, name_files). */
export interface Mention { key: string; kind: "image" | "video" | "audio"; label: string; thumb?: string | null; name: string; token: string }

export function mentions(names: Record<string, string> | undefined, files: Omit<Mention, "token" | "name">[]): Mention[] {
  const n: Record<string, number> = {};
  return files.flatMap((f) => {
    n[f.kind] = (n[f.kind] ?? 0) + 1;
    const t = names?.[f.kind];
    // In the Builder a row isn't a slot yet: saved, the files of a kind become Image 1, Image 2… in this order.
    const name = `${f.kind[0].toUpperCase()}${f.kind.slice(1)} ${f.key.startsWith(`${f.kind}:`) ? slotNo(f.key) : n[f.kind]}`;
    return t ? [{ ...f, name, token: t.replace("{n}", String(n[f.kind])) }] : [];
  });
}

/** Said when a model has no names for its files (Veo): the prompt describes them instead. */
export const noNames = (names: Record<string, string> | undefined, files: unknown[], model: string) =>
  names && files.length && !Object.keys(names).length ? `${model} has no names for its files. Describe each one in words.` : null;

