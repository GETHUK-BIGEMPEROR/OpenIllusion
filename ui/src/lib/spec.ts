import type { EngineInfo, Mode, Spec, SpecInput } from "./api";
import { clipSlots } from "./fields";
import { slotOf, type StudioState } from "./store";

export function defaults(engine?: EngineInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of engine?.params ?? []) if (p.default !== undefined) out[p.key] = p.default;
  return out;
}

/** Studio state → the spec the server composes into a request. */
export function toSpec(mode: Mode, s: StudioState, engine?: EngineInfo): Spec {
  const inputs: SpecInput[] = [];
  s.refs.forEach((r, i) => {
    inputs.push({
      slot: `image:${slotOf(r, i)}`,
      role: r.role,
      asset: r.missing ? undefined : r.asset || undefined,
      url: r.publicUrl || undefined,
      license: r.license,
      contains_person: r.contains_person,
      consent: r.consent,
      crop: r.crop,
      size: r.size,
    });
  });
  // One clip per video input the template lists; a raw Router model takes one when it's opened for video.
  for (const slot of clipSlots(engine, mode)) {
    const v = s.videos.find((x) => x.slot === slot);
    if (!v) continue;
    inputs.push({
      slot,
      role: "motion",
      asset: v.missing ? undefined : v.asset,
      url: v.publicUrl || undefined,
      license: v.license,
      contains_person: v.contains_person,
      consent: v.consent,
      trim: v.trim,
      duration: v.duration,
      crop: v.crop,
      size: v.size,
    });
  }
  for (const a of s.sounds ?? []) {
    if (engine?.fields?.length && !engine.fields.some((f) => f.key === a.slot)) continue;
    inputs.push({ slot: a.slot, role: "audio", asset: a.missing ? undefined : a.asset, license: a.license, contains_person: false, consent: false });
  }
  return {
    engine: s.engine,
    mode,
    title: s.title || undefined,
    inputs,
    prompt: s.prompt,
    params: { ...defaults(engine), ...s.params },
    variants: s.variants,
    forked_from: s.forked_from,
    chain: s.chain,
    tags: s.tags,
  };
}
