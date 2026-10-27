import * as Popover from "@radix-ui/react-popover";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type EngineInfo, type Mode, type ParamSpec } from "../lib/api";
import { randomSeed } from "../lib/format";
import { IconButton, Segmented, Select, Slider, TextInput, Toggle, cx } from "./ui";
import { I } from "./oi";

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
        <button type="button" aria-haspopup="listbox" aria-label={value ? `Engine: ${engine?.label ?? value}. Change engine` : "Choose an engine"} className="eng-pick">
          <span aria-hidden className={cx("eng-glyph", engine?.kind === "local" && "local")}>{engineGlyph(engine)}</span>
          <span className="eng-t">
            <b className={cx(!value && "none")}>{engine?.label ?? (value || "Choose an engine")}</b>
            <span className="mono">{!value ? "No template picked" : engine?.kind === "local" ? `${value.replace(/^local\//, "")} · your ComfyUI` : `${value} · Comfy Router`}</span>
          </span>
          <I n="down" size={14} className="chev" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={8} className="pop eng-pop">
          <p className="eyebrow eng-h"><i className="dot violet" aria-hidden />Cloud · Comfy Router</p>
          {cloud.length ? <EngineList list={cloud} value={value} pick={pick} /> : <p className="eng-none">No cloud {mode} templates yet.</p>}
          <div className="eng-sep">
            <p className="eyebrow eng-h"><i className="dot" aria-hidden />Local · your ComfyUI</p>
            {local.length ? <EngineList list={local} value={value} pick={pick} /> : <p className="eng-none">No local {mode} templates yet.</p>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EngineList({ list, value, pick }: { list: EngineInfo[]; value: string; pick: (id: string) => void }) {
  return (
    <ul role="listbox" className="eng-list">
      {list.map((e) => (
        <li key={e.id}>
          <button type="button" role="option" aria-selected={e.id === value} onClick={() => pick(e.id)} className="eng-opt">
            <span aria-hidden className={cx("eng-glyph sm", e.kind === "local" && "local")}>{engineGlyph(e)}</span>
            <span className="eng-t">
              <span className="eng-name"><b>{e.label}</b>{e.draft && <em className="tdraft" title="Not on Explore yet. Run it, then Publish the result you like.">Draft</em>}</span>
              <span className="eng-blurb">{e.blurb}</span>
            </span>
            {e.id === value && <I n="check" size={13} className="eng-on" />}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function ParamFields({ params, values, onChange, invalid }: { params: ParamSpec[]; values: Record<string, unknown>; onChange: (key: string, v: unknown) => void; invalid?: Set<string> }) {
  if (!params.length) return <p className="help">No settings for this template.</p>;
  return (
    <>
      {params.map((p) => {
        const v = values[p.key] ?? p.default;
        const bad = invalid?.has(p.key);
        const id = `param-${p.key}`;
        const lbl = <span className={cx("prm-l", bad && "bad")} title={p.help}>{p.label}</span>;
        const help = p.help && <span className="help">{p.help}</span>;
        // A slider only when the range is short enough to aim at; 1..10000 steps gets a number box.
        const slide = p.min !== undefined && p.max !== undefined && (p.max - p.min) / (p.step || 1) <= 1000;
        if ((p.type === "int" || p.type === "number") && slide) {
          const n = Number(v ?? p.min ?? 0);
          return (
            <div key={p.key} className="prm">
              <div className="prm-h"><label htmlFor={id}>{lbl}</label><span className="mono">{n}{p.unit ? ` ${p.unit}` : ""}</span></div>
              <Slider label={p.label} value={n} min={p.min ?? 0} max={p.max ?? 100} step={p.step ?? 1} onChange={(x) => onChange(p.key, x)} />
            </div>
          );
        }
        if (p.type === "segmented") {
          const opts = p.options ?? [];
          return (
            <div key={p.key} className="prm">
              <span>{lbl}</span>
              <Segmented label={p.label} value={String(v)} options={opts} onChange={(x) => onChange(p.key, x)} cols={Math.min(opts.length, opts.length > 5 ? 4 : 5)} />
            </div>
          );
        }
        if (p.type === "select") {
          return (
            <div key={p.key} className="prm">
              <label htmlFor={id}>{lbl}</label>
              <Select id={id} aria-invalid={bad || undefined} value={String(v ?? "")} onChange={(e) => onChange(p.key, e.target.value)} className="wide">
                {(p.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
            </div>
          );
        }
        if (p.type === "bool") {
          return (
            <div key={p.key} className="prm row">
              <label htmlFor={id}>{lbl}{help}</label>
              <Toggle id={id} label={p.label} checked={!!v} onChange={(x) => onChange(p.key, x)} />
            </div>
          );
        }
        if (p.type === "text") {
          return (
            <div key={p.key} className="prm">
              <label htmlFor={id}>{lbl}</label>
              <textarea id={id} className="textarea" aria-invalid={bad || undefined} rows={3} value={v == null ? "" : String(v)} placeholder={p.hint} onChange={(e) => onChange(p.key, e.target.value)} />
              {help}
            </div>
          );
        }
        if (p.type === "seed") {
          const n = Number(v ?? -1);
          return (
            <div key={p.key} className="prm seed">
              <label htmlFor={id}>{lbl}</label>
              <TextInput id={id} aria-invalid={bad || undefined} value={n < 0 ? "" : String(n)} placeholder="Random" inputMode="numeric" onChange={(e) => onChange(p.key, e.target.value === "" ? -1 : Number(e.target.value.replace(/\D/g, "")))} className="mono" />
              <IconButton label="Pick a random seed" tone="raised" onClick={() => onChange(p.key, randomSeed())}><I n="dice" size={15} /></IconButton>
            </div>
          );
        }
        const num = p.type === "number" || p.type === "int";
        return (
          <div key={p.key} className="prm">
            <label htmlFor={id}>{lbl}</label>
            <TextInput id={id} aria-invalid={bad || undefined} value={v == null ? "" : String(v)} placeholder={p.hint} inputMode={num ? "decimal" : undefined} onChange={(e) => onChange(p.key, num ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)} className={num ? "mono" : undefined} />
            {help}
          </div>
        );
      })}
    </>
  );
}
