import { useEffect, useRef, useState, type DragEvent } from "react";
import { api, type Asset, type EngineInfo, type Mode } from "../lib/api";
import { errMsg } from "../lib/format";
import { cachedEngine } from "../lib/query";
import { go } from "../lib/route";
import { clipSlots, clipWindow } from "../lib/fields";
import { clipIn, useApp, withClip, type VideoSlot } from "../lib/store";
import { addToTray } from "./Refs";
import { seedFrom } from "./Studio";

// Formats the server turns into PNG, MP4 or MP3 on upload; browsers often give these no type.
const IMAGE_EXT = /\.(gif|bmp|tiff?|avif|tga|ico)$/i;
const VIDEO_EXT = /\.(mkv|avi|wmv|flv|mpe?g|3gp|ts|mts|m2ts|ogv|m4v)$/i;
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|flac|opus|wma|aiff?|amr)$/i;
export const isImage = (f: File) => f.type.startsWith("image/") || IMAGE_EXT.test(f.name);
export const isVideo = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name);
export const isAudio = (f: File) => f.type.startsWith("audio/") || AUDIO_EXT.test(f.name);
export const isMediaFile = (f: File) => isImage(f) || isVideo(f);

/**
 * A drop target for files. Spread ``props`` on the element and style it with ``over``.
 * It marks itself ``data-own-drop`` so the drop-anywhere handler leaves it alone.
 * Files that ``accept`` turns down go to ``onReject`` (or are ignored).
 */
export function useFileDrop(onFiles: (files: File[]) => void, opts: { accept?: (f: File) => boolean; onReject?: (files: File[]) => void; disabled?: boolean } = {}) {
  const [over, setOver] = useState(false);
  const has = (e: DragEvent) => !opts.disabled && e.dataTransfer.types.includes("Files");
  const props = {
    "data-own-drop": "",
    onDragOver: (e: DragEvent) => {
      if (!has(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "copy";
      if (!over) setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      const files = [...e.dataTransfer.files];
      setOver(false);
      if (!has(e) || !files.length) return;
      e.preventDefault();
      e.stopPropagation();
      const ok = opts.accept ? files.filter(opts.accept) : files;
      if (ok.length) onFiles(ok);
      else opts.onReject?.(files);
    },
  };
  return { over, props };
}

// The page that takes files dropped anywhere on it (the Builder's inputs), if one is open.
let page: { take: (files: File[]) => boolean; hint: () => string } | null = null;

/** While mounted, files dropped off any input go to ``take`` (true: it took them). ``hint`` is the drop cue's line. */
export function usePageDrop(take: (files: File[]) => boolean, hint: string) {
  const live = useRef({ take, hint });
  live.current = { take, hint };
  useEffect(() => {
    const me = { take: (f: File[]) => live.current.take(f), hint: () => live.current.hint };
    page = me;
    return () => { if (page === me) page = null; };
  }, []);
}

export const pageDrop = (files: File[]) => page?.take(files) ?? false;
export const pageDropHint = () => page?.hint() ?? null;

/** An uploaded clip in a video input: trimmed to the length that input takes. */
export function clipSlot(a: Asset, e: EngineInfo | undefined, slot: string, size?: string): VideoSlot {
  const d = a.duration ?? 0;
  const win = clipWindow(e, slot);
  return { ...a, slot, trim: [0, win ? Math.min(d, win[1]) : d], size, license: "own-footage", contains_person: true, consent: false };
}

/** Uploaded files into a studio's template: photos take the samples' places in slot order, clips the video inputs in order. */
export function placeAssets(mode: Mode, assets: Asset[]) {
  const st = useApp.getState();
  const photos = assets.filter((a) => a.kind === "image");
  const clips = assets.filter((a) => a.kind === "video");
  if (photos.length) addToTray(mode, photos);
  if (clips.length) {
    const e = cachedEngine(st[mode].engine);
    const slots = clipSlots(e, mode);
    if (!slots.length) return;
    st.setStudio(mode, (s) => {
      // Empty inputs first, then the template's samples, then the user's own clips; one clip each.
      const rank = (slot: string) => { const v = s.videos.find((x) => x.slot === slot); return !v ? 0 : v.sample ? 1 : 2; };
      const order = [...slots].sort((a, b) => rank(a) - rank(b));
      let videos = s.videos;
      clips.slice(0, slots.length).forEach((c, i) => { const slot = order[i]; videos = withClip({ videos }, slot, clipSlot(c, e, slot, clipIn(s, slot)?.size)); });
      return { videos, current: null };
    });
  }
}

async function uploadAll(files: File[]) {
  const toast = useApp.getState().toast;
  const out: Asset[] = [];
  for (const f of files) {
    try {
      out.push(await api.upload(f));
    } catch (e) {
      toast({ text: `${f.name}: ${errMsg(e)}`, tone: "error" });
    }
  }
  return out;
}

/** Drop photos or clips into a studio's template. */
export async function dropIntoStudio(mode: Mode, files: File[]) {
  placeAssets(mode, await uploadAll(files.filter(isMediaFile)));
}

/** Open ``e`` in Create, fresh, with these files in place of its samples. */
export async function openWithFiles(e: EngineInfo, files: File[]) {
  const st = useApp.getState();
  const media = files.filter(isMediaFile);
  const name = e.label;
  const takes = (k: string) => !!e.inputs?.some((i) => i.slot.startsWith(`${k}:`));
  if (media.some(isVideo) && !takes("video")) return st.toast({ text: `${name} takes photos, not video.`, tone: "warn" });
  if (media.some(isImage) && !takes("image")) return st.toast({ text: `${name} takes a video, not photos.`, tone: "warn" });
  st.openTemplate(e.mode, e.id);
  st.setStudio(e.mode, seedFrom(e));
  go({ name: e.mode });
  placeAssets(e.mode, await uploadAll(media));
}
