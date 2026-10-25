import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type EngineInfo, type Spec, type TemplatePatch } from "../lib/api";
import { errMsg } from "../lib/format";
import { defaults } from "../lib/spec";
import { useApp } from "../lib/store";
import { clampAspect } from "./Masonry";
import { Compare, gpuName, I, useStatus } from "./oi";
import { useLocalCheck } from "./Studio";
import { COVER_ACCEPT, tplModel, tplName, useCoverActions } from "./TemplateCard";
import { Spinner } from "./ui";

interface Draft {
  label: string;
  blurb: string;
  tags: string;
  promptLabel: string;
  promptHint: string;
  start: string;
  end: string;
  examples: string;
  tips: string;
  defaultPrompt: string;
}

const draftOf = (e: EngineInfo): Draft => ({
  label: e.label,
  blurb: e.blurb ?? "",
  tags: (e.tags ?? []).join(", "),
  promptLabel: e.prompt?.label ?? "",
  promptHint: e.prompt?.hint ?? "",
  start: e.instruction?.start ?? "",
  end: e.instruction?.end ?? "",
  examples: (e.examples ?? []).join("\n"),
  tips: (e.tips ?? []).join("\n"),
  defaultPrompt: e.defaults?.prompt ?? "",
});

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const fit = (s: string) => Math.min(8, Math.max(3, s.split("\n").length + 1));
const commas = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

