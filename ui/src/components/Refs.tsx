import { useState } from "react";
import { api } from "../lib/api";
import { errMsg } from "../lib/format";
import type { Asset, Mode } from "../lib/api";
import { EDIT_ROLES, ROLES } from "../lib/format";
import { newKey, slotOf, useApp, type RefSlot } from "../lib/store";

/**
 * Uploaded images added to a tray. Each takes the first free input slot, so a
 * drop fills a template's empty slots in order; slot 1 gets the default role.
 */
export function withRefs(refs: RefSlot[], assets: Asset[], roles: readonly string[], defaultRole: string): RefSlot[] {
  const taken = new Set(refs.map(slotOf));
  const free = () => { let n = 1; while (taken.has(n)) n++; taken.add(n); return n; };
  const added = assets.map((a) => {
    const slot = free();
    return { ...a, key: newKey(), slot, role: slot === 1 ? defaultRole : roles.find((r) => r !== defaultRole) ?? defaultRole,
      license: "own-image", contains_person: false, consent: false } as RefSlot;
  });
  return bySlot([...refs, ...added]);
}

/** Tray order follows the slots, so refs[0] is always image:1 when it's filled. */
export const bySlot = (refs: RefSlot[]) => refs.map((r, i) => ({ ...r, slot: slotOf(r, i) })).sort((a, b) => a.slot - b.slot);

/** Add images to a studio's tray from outside it (a drop on the canvas or anywhere in the window). */
export function addToTray(mode: Mode, assets: Asset[]) {
  const st = useApp.getState();
  const [roles, def] = mode === "edit" ? [EDIT_ROLES, "base"] : [ROLES, "character"];
  st.setStudio(mode, (s) => {
    // Your photos take the place of the template's samples first, in slot order.
    let refs = bySlot(s.refs);
    const rest: Asset[] = [];
    for (const a of assets) {
      const i = refs.findIndex((r) => r.sample);
      if (i < 0) { rest.push(a); continue; }
      const [added] = withRefs([], [a], roles, def);
      refs = refs.map((r, k) => (k === i ? { ...added, slot: r.slot, role: r.role } : r));
    }
    return { refs: rest.length ? withRefs(refs, rest, roles, def) : refs, current: null };
  });
}

export function useUploader() {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(0);
  const upload = async (files: File[], kind?: "image" | "video" | "audio") => {
    setBusy((n) => n + files.length);
    const out = [];
    for (const f of files) {
      try {
        const a = await api.upload(f);
        if (kind && a.kind !== kind) toast({ text: `${f.name} is ${a.kind === "image" ? "an image" : a.kind === "audio" ? "a sound" : "a video"}, not ${kind === "image" ? "an image" : kind === "audio" ? "a sound" : "a video"}.`, tone: "warn" });
        else out.push(a);
      } catch (e) {
        toast({ text: `${f.name}: ${errMsg(e)}`, tone: "error" });
      } finally {
        setBusy((n) => n - 1);
      }
    }
    return out;
  };
  return { upload, busy };
}
