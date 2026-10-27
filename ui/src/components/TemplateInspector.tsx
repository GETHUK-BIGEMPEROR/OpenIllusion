import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, isMedia, type EngineInfo, type Field as InputField, type PromptIdea, type Spec, type TemplatePatch } from "../lib/api";
import { fieldsOf, promptField, roleOf } from "../lib/fields";
import { confirm } from "../lib/confirm";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { defaults } from "../lib/spec";
import { useApp } from "../lib/store";
import { clampAspect } from "./Masonry";
import { Compare, gpuName, I, useStatus } from "./oi";
import { useLocalCheck } from "./Studio";
import { tplModel, tplName, useCoverActions } from "./TemplateCard";
import { Spinner } from "./ui";

/** The prompt as the form holds it: its default and ideas. Photos and clips have nothing to edit. */
interface InputDraft { text?: string; ideas?: PromptIdea[] }

interface Draft {
  label: string;
  blurb: string;
  tags: string;
  inputs: Record<string, InputDraft>;
}

const isText = (f: InputField) => f.type === "text";
const textOf = (f: InputField) => (isText(f) && "default" in f && typeof f.default === "string" ? f.default : "");
const ideasOf = (f: InputField): PromptIdea[] => ("examples" in f && f.examples) || [];

const draftOf = (e: EngineInfo): Draft => ({
  label: e.label,
  blurb: e.blurb ?? "",
  tags: (e.tags ?? []).join(", "),
  inputs: Object.fromEntries(fieldsOf(e).filter(isText).map((f) => [f.key, { text: textOf(f), ideas: ideasOf(f) }])),
});

const fit = (s: string, max = 8) => Math.min(max, Math.max(3, Math.ceil(s.length / 48) + s.split("\n").length));
const commas = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Only what changed goes to the server, so an untouched field never gets rewritten. */
function patchOf(e: EngineInfo, d: Draft): TemplatePatch {
  const base = draftOf(e);
  const p: TemplatePatch = {};
  if (d.label !== base.label) p.label = d.label;
  if (d.blurb !== base.blurb) p.blurb = d.blurb;
  if (d.tags !== base.tags) p.tags = commas(d.tags);
  for (const [key, x] of Object.entries(d.inputs)) {
    const b = base.inputs[key];
    if (!b) continue;
    const ch: NonNullable<TemplatePatch["inputs"]>[string] = {};
    if (x.text !== undefined && x.text !== b.text) ch.default = x.text;
    if (x.ideas && !same(x.ideas, b.ideas)) ch.examples = x.ideas.filter((i) => i.text.trim());
    if (Object.keys(ch).length) (p.inputs ??= {})[key] = ch;
  }
  return p;
}

// Unsaved edits survive switching to another template and back.
const drafts = new Map<string, Draft>();

const fill: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" };

function Field({ id, label, help, children }: { id: string; label: string; help?: string; children: ReactNode }) {
  return <div className="ofield"><label htmlFor={id}>{label}</label>{children}{help && <p className="help">{help}</p>}</div>;
}