/** Only what changed goes to the server, so an untouched field never gets rewritten. */
function patchOf(e: EngineInfo, d: Draft): TemplatePatch {
  const base = draftOf(e);
  const p: TemplatePatch = {};
  if (d.label !== base.label) p.label = d.label;
  if (d.blurb !== base.blurb) p.blurb = d.blurb;
  if (d.tags !== base.tags) p.tags = commas(d.tags);
  if (d.examples !== base.examples) p.examples = lines(d.examples);
  if (d.tips !== base.tips) p.tips = lines(d.tips);
  if (d.defaultPrompt !== base.defaultPrompt) p.default_prompt = d.defaultPrompt;
  if (d.promptLabel !== base.promptLabel || d.promptHint !== base.promptHint) p.prompt = { label: d.promptLabel, hint: d.promptHint };
  if (e.instruction && (d.start !== base.start || d.end !== base.end)) {
    p.instruction = {};
    if (d.start !== base.start) p.instruction.start = d.start;
    if (d.end !== base.end) p.instruction.end = d.end;
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
  const editable = e.kind === "local" && !!e.origin;
  const [editing, setEditing] = useState(() => drafts.has(e.id));
  const patch = patchOf(e, d);
  const dirty = Object.keys(patch).length > 0;

  useEffect(() => {
    if (dirty) drafts.set(e.id, d);
    else drafts.delete(e.id);
  }, [e.id, d, dirty]);

  const set = <K extends keyof Draft>(k: K) => (ev: { target: { value: string } }) => setD((x) => ({ ...x, [k]: ev.target.value }));
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

  const sample = d.defaultPrompt.trim() || lines(d.examples)[0] || d.promptHint || "your prompt";
  const samples = e.defaults?.inputs ?? [];
  const lead = samples.find((x) => x.slot === "image:1");
  const ar = Math.max(clampAspect(e.cover ? e.cover_aspect : lead?.width && lead?.height ? lead.width / lead.height : 4 / 5), 4 / 5);
  const ideas = (e.examples ?? []).filter((x) => x !== e.defaults?.prompt);

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
            : <div className="empty" style={{ padding: 30 }}><div className="empty-ic"><I n="image" /></div><h3>No cover yet</h3></div>}
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
              <p>{tplModel(e)} · {e.mode === "motion" ? "Motion" : "Edit"} · {e.kind === "local" ? "Runs on your GPU" : "Runs on Comfy Router"}{e.edited ? " · Edited" : e.origin === "user" ? " · Yours" : ""}</p>
            </div>
            {e.blurb && <p className="insp-blurb">{e.blurb}</p>}
          </>
        )}
        {locked && <div className="errbox"><b>Needs setup</b><p>{locked}</p></div>}

        {!!e.inputs?.length && (
          <div className="kv">
            <div className="kv-h">Inputs<span>{e.inputs.length} photo{e.inputs.length > 1 ? "s" : ""}</span></div>
            {e.inputs.map((x, n) => {
              const sm = samples.find((y) => y.slot === x.slot);
              return (
                <div key={x.slot} className="inrow">
                  {sm ? <img src={sm.url} alt="" loading="lazy" /> : <span className="empty-ic" style={{ width: 44, height: 44, margin: 0, borderRadius: 9 }}><I n="image" /></span>}
                  <div><b>Image {n + 1} · {x.label ?? x.slot}</b><span>{x.hint ?? (sm ? "Sample included" : "Your photo")}</span></div>
                </div>
              );
            })}
          </div>
        )}

        <div className="kv">
          <div className="kv-h">{d.promptLabel || "Prompt"}<span>{e.prompt?.required === false ? "Optional" : "Default"}</span></div>
          {editing ? (
            <>
              <textarea className="textarea" aria-label="Default prompt" rows={2} value={d.defaultPrompt} onChange={set("defaultPrompt")} maxLength={400} />
              <p className="help" style={{ marginTop: -4 }}>What the prompt box opens with. Tested with the samples above.</p>
              <Field id="ti-plabel" label="Prompt label"><input className="input" id="ti-plabel" value={d.promptLabel} onChange={set("promptLabel")} maxLength={40} /></Field>
              <Field id="ti-phint" label="Placeholder"><input className="input" id="ti-phint" value={d.promptHint} onChange={set("promptHint")} maxLength={160} /></Field>
              <Field id="ti-ex" label="Ideas" help="One per line. Shown as Try chips over the prompt."><textarea className="textarea" id="ti-ex" rows={fit(d.examples)} value={d.examples} onChange={set("examples")} /></Field>
              <Field id="ti-tips" label="Tips" help="One per line."><textarea className="textarea" id="ti-tips" rows={fit(d.tips)} value={d.tips} onChange={set("tips")} /></Field>
            </>
          ) : (
            <>
              <div className="quote">{e.defaults?.prompt || <span style={{ color: "var(--text-3)" }}>No default prompt</span>}</div>
              {!!ideas.length && <div className="examples">{ideas.map((x) => <span key={x} className="ex">{x}</span>)}</div>}
            </>
          )}
        </div>

        {e.instruction && (editing || d.start || d.end) && (
          <div className="kv">
            <div className="kv-h">What the model reads</div>
            {editing && "start" in e.instruction && (
              <Field id="ti-start" label="Before the prompt"><textarea className="textarea" id="ti-start" rows={3} value={d.start} onChange={set("start")} maxLength={2000} /></Field>
            )}
            {editing && "end" in e.instruction && (
              <Field id="ti-end" label="After the prompt"><textarea className="textarea" id="ti-end" rows={5} value={d.end} onChange={set("end")} maxLength={2000} /></Field>
            )}
            <p className="quote" style={{ margin: 0, fontSize: 12.5, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {d.start}<mark style={{ background: "rgba(242,255,89,.15)", color: "var(--yellow)", borderRadius: 4, padding: "0 2px" }}>{sample}</mark>{d.end}
            </p>
          </div>
        )}

        {!editing && !!e.tips?.length && (
          <div className="kv"><div className="kv-h">Tips</div><ul className="help" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>{e.tips.map((t) => <li key={t}>{t}</li>)}</ul></div>
        )}
        {!editing && !!e.tags?.length && <div className="kv"><div className="kv-h">Tags</div><div className="tags">{e.tags.map((t) => <span key={t} className="tag">{t}</span>)}</div></div>}

        {e.kind === "local" && <Ready e={e} />}
        <CoverBox e={e} />
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
    inputs: (e.defaults?.inputs ?? []).map((i) => ({ slot: i.slot, role: i.slot === "image:1" ? "base" : "character", asset: i.asset })),
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

function CoverBox({ e }: { e: EngineInfo }) {
  const file = useRef<HTMLInputElement>(null);
  const { busy, upload, reset } = useCoverActions(e);
  return (
    <div className="kv">
      <div className="kv-h">Cover</div>
      <input ref={file} type="file" accept={COVER_ACCEPT} hidden onChange={(ev) => { upload(ev.target.files?.[0]); ev.target.value = ""; }} />
      <div className="irow">
        <button className="btn" type="button" style={{ flex: 1, justifyContent: "center" }} onClick={() => file.current?.click()} disabled={busy}>
          {busy ? <Spinner size={13} /> : <I n="image" />}{e.cover ? "Choose cover" : "Set a cover"}
        </button>
        {e.cover_custom && <button className="btn ghost" type="button" onClick={reset} disabled={busy}>Use shipped</button>}
      </div>
      <p className="help">Image, or a video up to 8 s. Any finished result can also become the cover from its menu.</p>
    </div>
  );
}
