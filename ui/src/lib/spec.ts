import type { EngineInfo, Mode, Spec, SpecInput } from "./api";
import { slotOf, type StudioState } from "./store";

export function defaults(engine?: EngineInfo): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of engine?.params ?? []) if (p.default !== undefined) out[p.key] = p.default;
  if (engine?.size) out.size = engine.size.default;
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
    });
  });
  const takesVideo = !(engine?.kind === "local" && !engine.needs_video);
  if (mode === "motion" && s.video && takesVideo) {
    inputs.push({
      slot: "video:1",
      role: "motion",
      asset: s.video.missing ? undefined : s.video.asset,
      url: s.video.publicUrl || undefined,
      license: s.video.license,
      contains_person: s.video.contains_person,
      consent: s.video.consent,
      trim: s.video.trim,
      duration: s.video.duration,
      max_height: s.video.maxHeight,
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
    boxes: mode === "edit" ? s.boxes : [],
    params: { ...defaults(engine), ...s.params },
    raw,
    variants: mode === "edit" ? s.variants : 1,
    forked_from: s.forked_from,
    chain: s.chain,
    tags: s.tags,
  };
}

/** Insert text at the caret of a textarea, returning the new value. */
export function insertAt(el: HTMLTextAreaElement | null, value: string, text: string): [string, number] {
  if (!el) return [value ? `${value.trimEnd()} ${text}` : text, 0];
  const a = el.selectionStart ?? value.length;
  const b = el.selectionEnd ?? value.length;
  const before = value.slice(0, a);
  const pad = before && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
  const next = before + pad + text + value.slice(b);
  return [next, a + pad.length + text.length];
}
