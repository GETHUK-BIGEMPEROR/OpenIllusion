// Step 2: the template's sections (source, inputs, prompt, result, title).
import { useState, type CSSProperties, type ReactNode } from "react";
import { I } from "../../components/oi";
import type { IconName } from "../../components/sprite";
import { isImage, isVideo, useFileDrop } from "../../components/Drop";
import { useUploader } from "../../components/Refs";
import { cx, Spinner } from "../../components/ui";
import type { MediaKind, WorkflowAnalysis } from "../../lib/api";
import { useApp } from "../../lib/store";
import { type Details, human, KIND_ICON, KIND_NOUN, type MediaRow, type OutputState, type PromptState, type Source } from "./model";
import { modeOf, routerModes, runMode, toMode } from "./modes";

function Sec({ id, icon, color, title, desc, aside, children }: { id: string; icon: IconName; color?: string; title: string; desc: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="bsec" aria-labelledby={`bld-${id}`} style={color ? ({ "--c": color } as CSSProperties) : undefined}>
      <div className="bsec-h">
        <span className="ic"><I n={icon} /></span>
        <div><h3 id={`bld-${id}`}>{title}</h3><p>{desc}</p></div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function SourceBar({ src }: { src: Source }) {
  const [open, setOpen] = useState(false);
  if (src.kind === "cloud") {
    return (
      <div className="bld-source">
        <span className="bc-ic cloud"><I n="cloud" /></span>
        <div><b>{src.a.name}</b><span className="mono">{src.a.model} · Comfy Router · makes {src.a.mode === "motion" ? "video" : "photos"}</span></div>
      </div>
    );
  }
  const a = src.a;
  const c = a.check;
  const loaders = new Set(a.media.map((m) => m.node));
  const bad = c.bad_values.filter((b) => !loaders.has(b.node_id));
  const missing = c.missing_nodes.length + c.missing_models.length;
  return (
    <div className="bld-source-wrap">
      <div className="bld-source">
        <span className="bc-ic local"><I n="graph" /></span>
        <div>
          <b className="mono">{a.source}</b>
          <span>{a.nodes} nodes · {a.preset ? "from the template, set up as it is" : a.format === "ui" ? "converted from the saved workflow" : "API format"}</span>
        </div>
        {missing ? <span className="pill rose"><I n="alert" />{missing} missing</span> : <span className="pill"><i className="dot" />Ready to run</span>}
      </div>
      {(missing > 0 || bad.length > 0 || a.notes.length > 0) && (
        <div className={cx("bld-check", missing > 0 && "warn")}>
          {missing > 0 && <p><b>Your ComfyUI is missing things this workflow uses.</b> The template saves anyway; runs fail until they're installed.</p>}
          <button type="button" className="bld-fold" aria-expanded={open} onClick={() => setOpen(!open)}><I n={open ? "down" : "right"} />{open ? "Hide details" : "Show details"}</button>
          {open && (
            <ul>
              {c.missing_nodes.map((m) => <li key={m.class_type}><span className="tag">Node</span><code>{m.class_type}</code></li>)}
              {c.missing_models.map((m) => <li key={m.node_id + m.input}><span className="tag">Model</span><code>{m.value}</code></li>)}
              {bad.map((b) => <li key={b.node_id + b.input}><span className="tag">Value</span><code>{b.class_type}.{b.input} = {String(b.value)}</code></li>)}
              {a.notes.map((n) => <li key={n}><span className="tag">Note</span>{n}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** "Image 1", "Video 1": an input is named by its place among its kind, the same way Create shows it. */
export const slotNames = (rows: { kind: MediaKind }[]) => {
  const n: Record<string, number> = {};
  return rows.map((r) => `${KIND_NOUN[r.kind]} ${(n[r.kind] = (n[r.kind] ?? 0) + 1)}`);
};

export function InputsSection({ src, rows, setRows }: { src: Source; rows: MediaRow[]; setRows: (f: (r: MediaRow[]) => MediaRow[]) => void }) {
  const { upload, busy } = useUploader();
  const up = (key: string, p: Partial<MediaRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const pickSample = async (r: MediaRow, f?: File) => {
    if (!f) return;
    const [a] = await upload([f], r.kind);
    if (a) up(r.key, { sample: a, own: true });
  };
  // A Router input that takes several files gets one row each.
  const group = (r: MediaRow) => (r.slot !== undefined ? `in${r.slot}` : r.key);
  const addSlot = (r0: MediaRow) => setRows((rs) => {
    const same = rs.filter((r) => group(r) === group(r0));
    const last = same[same.length - 1];
    const row: MediaRow = { ...last, key: `${last.slot}:${same.length}`, sample: null, own: false };
    const at = rs.indexOf(last) + 1;
    return [...rs.slice(0, at), row, ...rs.slice(at)];
  });
  const cloud = src.kind === "cloud";
  const shown = rows.filter((r) => r.on);
  // "Image 1", "Image 2": a Router template's inputs are the filled rows, in order.
  const filled = slotNames(shown.filter((r) => !cloud || r.sample));
  let k = 0;
  const names = shown.map((r) => (!cloud || r.sample ? filled[k++] : r.label));
  const modes = cloud ? routerModes(src.a) : [];
  const mode = modeOf(modes, rows);
  return (
    <Sec id="in" icon="upload" color="var(--mint)" title="Inputs"
      desc={cloud
        ? `${modes.length ? `Pick what this template does, then fill` : "Fill"} the inputs it uses: it asks for exactly those, and empty ones aren't in it.`
        : "Found in the workflow. Drop a sample into each: the first run uses it, and it ships as the template's default."}
      aside={cloud ? (modes.length ? undefined : <span className="mono">{runMode(src.a, shown)}</span>) : shown.length ? <span className="mono">{shown.length}</span> : undefined}>
      {modes.length > 0 && (
        <div className="seg bld-modes" role="radiogroup" aria-label="What this template does">
          {modes.map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode?.id === m.id} aria-pressed={mode?.id === m.id}
              onClick={() => setRows((rs) => toMode(m, rs))}>{m.label}</button>
          ))}
        </div>
      )}
      {!shown.length ? (
        <p className="help">{src.kind === "local" ? "No photo or video loaders in this workflow. People only write the prompt."
          : modes.length ? "No files: people only write the prompt." : "This model takes no media. People only write the prompt."}</p>
      ) : (
        <div className="bslots">
          {shown.map((r, i) => {
            const lastOfField = (r.max ?? 1) > 1 && shown.filter((x) => group(x) === group(r)).slice(-1)[0]?.key === r.key;
            const count = shown.filter((x) => group(x) === group(r)).length;
            const noun = r.kind === "video" ? "clip" : r.kind === "audio" ? "sound" : "photo";
            return (
              <div key={r.key} className={cx("bslot", r.sample && "has")} style={{ "--i": i } as CSSProperties}>
                <SlotDrop r={r} name={names[i]} busy={busy > 0} onFile={(f) => void pickSample(r, f)} />
                <div className="bmeta">
                  <div className="bmeta-top"><b>{names[i]}</b>{(!cloud || r.sample) && <span className="nd" title={r.where}>{r.where}</span>}</div>
                  <div className="bsub">
                    {r.sample ? <><span className={r.own ? "tag-own" : "tag-sample"}>{r.own ? "YOURS" : "SAMPLE"}</span><span className="mono" title={r.sample.name}>{r.sample.width && r.sample.height ? `${r.sample.width}×${r.sample.height}` : r.sample.name}</span>
                      <button className="bld-x" type="button" onClick={() => up(r.key, { sample: null, own: false })}>Remove</button></>
                      : <span className={r.required ? "need" : undefined}>{r.required ? `Needs a sample ${noun}` : cloud ? "Empty: not in the template" : "Optional"}</span>}
                  </div>
                  {lastOfField && count < (r.max ?? 1) && <div className="bmeta-foot"><button className="btn sm ghost" type="button" onClick={() => addSlot(r)}><I n="plus" />Another {noun}</button></div>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Sec>
  );
}

export function PromptSection({ src, p, setP }: { src: Source; p: PromptState; setP: (f: (p: PromptState) => PromptState) => void }) {
  const set = (k: keyof PromptState) => (e: { target: { value: string } }) => setP((x) => ({ ...x, [k]: e.target.value }));
  const options = src.kind === "local"
    ? src.a.texts.map((t) => ({ id: `${t.node}|${t.input}`, node: t.node, label: `${t.title} · ${human(t.input)}`, tag: t.polarity === "negative" ? "Negative" : t.polarity === "positive" ? "Positive" : null, value: t.value }))
    : [{ id: "prompt", node: "", label: "Prompt", tag: null, value: "" }];
  const choose = (id: string) => setP((x) => {
    const o = options.find((v) => v.id === id);
    return { ...x, pick: id, def: o && (!x.def || options.some((v) => v.value === x.def)) ? o.value : x.def };
  });
  const unsure = src.kind === "local" && !p.pick && !src.a.prompt && src.a.texts.filter((t) => t.polarity !== "negative").length > 1;
  return (
    <Sec id="pr" icon="pencil" color="var(--violet)" title="Prompt" desc="What the template opens with. People can change any word on Create; it's sent exactly as written.">
      {!options.length ? (
        <p className="help">No text box in this workflow takes a prompt. The template runs on its inputs alone.</p>
      ) : (
        <>
          {unsure && <p className="bwarn"><I n="alert" />{src.a.texts.length} text boxes could be the prompt, so none is picked. Pick the one people write in.</p>}
          {(options.length > 1 || !p.pick) && <div className="bchoice" role="radiogroup" aria-label="Prompt goes into">
            {options.map((o) => (
              <button key={o.id} type="button" role="radio" aria-checked={p.pick === o.id} onClick={() => choose(o.id)} title={o.label}>
                {o.node && <span className="nd">#{o.node}</span>}
                <span className="tx">{o.value || o.label}</span>
                {o.tag && <span className="tag">{o.tag}</span>}
              </button>
            ))}
            <button type="button" role="radio" aria-checked={!p.pick} onClick={() => setP((x) => ({ ...x, pick: "" }))}><span className="tx">No prompt. The text stays as saved.</span></button>
          </div>}
          {p.pick && (
            <textarea className="textarea bprompt" aria-label="The prompt the template opens with" rows={Math.min(10, Math.max(3, Math.ceil(p.def.length / 70)))} value={p.def} maxLength={4000} onChange={set("def")} placeholder="The prompt the template starts with" spellCheck={false} />
          )}
        </>
      )}
    </Sec>
  );
}

/** Local: the save node a run keeps. Only asked when the workflow has more than one, or none. */
export function ResultSection({ a, o, setO }: { a: WorkflowAnalysis; o: OutputState; setO: (f: (o: OutputState) => OutputState) => void }) {
  const pick = (id: string) => setO((x) => ({ ...x, result: id }));
  return (
    <Sec id="rs" icon="check" color="var(--yellow)" title="The result" desc="This workflow saves more than one thing. Pick the one a run keeps.">
      {!a.results.length ? (
        <p className="bwarn err"><I n="alert" />No save node. Add Save Image or Save Video in ComfyUI, then drop the workflow again.</p>
      ) : (
        <>
          <div className="bchoice" role="radiogroup" aria-label="Result node">
            {a.results.map((r) => (
              <button key={r.node} type="button" role="radio" aria-checked={o.result === r.node} onClick={() => pick(r.node)}>
                <span className="nd">#{r.node}</span><span className="tx">{r.title}</span>
                <span className={cx("pill kind", r.kind === "video" && "v")}><I n={r.kind === "video" ? "film" : "image"} />{r.kind === "video" ? "Video" : "Photo"}</span>
              </button>
            ))}
          </div>
          {a.results.length > 1 && <p className="help">The other save nodes still run as the workflow has them; their files aren't kept.</p>}
        </>
      )}
    </Sec>
  );
}

/** The template's name, up top: it's what Explore, Create and the Library show. */
export function TitleField({ d, setD, invalid }: { d: Details; setD: (f: (d: Details) => Details) => void; invalid: boolean }) {
  // Labels read "Name · Model"; the model half rides along untouched.
  const [name, ...rest] = d.label.split(" · ");
  const model = rest.join(" · ");
  return (
    <div className={cx("bname", invalid && "bad")}>
      <label htmlFor="bd-label">Template name</label>
      <div className="bname-in">
        <span className="bname-f">
          <input id="bd-label" value={name} maxLength={60} placeholder="Name your template" spellCheck={false} aria-invalid={invalid || undefined}
          onChange={(e) => { const v = e.target.value.replace(/ · /g, " "); setD((x) => ({ ...x, label: model ? `${v} · ${model}` : v })); }} />
          <I n="pencil" />
        </span>
        {model && <span className="pill bname-m" title="The model, shown under the name on Explore">{model}</span>}
      </div>
      {invalid && <span className="bname-err" role="alert">Give it a name. Explore, Create and your Library show it.</span>}
    </div>
  );
}

/** A media input's sample: a drop zone in the input's shape. Click to pick a file, or drop one on it. */
function SlotDrop({ r, name, busy, onFile }: { r: MediaRow; name: string; busy: boolean; onFile: (f: File) => void }) {
  const toast = useApp((s) => s.toast);
  const fits = (f: File) => (r.kind === "audio" ? f.type.startsWith("audio/") : r.kind === "video" ? isVideo(f) : isImage(f));
  const noun = r.kind === "video" ? "clip" : r.kind === "audio" ? "sound" : "photo";
  const drop = useFileDrop((files) => onFile(files[0]), {
    accept: fits, disabled: busy || !r.on,
    onReject: (files) => toast({ text: `${name} takes a ${r.kind === "video" ? "video clip" : noun}. ${files[0].name} isn't one.`, tone: "warn" }),
  });
  return (
    <label className={cx("bdrop", r.kind === "video" && "v", drop.over && "drag")} title={r.sample ? "Replace the sample: click or drop a file" : `Choose a ${noun}`} {...drop.props}>
      {busy ? <span className="bd-ic"><Spinner size={16} /></span>
        : r.sample ? <>
          <img src={r.sample.poster ?? r.sample.url} alt={`${name} sample`} />
          {r.kind === "video" && <span className="play"><I n="play" /></span>}
          <span className="swap"><I n="upload" />Replace</span>
        </> : <>
          <span className="bd-ic"><I n={KIND_ICON[r.kind]} /></span>
          <b>{drop.over ? "Drop it" : `Drop a ${noun}`}</b>
          <span>or click to choose</span>
        </>}
      <input type="file" hidden accept={r.kind === "video" ? "video/*" : r.kind === "image" ? "image/*" : "audio/*"} disabled={busy || !r.on} onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
    </label>
  );
}
