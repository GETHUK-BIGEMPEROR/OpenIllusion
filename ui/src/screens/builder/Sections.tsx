// Step 2: the template's sections (source, inputs, prompt, result, title).
import { useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Mentions } from "../../components/Mentions";
import { mentions, noNames, type Mention } from "../../lib/fields";
import { I } from "../../components/oi";
import { isAudio, isImage, isVideo, useFileDrop, usePageDrop } from "../../components/Drop";
import { FitLine, MediaSheet, MediaThumb, metaOf } from "../../components/MediaEditor";
import { ACCEPT, ACCEPT_AUDIO, ACCEPT_VIDEO } from "../create/shared";
import { useUploader } from "../../components/Refs";
import { cx, Spinner } from "../../components/ui";
import { api, type Asset, type Fit, type MediaKind, type RouterAdapter, type WorkflowAnalysis } from "../../lib/api";
import { checks, fitEdits, NO_EDITS, outOf, statusOf, toOps, type State } from "../../lib/edits";
import { errMsg } from "../../lib/format";
import { useApp } from "../../lib/store";
import { type Details, human, KIND_ICON, KIND_NOUN, type MediaRow, type OutputState, type PromptState, type Source } from "./model";
import { adapterProblems, fitText, jobOf, type JobKind, maxOf, type Need, placeFiles, placeMiss, ROLE_HINT, routerJobs, runSays, toJob } from "./modes";

/** One step of the set-up: numbered in page order (a CSS counter), joined to the next by the spine. */
export function Sec({ id, title, desc, aside, children }: { id: string; title: string; desc: ReactNode; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="bsec" aria-labelledby={`bld-${id}`}>
      <div className="bsec-n" aria-hidden><span /></div>
      <div className="bsec-b">
        <div className="bsec-h">
          <div><h3 id={`bld-${id}`}>{title}</h3><p>{desc}</p></div>
          {aside}
        </div>
        {children}
      </div>
    </section>
  );
}

/** What the template is made from: the Router model, or the workflow file and whether this ComfyUI can run it. */
export function SourceBar({ src }: { src: Source }) {
  if (src.kind === "cloud") {
    return (
      <div className="bld-source">
        <span className="bc-ic cloud" aria-hidden>{src.a.name.slice(0, 2)}</span>
        <div><b>{src.a.name}</b><span className="mono">{src.a.model} · Comfy Router · makes {src.a.mode === "motion" ? "video" : "photos"}</span></div>
      </div>
    );
  }
  const a = src.a;
  const missing = a.check.missing_nodes.length + a.check.missing_models.length;
  return (
    <div className="bld-source">
      <span className="bc-ic local"><I n="graph" /></span>
      <div>
        <b className="mono">{a.source}</b>
        <span>{a.nodes} nodes · {a.preset ? "from the template, set up as it is" : a.format === "ui" ? "converted from the saved workflow" : "API format"}</span>
      </div>
      {missing ? <span className="pill rose"><I n="alert" />{missing} missing</span> : <span className="pill"><i className="dot" />Ready to run</span>}
    </div>
  );
}

/** A workflow's gaps on this ComfyUI: missing nodes and models, values it won't take, notes. Nothing when there are none. */
export function SourceCheck({ src }: { src: Source }) {
  const [open, setOpen] = useState(false);
  if (src.kind === "cloud") return null;
  const a = src.a;
  const c = a.check;
  const loaders = new Set(a.media.map((m) => m.node));
  const bad = c.bad_values.filter((b) => !loaders.has(b.node_id));
  const missing = c.missing_nodes.length + c.missing_models.length;
  return (
    <>
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
    </>
  );
}

/** "Image 1", "Video 1": an input is named by its place among its kind, the same way Create shows it. */
export const slotNames = (rows: { kind: MediaKind }[]) => {
  const n: Record<string, number> = {};
  return rows.map((r) => `${KIND_NOUN[r.kind]} ${(n[r.kind] = (n[r.kind] ?? 0) + 1)}`);
};

