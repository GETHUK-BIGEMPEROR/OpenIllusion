// Step 2: what people choose about the result. Local: the output size and the workflow values shown on Create.
// Router: the model's own options (shape, size, resolution, length, sound) for the job the samples fill.
import { useState } from "react";
import { I } from "../../components/oi";
import { cx } from "../../components/ui";
import { OutputSize, ParamFields } from "../../components/Engine";
import type { AdapterSetting, ParamSpec, SizeSpec, WorkflowAnalysis } from "../../lib/api";
import { human, type OutputState, type ParamRow } from "./model";
import { settingValue } from "./modes";
import { Sec } from "./Sections";

/** A size block for the shape and step pickers: the steps as labels, each about px x px pixels. */
const sizeSpec = (aspects: string[], steps: string[], aspect: string, step: string, extra?: Partial<NonNullable<SizeSpec["canvas"]>>): SizeSpec => ({
  options: steps.map((l) => ({ label: l, px: Math.round(Math.sqrt(parseFloat(l) * 1e6)) })),
  multiple: 16, inputs: {}, original: "", cap: 0,
  canvas: { aspects, aspect, size: step, ...extra },
});

/** Whether people pick a value on Create or every run uses the one set here. */
function AskLock({ asked, name, onChange }: { asked: boolean; name: string; onChange: (asked: boolean) => void }) {
  return (
    <div className="asklock" role="group" aria-label={`${name} on Create`}>
      <button type="button" aria-pressed={asked} onClick={() => onChange(true)}>Ask on Create</button>
      <button type="button" aria-pressed={!asked} onClick={() => onChange(false)}><I n="lock" />Lock</button>
    </div>
  );
}

const ratio = (a: string) => { const [p, q] = a.split(":").map(Number); return p / q; };

/** Local: where the output's width and height go, and the shape and step a run opens at. People pick both on Create. */
export function SizeSection({ a, mode, o, setO }: { a: WorkflowAnalysis; mode: "edit" | "motion"; o: OutputState; setO: (f: (o: OutputState) => OutputState) => void }) {
  if (!a.sizes.length) return null;
  const steps = a.canvas.steps[mode];
  // Opens at the shape and step nearest what the workflow had.
  const near = (w: number, h: number) => ({
    aspect: a.canvas.aspects.reduce((b, x) => (Math.abs(Math.log(ratio(x) / (w / h))) < Math.abs(Math.log(ratio(b) / (w / h))) ? x : b)),
    default: steps.reduce((b, x) => (Math.abs(parseFloat(x) * 1e6 - w * h) < Math.abs(parseFloat(b) * 1e6 - w * h) ? x : b)),
  });
  const node = a.sizes.find((x) => x.node === o.size);
  const start = node ? { ...near(node.width, node.height), ...Object.fromEntries(Object.entries(o.keep ?? {}).filter(([, v]) => v)) } : null;
  const pick = (id: string) => setO((x) => {
    const n = a.sizes.find((v) => v.node === id);
    return { ...x, size: id, keep: n ? { ...x.keep, ...near(n.width, n.height) } : x.keep };
  });
  return (
    <Sec id="sz" title="Output size"
      desc="Lets people pick the result's shape and size on Create. Leave it to the workflow when an input photo or clip sets the size.">
      <div className="bchoice" role="radiogroup" aria-label="Output size goes to">
        {a.sizes.map((x) => (
          <button key={x.node} type="button" role="radio" aria-checked={o.size === x.node} onClick={() => pick(x.node)}>
            <span className="nd">#{x.node}</span><span className="tx">{x.title}</span><span className="mono">{x.width}×{x.height}</span>
          </button>
        ))}
        <button type="button" role="radio" aria-checked={!o.size} onClick={() => setO((x) => ({ ...x, size: "" }))}>
          <span className="tx">The workflow sets it. Nothing to pick on Create.</span>
        </button>
      </div>
      {start && (
        <div className="bset-body">
          <OutputSize size={sizeSpec(a.canvas.aspects, steps, start.aspect, start.default)} aspect={start.aspect} step={start.default}
            onChange={(k, v) => setO((x) => ({ ...x, keep: { ...start, ...x.keep, [k === "aspect" ? "aspect" : "default"]: v } }))} />
          <p className="help">Where it opens. People change both on Create.</p>
        </div>
      )}
    </Sec>
  );
}

const PARAM_TYPE: Record<ParamRow["type"], ParamSpec["type"]> = { int: "int", number: "number", bool: "bool", seed: "seed", select: "select", segmented: "segmented", string: "string" };

