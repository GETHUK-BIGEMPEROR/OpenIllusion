import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type EngineInfo, type Mode, type ParamSpec } from "../lib/api";
import { randomSeed } from "../lib/format";
import { Check, Chevron, Dice } from "./Icons";
import { IconButton, Segmented, Select, Slider, TextInput, Toggle, cx } from "./ui";

export const engineGlyph = (e?: { id: string; label: string; provider?: string }) => {
  if (!e) return "?";
  // Template labels describe the task ("Add a hat"); the provider names the model family.
  return (e.provider || e.label).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
};

/** The template with this id, once the list has loaded. */
export function useEngine(_mode: Mode, id: string): EngineInfo | undefined {
  const { data: curated = [] } = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  return curated.find((e) => e.id === id);
}

export function EngineDropdown({ mode, value, onChange }: { mode: Mode; value: string; onChange: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data: curated = [] } = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const engine = useEngine(mode, value);
  const cloud = curated.filter((e) => e.mode === mode && e.kind !== "local");
  const local = curated.filter((e) => e.mode === mode && e.kind === "local");

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
                {e.draft && <span className="shrink-0 px-1.5 h-[17px] leading-[17px] rounded text-[10px] font-semibold uppercase tracking-wide bg-yellow/10 text-yellow-light" title="Not on Explore yet. Run it, then Publish the result you like.">Draft</span>}
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

export function ParamFields({ params, values, onChange, invalid }: { params: ParamSpec[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; invalid?: Set<string> }) {
  if (!params.length) return <p className="m-0 text-sm text-muted">No settings for this template.</p>;
  return (
    <>
      {params.map((p) => {
        const v = values[p.key] ?? p.default;
        const bad = invalid?.has(p.key);
        const id = `param-${p.key}`;
        const lbl = <span className={cx("text-sm font-medium", bad ? "text-rose-text" : "text-soft")} title={p.help}>{p.label}</span>;
        // A slider only when the range is short enough to aim at; 1..10000 steps gets a number box.
        const slide = p.min !== undefined && p.max !== undefined && (p.max - p.min) / (p.step || 1) <= 1000;
        if ((p.type === "int" || p.type === "number") && slide) {
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
        if (p.type === "text") {
          return (
            <div key={p.key} className="flex flex-col gap-1.5">
              <label htmlFor={id}>{lbl}</label>
              <textarea id={id} className="textarea" aria-invalid={bad || undefined} rows={3} value={v == null ? "" : String(v)} placeholder={p.hint} onChange={(e) => onChange(p.key, e.target.value)} />
              {p.help && <span className="text-xs text-muted">{p.help}</span>}
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
            <TextInput id={id} aria-invalid={bad || undefined} value={v == null ? "" : String(v)} placeholder={p.hint} inputMode={p.type === "number" || p.type === "int" ? "decimal" : undefined} onChange={(e) => onChange(p.key, p.type === "number" || p.type === "int" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)} className={cx("h-8 text-sm", (p.type === "number" || p.type === "int") && "font-mono")} />
            {p.help && <span className="text-xs text-muted">{p.help}</span>}
          </div>
        );
      })}
    </>
  );
}
