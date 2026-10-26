import type { EngineInfo, Mode, Spec, SpecInput } from "./api";
import { areaField, videoField } from "./fields";
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
  // A template takes a clip when it lists one; a raw Router model when it's opened for video.
  const clip = engine?.fields?.length ? videoField(engine)?.key : mode === "motion" ? "video:1" : undefined;
  if (clip && s.video) {
    inputs.push({
      slot: clip,
      role: "motion",
      asset: s.video.missing ? undefined : s.video.asset,
      url: s.video.publicUrl || undefined,
      license: s.video.license,
      contains_person: s.video.contains_person,
      consent: s.video.consent,
      trim: s.video.trim,
      duration: s.video.duration,
      max_height: s.video.maxHeight,
      crop: s.video.crop,
      size: s.video.size,
    });
  }
  let raw: Record<string, unknown> | null = null;
  if (s.raw) {
    try {
      raw = JSON.parse(s.raw);
    } catch {
      raw = null;
    }
  }
  return {
    engine: s.engine,
    mode,
    title: s.title || undefined,
    inputs,
    prompt: s.prompt,
    boxes: areaField(engine, mode) ? s.boxes : [],
    params: { ...defaults(engine), ...s.params },
    raw,
    variants: s.variants,
    forked_from: s.forked_from,
    chain: s.chain,
    tags: s.tags,
  };
}