export function InputsSection({ rows, setRows }: { rows: MediaRow[]; setRows: (f: (r: MediaRow[]) => MediaRow[]) => void }) {
  const { upload, busy } = useUploader();
  const toast = useApp((s) => s.toast);
  const live = useRef(rows);
  live.current = rows;
  const up = (key: string, p: Partial<MediaRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  // Dropped on an input, the first file is its sample; the rest, and files dropped off any input, fill the empty ones.
  const take = async (files: File[], at?: MediaRow) => {
    const got = await upload(files.filter(isFile));
    if (!got.length) return;
    const p = placeFiles(live.current, got, undefined, at && { key: at.key });
    setRows(() => p.rows);
    const miss = placeMiss(p.rows, p.left);
    if (miss) toast({ text: miss, tone: "warn" });
  };
  const shown = rows.filter((r) => r.on);
  usePageDrop((files) => {
    if (!shown.length) return false;
    void take(files);
    return true;
  }, "Drop photos, clips or sounds to fill the empty inputs");
  const names = slotNames(shown);
  return (
    <Sec id="in" title="Inputs"
      desc="Found in the workflow. Drop a sample into each: the first run uses it, and it ships as the template's default. Edit a sample to crop, turn, size or cut it."
      aside={shown.length ? <span className="mono">{shown.length}</span> : undefined}>
      {!shown.length ? (
        <p className="help">No photo or video loaders in this workflow. People only write the prompt.</p>
      ) : (
        <div className="bcards">
          {shown.map((r, i) => (
            <SampleCard key={r.key} r={r} name={names[i]} sub={r.where} busy={busy > 0} onFiles={(f) => void take(f, r)}
              onApply={(a) => up(r.key, { sample: a, own: true })} onRemove={() => up(r.key, { sample: null, own: false })} style={{ "--i": i } as CSSProperties} />
          ))}
        </div>
      )}
    </Sec>
  );
}

const KIND_TILE: Record<JobKind, MediaKind[]> = { text: [], photos: ["image"], frames: ["image"], refs: [], vedit: ["video"], extend: ["video"], style: ["image"] };

/** Cloud, step one: what the template does. Each job is a card; one job, no cards. */
export function JobSection({ a, rows, setRows }: { a: RouterAdapter; rows: MediaRow[]; setRows: (f: (r: MediaRow[]) => MediaRow[]) => void }) {
  const jobs = routerJobs(a);
  const cur = jobOf(jobs, rows);
  if (jobs.length < 2) return null;
  const out: MediaKind = a.mode === "motion" ? "video" : "image";
  return (
    <Sec id="job" title="What it does" desc={`${a.name} does ${jobs.length} things. Pick one: it decides what people are asked for.`}>
      <div className="bjobs" role="radiogroup" aria-label="What this template does">
        {jobs.map((j) => {
          // What goes in: the kinds of file the job takes, then the prompt.
          const ins = [...new Set(KIND_TILE[j.kind].length ? KIND_TILE[j.kind] : j.inputs.map((i) => a.inputs[i].type))];
          return (
            <button key={j.id} type="button" role="radio" aria-checked={cur?.id === j.id} className="bjob" onClick={() => setRows((rs) => toJob(j, rs))}>
              <span className="bjob-flow" aria-hidden>
                {ins.map((k) => <span key={k} className={cx("t", k)}><I n={KIND_ICON[k]} /></span>)}
                <span className="t txt"><I n="pencil" /></span>
                <I n="right" className="arr" />
                <span className={cx("t out", out)}><I n={KIND_ICON[out]} /></span>
              </span>
              <b>{j.label}</b>
              <span className="d">{j.desc}</span>
            </button>
          );
        })}
      </div>
    </Sec>
  );
}

const NEED: Record<Need, [string, string]> = { yes: ["req", "Required"], no: ["opt", "Optional"], any: ["any", "One of these"] };

/** Cloud, step two: the job's inputs, one group per role. What you fill is what people are asked for. */
export function CloudInputs({ a, rows, setRows }: { a: RouterAdapter; rows: MediaRow[]; setRows: (f: (r: MediaRow[]) => MediaRow[]) => void }) {
  const { upload, busy } = useUploader();
  const toast = useApp((s) => s.toast);
  const [loading, setLoading] = useState<string | null>(null);
  const j = jobOf(routerJobs(a), rows);
  const names = filledNames(rows);
  const live = useRef(rows);
  live.current = rows;
  // Dropped on an input, the first file goes there (``add``: as one more of its role); the rest, and files
  // dropped off any input, fill the job's empty inputs, then roles with room.
  const take = async (files: File[], r?: MediaRow, add = false) => {
    setLoading(r ? (add ? `${r.slot}:add` : r.key) : null);
    const got = await upload(files.filter(isFile)).finally(() => setLoading(null));
    if (!got.length) return;
    const p = placeFiles(live.current, got, a, r && { key: r.key, add });
    setRows(() => p.rows);
    const miss = placeMiss(p.rows, p.left);
    if (miss) toast({ text: miss, tone: "warn" });
  };
  usePageDrop((files) => {
    if (!j?.inputs.length) {
      toast({ text: `${j?.label ?? "This"} takes no files. Pick what the template does first.`, tone: "warn" });
      return true;
    }
    void take(files);
    return true;
  }, "Drop photos, clips or sounds to fill the empty inputs");
  // Emptying one of several files takes its tile away; the last one stays, empty.
  const remove = (r: MediaRow) => setRows((rs) => (rs.filter((y) => y.slot === r.slot).length > 1
    ? rs.filter((y) => y.key !== r.key) : rs.map((y) => (y.key === r.key ? { ...y, sample: null, own: false } : y))));
  const problems = adapterProblems(a, rows);
  const [fitting, setFitting] = useState<number | null>(null);
  // Every sample in a role that a run would change, made to fit now. One new file each; the originals stay.
  const fitAll = async (i: number, fit: Fit) => {
    const todo = rows.filter((r) => r.on && r.slot === i && r.sample && statusOf(r.sample, fit, NO_EDITS, a.name)?.state === "fix");
    setFitting(i);
    try {
      for (const r of todo) {
        const m = r.sample!;
        const made = await api.mediaEdit(m.asset, toOps(fitEdits(m, fit, NO_EDITS).edits, m), m.name);
        setRows((rs) => rs.map((y) => (y.key === r.key ? { ...y, sample: made, own: true } : y)));
      }
      toast({ text: `${todo.length === 1 ? "1 file" : `${todo.length} files`} made to fit ${a.name}. The originals are kept.`, tone: "ok" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setFitting(null);
    }
  };
  return (
    <Sec id="in" title="Inputs"
      desc={j?.inputs.length ? "Drop a sample in each one you want. People are asked for every input you fill, and your samples are the defaults. Edit a sample to fit the model, or leave it: a run fits it anyway." : "None: people only write the prompt."}>
      {/* What the job must have comes first. */}
      {j && [...j.inputs].sort((x, y) => +(j.need[y] === "yes") - +(j.need[x] === "yes")).map((i) => {
        const x = a.inputs[i];
        const group = rows.filter((r) => r.on && r.slot === i);
        const n = group.filter((r) => r.sample).length;
        const [cls, word] = NEED[j.need[i]];
        const last = group[group.length - 1];
        const cap = maxOf(a, i, rows);
        const files = group.filter((r) => r.sample).map((r) => r.sample!);
        const fixable = x.fit ? files.filter((m) => statusOf(m, x.fit, NO_EDITS, a.name)?.state === "fix").length : 0;
        return (
          <div key={i} className="brole">
            <div className="brole-h">
              <b>{x.role}</b><span className={cx("bneed", cls)}>{word}</span>
              {x.max > 1 && <span className={cx("bcount mono", n > cap && "over")} title={cap < x.max ? `${x.max} on its own, ${cap} with a ${x.max_with!.roles.map((r) => r.toLowerCase()).join(" or ")}` : undefined}>{n}/{cap}</span>}
              {ROLE_HINT[x.role] && <span className="bhint">{ROLE_HINT[x.role]}</span>}
              <span style={{ flex: 1 }} />
              {x.fit && fixable > 0 && (
                <button className="btn sm" type="button" disabled={fitting != null} onClick={() => void fitAll(i, x.fit!)} title={`Make ${fixable === 1 ? "this file" : "these files"} meet ${a.name}'s limits now, as new files`}>
                  {fitting === i ? <Spinner size={12} /> : <I n="wand" />}{fixable === 1 ? "Fit it to spec" : `Fit all ${fixable} to spec`}
                </button>
              )}
            </div>
            {x.fit && (files.length ? <RolePills fit={x.fit} files={files} /> : <span className="bfit mono" title={`What ${a.name} takes. Runs crop, scale and cut each file to fit.`}>{fitText(x.fit)}</span>)}
            <div className="bcards">
              {group.map((r) => (
                <SampleCard key={r.key} r={r} name={names.get(r.key) ?? x.role} fit={x.fit} model={a.name} role={x.role} busy={busy > 0} loading={loading === r.key}
                  onFiles={(f) => void take(f, r)} onApply={(s) => setRows((rs) => rs.map((y) => (y.key === r.key ? { ...y, sample: s, own: true } : y)))} onRemove={() => remove(r)} />
              ))}
              {last?.sample && group.length < cap && (
                <div className="bcard add">
                  <SlotDrop r={{ ...last, key: `${i}:add`, sample: null }} name={x.role} busy={busy > 0} loading={loading === `${i}:add`} more onFiles={(f) => void take(f, last, true)} />
                </div>
              )}
            </div>
          </div>
        );
      })}
      <p className={cx("bsays", problems.length > 0 && "bad")} role="status"><i aria-hidden />{problems[0] ?? runSays(a, rows)}</p>
    </Sec>
  );
}

/** A role's limits, each counted across its files: "Shape 2:5 to 5:2 · 1 of 2 off". */
function RolePills({ fit, files }: { fit: Fit; files: Asset[] }) {
  const each = files.map((m) => checks(m.kind as "image", fit, outOf(m, NO_EDITS)));
  return (
    <div className="bpills">
      {each[0].map((c) => {
        const states = each.map((l) => l.find((y) => y.key === c.key)?.state).filter(Boolean) as State[];
        const off = states.filter((v) => v === "fix" || v === "bad").length;
        const st: State = c.state === "auto" ? "auto" : states.includes("bad") ? "bad" : off ? "fix" : "ok";
        return (
          <span key={c.key} className={cx("lpill", st)} title={st === "fix" ? `A run ${c.run}` : st === "auto" ? "Made so when it runs" : undefined}>
            <i className="dot" />{c.label}{st === "auto" ? <span className="mono">at run</span> : off ? <span className="mono">{files.length === 1 ? "off" : `${off} of ${files.length} off`}</span> : null}
          </span>
        );
      })}
    </div>
  );
}

/** One input's sample as a card: the file, whether the model takes it, and Edit, Replace, Remove. Empty, it's a drop zone. */
function SampleCard({ r, name, sub, fit, model, role, busy, loading, onFiles, onApply, onRemove, style }: {
  r: MediaRow; name: string; sub?: string; fit?: Fit; model?: string; role?: string; busy: boolean; loading?: boolean;
  onFiles: (f: File[]) => void; onApply: (a: Asset) => void; onRemove: () => void; style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const toast = useApp((s) => s.toast);
  const m = r.sample;
  const noun = r.kind === "video" ? "clip" : r.kind === "audio" ? "sound" : "photo";
  const fits = (f: File) => (r.kind === "audio" ? isAudio(f) : r.kind === "video" ? isVideo(f) : isImage(f));
  const drop = useFileDrop(onFiles, {
    accept: fits, disabled: busy || !r.on,
    onReject: (files) => toast({ text: `${name} takes a ${noun}. ${files[0].name} isn't one.`, tone: "warn" }),
  });
  if (!m) {
    return (
      <div className="bcard vacant" style={style}>
        <SlotDrop r={r} name={name} busy={busy} loading={loading} onFiles={onFiles} />
        <div className="bcard-b">
          <div className="bcard-l1"><b>{name}</b>{sub && <small title={sub}>{sub}</small>}</div>
          <span className={cx("fline", r.required && "need")}><span>{r.required ? `Needs a sample ${noun}` : "Optional"}</span></span>
        </div>
      </div>
    );
  }
  return (
    <article className={cx("bcard", drop.over && "drag")} style={style} {...drop.props}>
      <button type="button" className="bcard-pic" onClick={() => setOpen(true)} title={`Edit ${name}`} aria-label={`Edit ${name}`}>
        {loading ? <span className="bd-ic"><Spinner size={16} /></span> : <MediaThumb m={m} />}
      </button>
      <div className="bcard-b">
        <div className="bcard-l1"><b>{name}</b><small title={m.name}>{sub ?? m.name}</small><em className={r.own ? "tag-own" : "tag-sample"}>{r.own ? "YOURS" : "SAMPLE"}</em></div>
        <span className="bcard-meta mono">{metaOf(m)}</span>
        {fit && model && <FitLine m={m} fit={fit} model={model} />}
        <div className="bcard-acts">
          <button className="btn sm" type="button" onClick={() => setOpen(true)}><I n="pencil" />Edit</button>
          <span style={{ flex: 1 }} />
          <label className="icon-btn sm" title={`Replace with another ${noun}`} aria-label={`Replace ${name}`}>
            <I n="upload" />
            <input type="file" hidden accept={r.kind === "video" ? ACCEPT_VIDEO : r.kind === "image" ? ACCEPT : ACCEPT_AUDIO} disabled={busy}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFiles([f]); e.target.value = ""; }} />
          </label>
          <button className="icon-btn sm" type="button" onClick={onRemove} aria-label={`Remove ${name}`} title="Remove"><I n="x" /></button>
        </div>
      </div>
      {open && <MediaSheet m={m} fit={fit} model={model} role={role} title={`Edit ${name}`} onClose={() => setOpen(false)} onApply={onApply} />}
    </article>
  );
}

/** "Image 1" for each filled row, by row key: what Create calls it. */
const isFile = (f: File) => isImage(f) || isVideo(f) || isAudio(f);

const filledNames = (rows: MediaRow[]) => {
  const filled = rows.filter((r) => r.on && r.sample);
  const names = slotNames(filled);
  return new Map(filled.map((r, i) => [r.key, names[i]]));
};

export function PromptSection({ src, p, setP, files = [] }: { src: Source; p: PromptState; setP: (f: (p: PromptState) => PromptState) => void; files?: Omit<Mention, "token" | "name">[] }) {
  const ta = useRef<HTMLTextAreaElement>(null);
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
    <Sec id="pr" title="Prompt" desc={src.kind === "cloud" && Object.keys(src.a.mentions ?? {}).length
      ? `What the template opens with. People can change any word on Create. Name files as Image 1, Video 1…; ${src.a.name} gets them in its own form.`
      : src.kind === "cloud" ? "What the template opens with. People can change any word on Create."
      : "Pick the text box people write in. What the template opens with; it's sent exactly as written."}>
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
            <div className="bpr-box">
              <textarea ref={ta} className="bprompt" aria-label="The prompt the template opens with" rows={Math.min(10, Math.max(3, Math.ceil(p.def.length / 70)))} value={p.def} maxLength={4000} onChange={set("def")} placeholder="The prompt the template starts with" spellCheck={false} />
              {src.kind === "cloud" && (mentions(src.a.mentions, files).length > 0 || noNames(src.a.mentions, files, src.a.name)) && (
                <div className="bpr-names">
                  <Mentions list={mentions(src.a.mentions, files)} none={noNames(src.a.mentions, files, src.a.name)} model={src.a.name} ta={ta} value={p.def} onChange={(v) => setP((x) => ({ ...x, def: v }))} preview />
                </div>
              )}
            </div>
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
    <Sec id="rs" title="The result" desc="This workflow saves more than one thing. Pick the one a run keeps.">
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
/** The name, and beside it the model Explore shows under it: a Router model's own name, or what a workflow's author types. */
export function TitleField({ d, setD, invalid, from, model }: { d: Details; setD: (f: (d: Details) => Details) => void; invalid: boolean; from?: string; model: string | null }) {
  return (
    <div className={cx("bname", invalid && "bad")}>
      <label htmlFor="bd-label">Template name, as Explore, Create and your Library show it</label>
      <div className="bname-in">
        <span className="bname-f">
          <input id="bd-label" value={d.label} maxLength={60} placeholder="Name your template" spellCheck={false} aria-invalid={invalid || undefined}
          onChange={(e) => { const v = e.target.value; setD((x) => ({ ...x, label: v })); }} />
          <I n="pencil" />
        </span>
        {model ? <span className="pill bname-m" title="The model, shown under the name on Explore">{model}</span>
          : <input className="bname-model" aria-label="Model" value={d.model_name ?? ""} maxLength={40} placeholder="Model, like Wan 2.2" spellCheck={false}
            title="The model this workflow runs, shown under the name on Explore" onChange={(e) => { const v = e.target.value; setD((x) => ({ ...x, model_name: v })); }} />}
      </div>
      {invalid && <span className="bname-err" role="alert">Give it a name. Explore, Create and your Library show it.</span>}
      {from && <p className="bname-from">Built from <b>{from}</b>.</p>}
    </div>
  );
}

/** A media input's sample: a drop zone in the input's shape. Click to pick a file, or drop one on it. */
function SlotDrop({ r, name, busy, loading, more, onFiles }: { r: MediaRow; name: string; busy: boolean; loading?: boolean; more?: boolean; onFiles: (f: File[]) => void }) {
  const toast = useApp((s) => s.toast);
  const fits = (f: File) => (r.kind === "audio" ? isAudio(f) : r.kind === "video" ? isVideo(f) : isImage(f));
  const noun = r.kind === "video" ? "clip" : r.kind === "audio" ? "sound" : "photo";
  const drop = useFileDrop(onFiles, {
    accept: fits, disabled: busy || !r.on,
    onReject: (files) => toast({ text: `${name} takes a ${r.kind === "video" ? "video clip" : noun}. ${files[0].name} isn't one.`, tone: "warn" }),
  });
  return (
    <label className={cx("bdrop", r.kind === "video" && "v", drop.over && "drag")} title={r.sample ? "Replace the sample: click or drop a file" : `Choose a ${noun}`} {...drop.props}>
      {(loading ?? busy) ? <span className="bd-ic"><Spinner size={16} /></span>
        : r.sample ? <>
          {r.sample.poster || r.kind === "image" ? <img src={r.sample.poster ?? r.sample.url} alt={`${name} sample`} /> : <span className="bd-ic"><I n={KIND_ICON[r.kind]} /></span>}
          {r.kind === "video" && <span className="play"><I n="play" /></span>}
          <span className="swap"><I n="upload" />Replace</span>
        </> : <>
          <span className="bd-ic"><I n={KIND_ICON[r.kind]} /></span>
          <b>{drop.over ? "Drop it" : more ? `Another ${noun}` : `Drop a ${noun}`}</b>
          {!more && <span>or click to choose</span>}
        </>}
      <input type="file" hidden accept={r.kind === "video" ? ACCEPT_VIDEO : r.kind === "image" ? ACCEPT : ACCEPT_AUDIO} disabled={busy || !r.on} multiple onChange={(e) => { onFiles([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </label>
  );
}