/** Local: the workflow's values people can change on Create (length, steps, seed…). Off, a value runs as set here. */
export function ControlsSection({ rows, setRows, owned }: { rows: ParamRow[]; setRows: (f: (r: ParamRow[]) => ParamRow[]) => void; owned: (r: ParamRow) => boolean }) {
  const [all, setAll] = useState(false);
  const list = rows.filter((r) => !owned(r));
  if (!list.length) return null;
  // The likely ones first (seed, steps, length…); the rest behind "Show all".
  const sorted = [...list].sort((x, y) => Number(y.on || y.suggested) - Number(x.on || x.suggested));
  const shown = all ? sorted : sorted.filter((r) => r.on || r.suggested);
  const set = (id: string, ch: Partial<ParamRow>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...ch } : r)));
  const on = list.filter((r) => r.on).length;
  return (
    <Sec id="ct" title="Settings"
      desc="Values people can change on Create, like length, steps or seed. Locked ones run as set here. Name an asked one the way Create should say it."
      aside={<span className="mono">{on ? `${on} asked on Create` : "None asked on Create"}</span>}>
      {!!shown.length && <div className="bsets">
        {shown.map((r) => (
          <div key={r.id} className={cx("bset", r.on && "on")}>
            <div className="bset-h">
              <div className="bset-name">
                {r.on
                  ? <input className="input sm" aria-label="Its name on Create" value={r.label} maxLength={40} onChange={(e) => set(r.id, { label: e.target.value })} />
                  : <b>{r.label || human(r.name)}</b>}
                <span className="nd mono">{r.group}</span>
              </div>
              <AskLock asked={r.on} name={r.label || human(r.name)} onChange={(v) => set(r.id, { on: v })} />
            </div>
            <div className="bset-body">
              <ParamFields params={[{ key: r.id, label: r.on ? "Starts at" : "Runs at", type: PARAM_TYPE[r.type], min: r.min ?? undefined, max: r.max ?? undefined, step: r.step ?? undefined, options: r.options, unit: r.unit, help: r.help ?? undefined }]}
                values={{ [r.id]: r.value }} onChange={(_, v) => set(r.id, { value: v })} />
            </div>
          </div>
        ))}
      </div>}
      {(all || sorted.length > shown.length) && (
        <button className="btn sm ghost bset-more" type="button" onClick={() => setAll((x) => !x)}>
          <I n="down" className={cx(all && "flip")} />{all ? "Show fewer" : `Show all ${list.length}`}
        </button>
      )}
    </Sec>
  );
}

export type CloudSettingState = Record<string, { value?: unknown; locked?: boolean }>;
type SizeValue = { aspect: string; size: string };

/** Router: the model's options for the result this job asks for. Each starts at a value; one left on is asked on Create. */
export function CloudSettings({ list, st, setSt }: { list: AdapterSetting[]; st: CloudSettingState; setSt: (f: (s: CloudSettingState) => CloudSettingState) => void }) {
  if (!list.length) return null;
  const set = (key: string, ch: { value?: unknown; locked?: boolean }) => setSt((s) => ({ ...s, [key]: { ...s[key], ...ch } }));
  return (
    <Sec id="cs" title="Settings"
      desc="The model's options for the result. Ask: people pick it on Create, starting at your value. Lock: every run uses your value.">
      <div className="bsets">
        {list.map((s) => {
          const v = settingValue(s, st[s.key]?.value);
          const open = !st[s.key]?.locked;
          return (
            <div key={s.key} className={cx("bset", open && "on")}>
              <div className="bset-h">
                <div className="bset-name"><b>{s.label}</b><span className="nd">{open ? "People pick it on Create" : "Every run uses this"}</span></div>
                <AskLock asked={open} name={s.label} onChange={(x) => set(s.key, { locked: !x })} />
              </div>
              <div className="bset-body">
                {s.type === "size" ? (
                  <OutputSize size={sizeSpec(s.aspects ?? [], (s.steps ?? []).map((x) => `${x} MP`), (v as SizeValue).aspect, (v as SizeValue).size,
                    { steps: s.steps, multiple: s.multiple, sides: s.sides, pixels: s.pixels })}
                    aspect={(v as SizeValue).aspect} step={(v as SizeValue).size}
                    onChange={(k, x) => set(s.key, { value: { ...(v as SizeValue), [k === "aspect" ? "aspect" : "size"]: x } })} />
                ) : (
                  <ParamFields params={[{ ...s, type: s.type, label: open ? "Starts at" : "Every run uses" } as ParamSpec]} values={{ [s.key]: v }} onChange={(_, x) => set(s.key, { value: x })} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </Sec>
  );
}
