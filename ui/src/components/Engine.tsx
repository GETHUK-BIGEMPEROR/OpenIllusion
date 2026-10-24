import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type EngineInfo, type Mode, type ParamSpec, type SizeSpec } from "../lib/api";
import { randomSeed } from "../lib/format";
import { aspectName, dimsText, plans, sizeNotes, type Crop } from "../lib/size";
import { Check, Chevron, Dice, Search } from "./Icons";
import { IconButton, Segmented, Select, Slider, TextInput, Toggle, cx } from "./ui";

export const engineGlyph = (e?: { id: string; label: string; provider?: string }) => {
  if (!e) return "?";
  // Template labels describe the task ("Add a hat"); the provider names the model family.
  return (e.provider || e.label).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
};

/** Curated engines for the mode plus every other Router model, by schema. */
export function useEngine(mode: Mode, id: string): EngineInfo | undefined {
  const { data: curated = [] } = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const found = curated.find((e) => e.id === id);
  const schema = useQuery({ queryKey: ["schema", id], queryFn: () => api.schema(id), enabled: !found && !!id, staleTime: 600_000, retry: false });
  return useMemo(() => {
    if (found) return found;
    if (!id) return undefined;
    const [provider, model] = id.split("/");
    const params = schema.data ? schemaParams(schema.data.schema) : [];
    const mods = schema.data?.input_modalities ?? [];
    return {
      id, mode, label: model ?? id, provider: provider ?? "", blurb: schema.isLoading ? "Reading the model's schema…" : schema.isError ? "Couldn't read this model's schema. Use the Raw tab." : "Form generated from the model's Router schema.",
      max_images: mods.includes("image") ? 10 : 0, min_images: 0, needs_video: false, video_window: null, fps_window: [1, 60], url_only: false, params, curated: false, kind: "cloud", source: null,
    } satisfies EngineInfo;
  }, [found, id, mode, schema.data, schema.isLoading, schema.isError]);
}

const SKIP = new Set(["prompt", "content", "images", "image", "image_url", "image_urls", "video", "video_url", "audio_url", "callback_url", "webhook_url", "model", "mask", "input_image"]);

/** Router JSON schema → form fields: enum → segmented, int range → slider, bool → switch, string → text. */
export function schemaParams(schema: any): ParamSpec[] {
  const props = schema?.properties ?? {};
  const out: ParamSpec[] = [];
  for (const [key, raw] of Object.entries<any>(props)) {
    if (SKIP.has(key) || key.endsWith("_url") || key.endsWith("_urls")) continue;
    const s = raw.anyOf ? raw.anyOf.find((x: any) => x.type && x.type !== "null") ?? raw : raw;
    const label = key.replace(/_/g, " ").replace(/^\w/, (c: string) => c.toUpperCase());
    const help = typeof raw.description === "string" ? raw.description.split(". ")[0] : undefined;
    const def = raw.default ?? s.default;
    if (Array.isArray(s.enum)) {
      const opts = [...new Set((s.enum as unknown[]).map(String))].filter((o, _i, arr) => !(o === o.toLowerCase() && arr.includes(o.toUpperCase()) && o !== o.toUpperCase()));
      out.push({ key, label, type: opts.length <= 5 ? "segmented" : "select", options: opts, default: def ?? opts[0], help });
    } else if (s.type === "boolean") {
      out.push({ key, label, type: "bool", default: def ?? false, help });
    } else if ((s.type === "integer" || s.type === "number") && key === "seed") {
      out.push({ key, label, type: "seed", default: -1, help });
    } else if ((s.type === "integer" || s.type === "number") && s.minimum !== undefined && s.maximum !== undefined && s.maximum - s.minimum <= 1000) {
      out.push({ key, label, type: "int", min: s.minimum, max: s.maximum, step: s.type === "integer" ? 1 : (s.maximum - s.minimum) / 100, default: def ?? s.minimum, help });
    } else if (s.type === "integer" || s.type === "number") {
      out.push({ key, label, type: "number", default: def, help });
    } else if (s.type === "string") {
      out.push({ key, label, type: "string", default: def, help });
    }
  }
  return out;
}