/** Right-hand panel on Explore: everything about one template, editable in place. */
export function TemplateInspector({ e, locked, onUse, onClose }: { e: EngineInfo; locked: string | null; onUse: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [d, setD] = useState<Draft>(() => drafts.get(e.id) ?? draftOf(e));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const editable = !!e.origin && (e.kind === "local" || !!e.built);
  const [editing, setEditing] = useState(() => drafts.has(e.id));
  const patch = patchOf(e, d);
  const dirty = Object.keys(patch).length > 0;

  useEffect(() => {
    if (dirty) drafts.set(e.id, d);
    else drafts.delete(e.id);
  }, [e.id, d, dirty]);

  const set = <K extends "label" | "blurb" | "tags">(k: K) => (ev: { target: { value: string } }) => setD((x) => ({ ...x, [k]: ev.target.value }));
  const setIn = (key: string, ch: Partial<InputDraft>) => setD((x) => ({ ...x, inputs: { ...x.inputs, [key]: { ...x.inputs[key], ...ch } } }));
  const land = (next: EngineInfo) => {
    qc.setQueryData<EngineInfo[]>(["engines"], (list) => list?.map((x) => (x.id === next.id ? next : x)));
    drafts.delete(e.id);
    setD(draftOf(next));
  };
  const save = async () => {
    if (!dirty) return;
    if (!d.label.trim()) return setErr("Give the template a name.");
    setSaving(true);
    setErr(null);
    try {
      land(await api.editTemplate(e.id, patch));
      toast({ text: "Template saved.", tone: "ok" });
    } catch (x) {
      setErr(errMsg(x));
    } finally {
      setSaving(false);
    }
  };
  const resetAll = async () => {
    const res = await confirm({
      tone: "neutral", icon: "undo",
      view: () => ({ title: "Reset to the shipped version?", body: "Your edits to the name, description, prompt and ideas are dropped. The cover you set stays.", action: "Reset" }),
    });
    if (!res.ok) return;
    setSaving(true);
    try {
      land(await api.resetTemplate(e.id));
      toast({ text: "Back to the shipped version.", tone: "ok" });
    } catch (x) {
      toast({ text: `Couldn't reset: ${errMsg(x)}`, tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    const res = await confirm({
      hold: true,
      view: () => ({
        title: `Delete ${tplName(e)}?`, previews: e.cover ? [e.cover] : [],
        body: "Its samples and cover go too. This can't be undone.", facts: ["Generations made with it stay"], action: "Hold to delete",
      }),
    });
    if (!res.ok) return;
    setSaving(true);
    try {
      await api.deleteTemplate(e.id);
      qc.setQueryData<EngineInfo[]>(["engines"], (list) => list?.filter((x) => x.id !== e.id));
      drafts.delete(e.id);
      onClose();
      toast({ text: `${e.label} deleted.`, tone: "ok" });
    } catch (x) {
      toast({ text: `Couldn't delete: ${errMsg(x)}`, tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  const duplicate = async () => {
    setSaving(true);
    try {
      const next = await api.duplicateTemplate(e.id);
      qc.setQueryData<EngineInfo[]>(["engines"], (list) => (list ? [...list, next] : list));
      qc.invalidateQueries({ queryKey: ["engines"] });
      go({ name: "explore", t: next.id });
      toast({ text: `${tplName(next)} is yours to edit.`, tone: "ok" });
    } catch (x) {
      toast({ text: `Couldn't duplicate: ${errMsg(x)}`, tone: "error" });
    } finally {
      setSaving(false);
    }
  };
  const save_ = useRef(save);
  save_.current = save;

  // Ctrl/Cmd+S saves; Esc closes when you're not typing.
  useEffect(() => {
    const on = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "s") {
        ev.preventDefault();
        void save_.current();
      } else if (ev.key === "Escape" && !useApp.getState().palette && !(ev.target as HTMLElement)?.closest?.("input,textarea,[role=menu],[data-radix-popper-content-wrapper]")) {
        onClose();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  const samples = e.defaults?.inputs ?? [];
  const lead = samples.find((x) => x.slot === "image:1");
  const ar = Math.max(clampAspect(e.cover ? e.cover_aspect : lead?.width && lead?.height ? lead.width / lead.height : 4 / 5), 4 / 5);
  const fields = fieldsOf(e);
  const media = fields.filter(isMedia);
  const texts = fields.length ? fields.filter(isText) : [];
  const settings = fields.filter((f) => !isMedia(f) && !isText(f));
  const rawPrompt = !fields.length ? promptField(e) : undefined;

  return (
    <div className="insp" aria-label={`${tplName(e)} details`}>
      <div className="insp-head">
        <h2>Template</h2>
        {dirty && <span className="hint" style={{ color: "var(--orange)", marginRight: "auto" }} aria-live="polite">Unsaved</span>}
        {editable && (
          <button className="btn sm ghost" type="button" onClick={() => setEditing(!editing)} aria-pressed={editing}>
            <I n={editing ? "check" : "pencil"} />{editing ? "Done editing" : "Edit details"}
          </button>
        )}
        <button className="icon-btn sm" type="button" aria-label="Close details" onClick={onClose}><I n="x" /></button>
      </div>

      <div className="insp-body">
        <div className="insp-hero" style={{ "--ar": ar } as CSSProperties}>
          {e.cover_video ? <video key={e.cover_video} src={e.cover_video} poster={e.cover ?? undefined} muted loop playsInline autoPlay aria-hidden style={fill} />
            : e.cover && lead && !e.cover_custom ? <Compare before={lead.url} after={e.cover} lb="Sample" la="Result" />
            : e.cover ? <img src={e.cover} alt="" style={fill} />
            : <div className="empty" style={{ padding: 30 }}><div className="empty-ic"><I n="image" /></div><h3>{e.draft ? "Not published yet" : "No cover yet"}</h3>{e.draft && <p>Its first published result becomes the cover.</p>}</div>}
        </div>

        {editing ? (
          <>
            <Field id="ti-label" label="Name"><input className="input" id="ti-label" value={d.label} onChange={set("label")} maxLength={80} /></Field>
            <Field id="ti-blurb" label="What it does"><textarea className="textarea" id="ti-blurb" rows={3} value={d.blurb} onChange={set("blurb")} maxLength={400} /></Field>
            <Field id="ti-tags" label="Tags" help="Comma separated. Tags two or more templates share become filters on Explore."><input className="input" id="ti-tags" value={d.tags} onChange={set("tags")} /></Field>
          </>
        ) : (
          <>
            <div className="insp-title">
              <h3>{tplName(e)}</h3>
              <p>{tplModel(e)} · {e.mode === "motion" ? "Video" : "Image"} · {e.kind === "local" ? "Runs on your GPU" : "Runs on Comfy Router"}{e.edited ? " · Edited" : e.built ? " · Built by you" : e.origin === "user" ? " · Yours" : ""}</p>
            </div>
            {e.blurb && <p className="insp-blurb">{e.blurb}</p>}
          </>
        )}
        {locked && <div className="errbox"><b>Needs setup</b><p>{locked}</p></div>}

        {!!media.length && (
          <div className="kv">
            <div className="kv-h">Inputs<span>{media.length} input{media.length > 1 ? "s" : ""}</span></div>
            {media.map((f) => {
              const sm = samples.find((y) => y.slot === f.key);
              const thumb = sm && f.type !== "audio" ? <img src={sm.poster ?? sm.url} alt="" loading="lazy" /> : <span className="empty-ic" style={{ width: 44, height: 44, margin: 0, borderRadius: 9 }}><I n={f.type === "video" ? "film" : f.type === "audio" ? "zap" : "image"} /></span>;
              return (
                <div key={f.key} className="inrow">
                  {thumb}
                  <div><b>{f.label}{f.required === false ? " · optional" : ""}</b><span>{sm ? "Sample included" : f.type === "video" ? "Your clip" : f.type === "audio" ? "Your sound" : "Your photo"}</span></div>
                </div>
              );
            })}
          </div>
        )}

        {texts.map((f) => {
          const x = d.inputs[f.key];
          const ideas = ideasOf(f).filter((i) => i.text !== textOf(f));
          return (
            <div key={f.key} className="kv">
              <div className="kv-h">{f.label}<span>{f.required === false ? "Optional" : "Default"}</span></div>
              {editing && x ? (
                <>
                  <textarea className="textarea" aria-label={`Default ${f.label.toLowerCase()}`} rows={fit(x.text ?? "", 12)} value={x.text ?? ""} onChange={(ev) => setIn(f.key, { text: ev.target.value })} maxLength={4000} />
                  <p className="help" style={{ marginTop: -4 }}>The whole text the workflow gets. The prompt box opens with it, and anyone can change any of it there.</p>
                  <IdeasEditor ideas={x.ideas ?? []} seed={x.text ?? ""} onChange={(ideas) => setIn(f.key, { ideas })} />
                </>
              ) : (
                <>
                  <div className="quote" style={{ whiteSpace: "pre-wrap" }}>{textOf(f) || <span style={{ color: "var(--text-3)" }}>Empty by default</span>}</div>
                  {!!ideas.length && <div className="examples">{ideas.map((i) => <span key={i.label} className="ex" title={i.text}>{i.label}</span>)}</div>}
                </>
              )}
            </div>
          );
        })}
        {rawPrompt && (
          <div className="kv">
            <div className="kv-h">Prompt<span>Default</span></div>
            <div className="quote">{e.defaults?.prompt || <span style={{ color: "var(--text-3)" }}>No default prompt</span>}</div>
          </div>
        )}

        {!!settings.length && (
          <div className="kv">
            <div className="kv-h">Settings<span>{settings.length}</span></div>
            <div className="checks">
              {settings.map((f) => (
                <div key={f.key}>{f.label}<span className="mono">{"default" in f && f.default != null && f.default !== "" ? String(f.default) : "—"}{f.advanced ? " · advanced" : ""}</span></div>
              ))}
            </div>
          </div>
        )}

        {!editing && !!e.tags?.length && <div className="kv"><div className="kv-h">Tags</div><div className="tags">{e.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div></div>}

        {e.kind === "local" && <Ready e={e} />}
        <CoverBox e={e} onUse={onUse} />
        <p className="help" style={{ wordBreak: "break-word" }}><span className="mono">{e.id}</span>{e.source && <> · {e.source}</>}</p>
      </div>

      <div className="insp-foot">
        {err && <p role="alert" className="help" style={{ color: "var(--rose)", flexBasis: "100%", margin: 0 }}>{err}</p>}
        {dirty ? (
          <>
            <button className="btn" type="button" onClick={() => { setD(draftOf(e)); setErr(null); }} disabled={saving}>Discard</button>
            <button className="btn primary" type="button" style={{ flex: 1, justifyContent: "center" }} onClick={save} disabled={saving}>
              {saving ? <Spinner size={13} /> : <I n="check" />}Save changes
            </button>
          </>
        ) : (
          <>
            {e.edited && editing && <button className="btn" type="button" onClick={resetAll} disabled={saving}><I n="undo" />Reset to shipped</button>}
            {e.built && editing && <button className="btn danger" type="button" onClick={remove} disabled={saving}><I n="trash" />Delete</button>}
            <button className="icon-btn" type="button" onClick={duplicate} disabled={saving} aria-label="Duplicate" title="Duplicate: make your own copy to change"><I n="copy" /></button>
            <button className="btn primary" type="button" style={{ flex: 1, justifyContent: "center" }} onClick={onUse}>Use template<I n="arrow" /></button>
          </>
        )}
      </div>
    </div>
  );
}

/** Whether this machine can run the template, checked with the template's own samples. */
function Ready({ e }: { e: EngineInfo }) {
  const spec = useMemo<Spec>(() => ({
    engine: e.id, mode: e.mode, prompt: e.defaults?.prompt ?? "", params: defaults(e),
    inputs: (e.defaults?.inputs ?? []).map((i) => ({ slot: i.slot, role: roleOf(e, i.slot), asset: i.asset })),
  }), [e]);
  const check = useLocalCheck(spec);
  const status = useStatus();
  const c = check.data;
  const local = status.data?.local;
  const gpu = gpuName(local?.gpu);
  const nodes = e.requires?.nodes.length ?? 0;
  const row = (ok: boolean | null, text: string, meta?: string | null) => (
    <div key={text}>
      {ok == null ? <Spinner size={14} /> : <I n={ok ? "check" : "alert"} style={ok ? undefined : { color: "var(--orange)" }} />}
      {text}{meta && <span className="mono">{meta}</span>}
    </div>
  );
  return (
    <div className="kv">
      <div className="kv-h">Ready to run</div>
      <div className="checks">
        {local && !local.comfyui ? row(false, "ComfyUI isn't answering", local.comfyui_url)
          : !c ? row(null, check.isError ? "Couldn't check ComfyUI" : "Checking your ComfyUI")
          : c.reachable === false ? row(false, c.message ?? "Couldn't reach ComfyUI")
          : [
            row(!c.missing_nodes.length, c.missing_nodes.length ? `${c.missing_nodes.length} node type${c.missing_nodes.length > 1 ? "s" : ""} missing` : "Custom nodes found", nodes ? `${nodes - c.missing_nodes.length} / ${nodes}` : null),
            row(!c.missing_models.length, c.missing_models.length ? `${c.missing_models.length} model${c.missing_models.length > 1 ? "s" : ""} missing` : "Models in place", c.missing_models[0]?.value ?? null),
            gpu ? row(true, "GPU", gpu) : null,
          ]}
      </div>
      {!!e.requires?.models.length && (
        <details className="help">
          <summary style={{ cursor: "pointer" }}>What it needs in ComfyUI</summary>
          <ul style={{ margin: "6px 0 0", paddingLeft: 16, display: "grid", gap: 4 }}>
            {e.requires.models.map((m) => (
              <li key={m.name} style={{ overflowWrap: "anywhere" }}>
                <span className="mono">{m.name}</span>{m.folder && <> · {m.folder}</>}
                {m.url && <> · <a href={m.url} target="_blank" rel="noreferrer noopener" style={{ color: "var(--violet)" }}>download</a></>}
              </li>
            ))}
          </ul>
          {!!nodes && <p className="mono" style={{ margin: "6px 0 0", overflowWrap: "anywhere" }}>{e.requires.nodes.join(" · ")}</p>}
        </details>
      )}
    </div>
  );
}

/** Prompt ideas: a short name on the chip, the whole prompt it puts in the box. */
function IdeasEditor({ ideas, seed, onChange }: { ideas: PromptIdea[]; seed: string; onChange: (ideas: PromptIdea[]) => void }) {
  const put = (i: number, ch: Partial<PromptIdea>) => onChange(ideas.map((x, k) => (k === i ? { ...x, ...ch } : x)));
  return (
    <div className="ofield">
      <label>Ideas</label>
      {ideas.map((x, i) => (
        <div key={i} style={{ display: "grid", gap: 6, padding: 10, border: "1px solid var(--line)", borderRadius: 10 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <input className="input" aria-label={`Idea ${i + 1} name`} placeholder="Chip name" value={x.label} maxLength={40} onChange={(ev) => put(i, { label: ev.target.value })} />
            <button className="icon-btn sm" type="button" aria-label={`Remove idea ${i + 1}`} onClick={() => onChange(ideas.filter((_, k) => k !== i))}><I n="x" /></button>
          </div>
          <textarea className="textarea" aria-label={`Idea ${i + 1} prompt`} rows={fit(x.text, 10)} value={x.text} maxLength={4000} onChange={(ev) => put(i, { text: ev.target.value })} />
        </div>
      ))}
      {ideas.length < 12 && (
        <button className="btn sm ghost" type="button" style={{ justifySelf: "start" }} onClick={() => onChange([...ideas, { label: "", text: seed }])}><I n="plus" />Add idea</button>
      )}
      <p className="help">Shown as Try chips over the prompt. Each one fills the box with its whole prompt. New ones start from the default.</p>
    </div>
  );
}

function CoverBox({ e, onUse }: { e: EngineInfo; onUse: () => void }) {
  const { busy, reset } = useCoverActions(e);
  if (e.draft) {
    return (
      <div className="kv">
        <div className="kv-h">Cover</div>
        <div className="draft-note"><I n="info" /><p><b>Draft. Not on Explore yet.</b> Run it once, then publish your best result. That result becomes the cover.</p></div>
        <button className="btn primary" type="button" style={{ justifyContent: "center" }} onClick={onUse}><I n="play" />Run it</button>
      </div>
    );
  }
  return (
    <div className="kv">
      <div className="kv-h">Cover</div>
      <p className="help">A cover is always a real result. Open a finished run of this template and choose <b>Use as template cover</b>.</p>
      {e.cover_custom && !e.built && <button className="btn ghost sm" type="button" style={{ justifySelf: "start" }} onClick={reset} disabled={busy}>{busy ? <Spinner size={13} /> : <I n="undo" />}Use the shipped cover</button>}
    </div>
  );
}
