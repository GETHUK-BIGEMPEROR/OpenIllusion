// Shared by the Create modules: accepted files, sample inputs, and the studio setter type.
import { useStudio } from "../../components/Studio";
import type { EngineInfo } from "../../lib/api";
import { clipWindow, roleOf, slotNo } from "../../lib/fields";
import { newKey, slotOf, type RefSlot, type StudioState, type VideoSlot } from "../../lib/store";
import type { Crop } from "../../lib/size";

export type View = "input" | "result" | "compare" | "grid";

export type SetS = ReturnType<typeof useStudio>[1];

export const ACCEPT = "image/png,image/jpeg,image/webp";

export const ACCEPT_VIDEO = "video/mp4,video/quicktime,video/webm,.m4v";

export const ACCEPT_AUDIO = "audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac";

export const FAILED = new Set(["failed", "moderated", "cancelled"]);

/** A studio change to one input's attributes (shape, size), photo or clip alike. */
export const withInput = (slot: string, patch: { crop?: Crop; size?: string }) => (st: StudioState): Partial<StudioState> => slot.startsWith("video:")
  ? { videos: st.videos.map((v) => (v.slot === slot ? { ...v, ...patch } : v)), current: null }
  : { refs: st.refs.map((r, i) => (`image:${slotOf(r, i)}` === slot ? { ...r, ...patch } : r)), current: null };

/** A template's sample for one photo input, as a tray entry. */
export function sampleRef(e: EngineInfo, slot: string): RefSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === slot);
  if (!i) return null;
  return { ...i, key: newKey(), slot: slotNo(slot), sample: true, license: "generated", contains_person: false, consent: false, role: roleOf(e, slot) };
}

/** A template's sample clip, trimmed to fit its window. */
export function sampleVideo(e: EngineInfo, slot: string): VideoSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === slot);
  if (!i) return null;
  const d = i.duration ?? 0;
  const win = clipWindow(e, slot);
  return { ...i, trim: [0, win ? Math.min(d, win[1]) : d], sample: true, license: "generated", contains_person: false, consent: false };
}
