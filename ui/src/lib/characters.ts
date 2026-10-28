import type { Character, EngineInfo, RefModFile } from "./api";
import { refmodFields, roleOf, slotNo } from "./fields";
import { bySlot } from "../components/Refs";
import { newKey, slotOf, type RefSlot, type StudioState } from "./store";

/** Where a character stands, in the words its card shows. */
export function refmodState(c: Character): { tone: "ok" | "warn" | "bad" | "busy" | "none"; text: string } {
  if (c.making && c.making.state !== "failed") return { tone: "busy", text: c.making.state === "queued" ? "Sending photos" : "Making RefMod" };
  if (c.making?.state === "failed") return { tone: "bad", text: "RefMod failed" };
  if (!c.refmod) return { tone: "none", text: c.photos.length ? "No RefMod yet" : "No photos yet" };
  if (c.refmod_stale) return { tone: "warn", text: "Photos changed since" };
  return { tone: "ok", text: "RefMod ready" };
}

export const coverUrl = (c: Character) => (c.cover ? c.photo_urls[c.cover] : null);

/** A character's RefMod as the RefMod folder lists it. */
export const refmodOf = (c: Character): RefModFile | null => c.refmod && {
  name: c.refmod.file, label: c.refmod.file.replace(/\.safetensors$/i, ""), bytes: c.refmod.bytes, modified: c.refmod.made,
  character: { id: c.id, name: c.name, cover: c.cover, face: coverUrl(c) },
};

/**
 * The studio with RefMod `r` in a RefMod input. When a Lab character made it, their face also goes in the photo
 * input the template pairs with it (`photo`), if that holds nothing of the user's own: empty, a sample, or another
 * character's face.
 */
export function withRefmod(st: StudioState, e: EngineInfo, slot: string, r: RefModFile | null): Partial<StudioState> {
  const mods = { ...(st.mods ?? {}) };
  if (!r) {
    delete mods[slot];
    return { mods, current: null };
  }
  const who = r.character;
  mods[slot] = { file: r.name, name: who?.name ?? r.label };
  const photo = refmodFields(e).find((f) => f.key === slot)?.photo;
  if (!photo || !who?.cover || !who.face) return { mods, current: null };
  const n = slotNo(photo);
  const held = st.refs.find((x, i) => slotOf(x, i) === n);
  if (held && !held.sample && !held.character) return { mods, current: null };
  const face: RefSlot = {
    key: newKey(), asset: `char:${who.id}/${who.cover}`, name: `${who.name} · ${who.cover}`, kind: "image", url: who.face,
    slot: n, role: roleOf(e, photo), license: "own-image", contains_person: false, consent: false, character: who.id,
  };
  return { mods, refs: bySlot([...bySlot(st.refs).filter((x) => x.slot !== n), face]), current: null };
}