export function EngineDropdown({ mode, value, onChange }: { mode: Mode; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: curated = [] } = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog, enabled: open, staleTime: 600_000, retry: false });
  const engine = useEngine(mode, value);
  const cloud = curated.filter((e) => e.mode === mode && e.kind !== "local");
  const local = curated.filter((e) => e.mode === mode && e.kind === "local");
  const others = (catalog.data ?? [])
    .filter((m) => !curated.some((c) => c.id === m.id))
    .filter((m) => !q || m.id.toLowerCase().includes(q.toLowerCase()))
    .slice(0, 80);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-haspopup="listbox" aria-label={value ? `Engine: ${engine?.label ?? value}. Change engine` : "Choose an engine"} className="mk-btn group text-left h-12 pl-2 pr-2.5 rounded-lg border border-line bg-bg hover:border-line2 flex items-center gap-2.5 w-full data-[state=open]:border-violet/60">
          <span aria-hidden className={cx("w-8 h-8 shrink-0 rounded-md flex items-center justify-center font-display font-semibold text-[11px]", engine?.kind === "local" ? "bg-yellow/10 text-yellow-light" : "bg-violet/15 text-violet-lighter")}>{engineGlyph(engine)}</span>
          <span className="flex-1 min-w-0 flex flex-col">
            <span className={cx("font-semibold text-base leading-[18px] truncate", !value && "text-muted font-medium")}>{engine?.label ?? (value || "Choose an engine")}</span>
            <span className="font-mono text-xs2 text-faint truncate">{!value ? "No template picked" : engine?.kind === "local" ? `${value.replace(/^local\//, "")} · your ComfyUI` : `${value} · Comfy Router`}</span>
          </span>
          <Chevron size={14} className="text-muted transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8} className="z-50 w-[var(--radix-popover-trigger-width)] min-w-[300px] max-h-[min(560px,70vh)] overflow-y-auto scroll-y rounded-xl bg-surface p-1 shadow-float animate-pop">
          <p className="m-0 px-2 pt-2 pb-1 eyebrow flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-violet" aria-hidden />Cloud · Comfy Router</p>
          {cloud.length ? <EngineList list={cloud} value={value} pick={pick} /> : <p className="m-0 px-2 py-2 text-sm text-muted">No cloud {mode} templates yet.</p>}
          <div className="mt-1 pt-1 border-t border-line">
            <p className="m-0 px-2 pt-2 pb-1 eyebrow flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-yellow" aria-hidden />Local · your ComfyUI</p>
            {local.length ? <EngineList list={local} value={value} pick={pick} /> : <p className="m-0 px-2 py-2 text-sm text-muted">No local {mode} templates yet.</p>}
          </div>
          <div className="mt-1 pt-1 border-t border-line">
            <p className="m-0 px-2 pt-2 pb-1.5 eyebrow">Any Router model</p>
            <label className="field flex items-center gap-2 h-8 mx-1 px-2.5 text-muted">
              <Search size={13} />
              <span className="sr-only">Find a model</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="provider/model" className="flex-1 min-w-0 bg-transparent border-0 outline-none text-sm text-text" />
            </label>
            <ul className="m-0 p-0 list-none mt-1">
              {catalog.isLoading && <li className="px-2 py-2 text-sm text-muted">Reading Router's catalog…</li>}
              {catalog.isError && <li className="px-2 py-2 text-sm text-muted">Catalog unavailable. Check your key in Settings.</li>}
              {others.map((m) => (
                <li key={m.id}>
                  <button type="button" onClick={() => pick(m.id)} className="mk-btn w-full text-left h-7 px-2 rounded-md border-0 bg-transparent hover:bg-raised font-mono text-xs text-soft truncate">{m.id}</button>
                </li>
              ))}
              {q && !catalog.isLoading && !others.length && (
                <li><button type="button" onClick={() => pick(q.trim())} className="mk-btn w-full text-left h-7 px-2 rounded-md border-0 bg-transparent hover:bg-raised text-sm">Use <span className="font-mono">{q.trim()}</span></button></li>
              )}
            </ul>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EngineList({ list, value, pick }: { list: EngineInfo[]; value: string; pick: (id: string) => void }) {
  return (
    <ul role="listbox" className="m-0 p-0 list-none flex flex-col gap-px">
      {list.map((e) => (
        <li key={e.id}>
          <button type="button" role="option" aria-selected={e.id === value} onClick={() => pick(e.id)} className={cx("mk-btn w-full text-left flex items-start gap-2.5 p-2 rounded-lg border-0", e.id === value ? "bg-active" : "bg-transparent hover:bg-raised")}>
            <span aria-hidden className={cx("w-7 h-7 shrink-0 rounded-md flex items-center justify-center font-display font-semibold text-[10px]", e.kind === "local" ? "bg-yellow/10 text-yellow-light" : "bg-violet/15 text-violet-lighter")}>{engineGlyph(e)}</span>
            <span className="flex-1 min-w-0">
              <span className="flex items-center gap-1.5">
                <span className="font-semibold text-sm truncate">{e.label}</span>
              </span>
              <span className="block text-xs text-muted line-clamp-2">{e.blurb}</span>
            </span>
            {e.id === value && <Check size={13} className="shrink-0 mt-1 text-violet-light" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Output size in the picture's own pixels, one option per size the template offers, plus notes on upscaling, shape and memory. */
export function SizeField({ size, value, images, onChange }: {
  size: SizeSpec; value: unknown; images: { slot: string; width: number; height: number; crop?: Crop }[]; onChange: (v: string) => void;
}) {
  const current = size.options.some((o) => o.label === value) ? String(value) : size.default;
  const lead = images.some((i) => i.slot === size.follows);
  const at = (label: string) => (lead ? plans(size, label, images)[size.follows] : null);
  const out = at(current);
  const n = size.follows.split(":")[1];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-sm font-medium text-soft" title={`Images are cropped and sized by OpenIllusion before the run. The output follows image ${n}.`}>Size</span>
        {out && <span className="font-mono text-xs tabular text-text">{dimsText(out)} · {aspectName(out)}</span>}
      </div>
      <div role="radiogroup" aria-label="Size" className="grid p-0.5 bg-bg border border-line rounded-lg gap-0.5" style={{ gridTemplateColumns: `repeat(${Math.min(size.options.length, 4)}, minmax(0, 1fr))` }}>
        {size.options.map((o) => {
          const d = at(o.label);
          const on = o.label === current;
          return (
            <button key={o.label} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.label)}
              aria-label={`${o.label}${d ? `, ${d.width} by ${d.height}` : ""}`}
              className={cx("mk-btn border-0 rounded-md px-1 py-1 flex flex-col items-center gap-px min-w-0",
                on ? "bg-active text-text shadow-seg" : "bg-transparent text-muted hover:text-text")}>
              <span className={cx("text-sm leading-[18px]", on && "font-medium")}>{o.label}</span>
              <span className={cx("font-mono text-[10px] leading-3 tabular truncate max-w-full", on ? "text-soft" : "text-faint")}>{d ? dimsText(d) : o.px > 0 ? `~${o.px}²` : "as is"}</span>
            </button>
          );
        })}
      </div>
      {out ? sizeNotes(out).map((t) => <span key={t} className="text-xs text-orange-text leading-[1.45]">{t}</span>)
        : <span className="text-xs text-faint">Sizes follow image {n}'s shape. Add it to see them in pixels.</span>}
    </div>
  );
}

export function ParamFields({ params, values, onChange, invalid }: { params: ParamSpec[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; invalid?: Set<string> }) {
  if (!params.length) return <p className="m-0 text-sm text-muted">No settings for this engine. Anything else goes in the raw request.</p>;
  return (
    <>
      {params.map((p) => {
        const v = values[p.key] ?? p.default;
        const bad = invalid?.has(p.key);
        const id = `param-${p.key}`;
        const lbl = <span className={cx("text-sm font-medium", bad ? "text-rose-text" : "text-soft")} title={p.help}>{p.label}</span>;
        if (p.type === "int" || p.type === "number" && p.min !== undefined) {
          const n = Number(v ?? p.min ?? 0);
          return (
            <div key={p.key} className="flex flex-col gap-1.5">
              <div className="flex justify-between items-baseline"><label htmlFor={id}>{lbl}</label><span className="font-mono text-xs tabular text-text">{n}{p.unit ? ` ${p.unit}` : ""}</span></div>
              <Slider label={p.label} value={n} min={p.min ?? 0} max={p.max ?? 100} step={p.step ?? 1} onChange={(x) => onChange(p.key, x)} />
            </div>
          );
        }
        if (p.type === "segmented") {
          const opts = p.options ?? [];
          return (
            <div key={p.key} className="flex flex-col gap-1.5">
              <span>{lbl}</span>
              <Segmented label={p.label} value={String(v)} options={opts} onChange={(x) => onChange(p.key, x)} cols={Math.min(opts.length, opts.length > 5 ? 4 : 5)} />
            </div>
          );
        }
        if (p.type === "select") {
          return (
            <div key={p.key} className="flex flex-col gap-1.5">
              <label htmlFor={id}>{lbl}</label>
              <Select id={id} aria-invalid={bad || undefined} value={String(v ?? "")} onChange={(e) => onChange(p.key, e.target.value)} className="w-full">
                {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            </div>
          );
        }
        if (p.type === "bool") {
          return (
            <div key={p.key} className="flex justify-between items-center gap-3">
              <label htmlFor={id} className="min-w-0">{lbl}{p.help && <span className="block text-xs text-muted">{p.help}</span>}</label>
              <Toggle id={id} label={p.label} checked={!!v} onChange={(x) => onChange(p.key, x)} />
            </div>
          );
        }
        if (p.type === "seed") {
          const n = Number(v ?? -1);
          return (
            <div key={p.key} className="flex items-center gap-2">
              <label htmlFor={id} className="shrink-0 w-14">{lbl}</label>
              <TextInput id={id} aria-invalid={bad || undefined} value={n < 0 ? "" : String(n)} placeholder="Random" inputMode="numeric" onChange={(e) => onChange(p.key, e.target.value === "" ? -1 : Number(e.target.value.replace(/\D/g, "")))} className="flex-1 h-8 font-mono text-right text-sm" />
              <IconButton label="Pick a random seed" tone="secondary" onClick={() => onChange(p.key, randomSeed())}><Dice size={15} /></IconButton>
            </div>
          );
        }
        return (
          <div key={p.key} className="flex flex-col gap-1.5">
            <label htmlFor={id}>{lbl}</label>
            <TextInput id={id} aria-invalid={bad || undefined} value={v == null ? "" : String(v)} onChange={(e) => onChange(p.key, p.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)} className={cx("h-8 text-sm", p.type === "number" && "font-mono")} />
            {p.help && <span className="text-xs text-muted">{p.help}</span>}
          </div>
        );
      })}
    </>
  );
}
