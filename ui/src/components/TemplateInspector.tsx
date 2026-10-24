import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { api, type EngineInfo, type TemplatePatch } from "../lib/api";
import { errMsg } from "../lib/format";
import { useApp } from "../lib/store";
import { ArrowRight, Brush, Close, External, ImageIcon, Motion, Refresh } from "./Icons";
import { clampAspect } from "./Masonry";
import { COVER_ACCEPT, useCoverActions } from "./TemplateCard";
import { Badge, Button, Field, IconButton, Notice, Spinner, TextArea, TextInput } from "./ui";

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

/** Right-hand panel on the Templates shelf: everything about one template, editable in place. */
export function TemplateInspector({ e, locked, onUse, onClose }: { e: EngineInfo; locked: string | null; onUse: () => void; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [d, setD] = useState<Draft>(() => drafts.get(e.id) ?? draftOf(e));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const patch = patchOf(e, d);
  const dirty = Object.keys(patch).length > 0;
  const editable = e.kind === "local" && !!e.origin;

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
      } else if (ev.key === "Escape" && !(ev.target as HTMLElement)?.closest?.("input,textarea,[role=menu],[data-radix-popper-content-wrapper]")) {
        onClose();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);

  const ModeIcon = e.mode === "motion" ? Motion : Brush;
  const sample = d.defaultPrompt.trim() || lines(d.examples)[0] || d.promptHint || "your prompt";

  return (
    <aside aria-label={`${e.label} details`} className="w-[392px] shrink-0 border-l border-line bg-bg flex flex-col min-h-0 animate-slide">
      <header className="shrink-0 h-12 pl-4 pr-2 flex items-center gap-2 border-b border-line">
        <ModeIcon size={15} className="text-muted shrink-0" />
        <h2 className="m-0 text-base font-semibold truncate flex-1">{e.label}</h2>
        {dirty && <span className="text-xs text-orange-text whitespace-nowrap" aria-live="polite">Unsaved</span>}
        <IconButton label="Close details" onClick={onClose}><Close size={15} /></IconButton>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scroll-y">
        <div className="p-4 flex flex-col gap-4">
          <CoverBox e={e} />

          <div className="flex flex-wrap items-center gap-1.5">
            <Badge dot={e.kind === "local" ? "#F2FF59" : "#9A86F0"}>{e.kind}</Badge>
            <Badge>{e.mode}</Badge>
            {e.origin === "user" && !e.edited && <Badge>Your template</Badge>}
            {e.edited && <Badge tone="orange">Edited</Badge>}
            {(e.tags ?? []).map((t) => <Badge key={t} className="text-muted">#{t}</Badge>)}
          </div>

          {locked && <Notice tone="warn" title="Needs setup">{locked}</Notice>}
          <Button tone="primary" onClick={onUse} className="w-full justify-center">
            Open in {e.mode === "motion" ? "Motion" : "Edit"} studio<ArrowRight size={14} />
          </Button>

          {!editable ? (
            <p className="m-0 text-sm text-muted leading-[1.5]">{e.blurb}</p>
          ) : (
            <>
              <Group title="Details">
                <Field label="Name" htmlFor="ti-label"><TextInput id="ti-label" value={d.label} onChange={set("label")} maxLength={80} /></Field>
                <Field label="Description" htmlFor="ti-blurb">
                  <TextArea id="ti-blurb" rows={3} value={d.blurb} onChange={set("blurb")} maxLength={400} className="text-sm resize-y" />
                </Field>
                <Field label="Tags" htmlFor="ti-tags" hint="Comma separated."><TextInput id="ti-tags" value={d.tags} onChange={set("tags")} /></Field>
              </Group>

              <Group title="Prompt box" aside={e.prompt?.required === false ? "Optional for this template" : undefined}>
                <Field label="Default prompt" htmlFor="ti-pdef" hint="What the prompt box opens with. Tested with the samples under Inputs.">
                  <TextArea id="ti-pdef" rows={2} value={d.defaultPrompt} onChange={set("defaultPrompt")} maxLength={400} className="text-sm resize-y" />
                </Field>
                <Field label="Label" htmlFor="ti-plabel"><TextInput id="ti-plabel" value={d.promptLabel} onChange={set("promptLabel")} maxLength={40} /></Field>
                <Field label="Placeholder" htmlFor="ti-phint"><TextInput id="ti-phint" value={d.promptHint} onChange={set("promptHint")} maxLength={160} /></Field>
                <Field label="Examples" htmlFor="ti-ex" hint="One per line. Shown as quick picks under the prompt.">
                  <TextArea id="ti-ex" rows={fit(d.examples)} value={d.examples} onChange={set("examples")} className="text-sm resize-y" />
                </Field>
                <Field label="Tips" htmlFor="ti-tips" hint="One per line.">
                  <TextArea id="ti-tips" rows={fit(d.tips)} value={d.tips} onChange={set("tips")} className="text-sm resize-y" />
                </Field>
              </Group>

              {e.instruction && (
                <Group title="Instruction" aside="Sent to the model around the prompt">
                  {"start" in e.instruction && (
                    <Field label="Before the prompt" htmlFor="ti-start">
                      <TextArea id="ti-start" rows={3} value={d.start} onChange={set("start")} maxLength={2000} className="text-sm resize-y" />
                    </Field>
                  )}
                  {"end" in e.instruction && (
                    <Field label="After the prompt" htmlFor="ti-end">
                      <TextArea id="ti-end" rows={5} value={d.end} onChange={set("end")} maxLength={2000} className="text-sm resize-y" />
                    </Field>
                  )}
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted">What the model reads</span>
                    <p className="m-0 p-2.5 rounded-lg bg-surface border border-line text-sm leading-[1.55] text-soft whitespace-pre-wrap break-words">
                      {d.start}<mark className="bg-yellow/15 text-yellow rounded px-0.5">{sample}</mark>{d.end}
                    </p>
                  </div>
                </Group>
              )}
            </>
          )}

          {!!e.inputs?.length && (
            <Group title="Inputs">
              <ul className="m-0 p-0 list-none flex flex-col gap-2">
                {e.inputs.map((i, n) => {
                  const sampleIn = e.defaults?.inputs.find((x) => x.slot === i.slot);
                  return (
                    <li key={i.slot} className="flex gap-2.5 items-start">
                      {sampleIn ? (
                        <img src={sampleIn.url} alt={`Sample ${(i.label ?? "input").toLowerCase()}`} loading="lazy" className="w-11 h-11 shrink-0 rounded-md object-cover bg-raised ring-1 ring-inset ring-white/[0.06]" />
                      ) : (
                        <span className="w-5 h-5 shrink-0 rounded-md bg-active text-xs font-mono text-soft flex items-center justify-center">{n + 1}</span>
                      )}
                      <span className="flex flex-col min-w-0">
                        <span className="text-sm text-text"><span className="font-mono text-xs text-faint">Image {n + 1} · </span>{i.label ?? i.slot}</span>
                        {i.hint && <span className="text-xs text-muted">{i.hint}</span>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </Group>
          )}

          {!!e.requires?.models.length && (
            <Group title="Needs in ComfyUI" aside={`${e.requires.nodes.length} node types`}>
              <ul className="m-0 p-0 list-none flex flex-col gap-1.5">
                {e.requires.models.map((m) => (
                  <li key={m.name} className="flex items-center gap-2 min-w-0 text-sm">
                    <span className="font-mono text-xs text-soft truncate" title={m.name}>{m.name}</span>
                    {m.folder && <span className="shrink-0 text-xs text-faint">{m.folder}</span>}
                    {m.url && (
                      <a href={m.url} target="_blank" rel="noreferrer noopener" className="ml-auto shrink-0 text-muted hover:text-text" aria-label={`Download ${m.name}`}>
                        <External size={13} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
              <details className="text-xs text-muted">
                <summary className="cursor-pointer hover:text-soft select-none">Node types</summary>
                <p className="m-0 mt-1.5 font-mono leading-[1.6] break-words">{e.requires.nodes.join(" · ")}</p>
              </details>
            </Group>
          )}

          <p className="m-0 text-xs text-faint leading-[1.5] break-words">
            <span className="font-mono">{e.id}</span>
            {e.source && <> · {e.source}</>}
          </p>
        </div>
      </div>

      {editable && (dirty || e.edited || err) && (
        <footer className="shrink-0 p-3 border-t border-line flex flex-col gap-2 bg-bg">
          {err && <p role="alert" className="m-0 text-xs text-rose-text">{err}</p>}
          <div className="flex items-center gap-2">
            {e.edited && !dirty && (
              <Button tone="ghost" size="sm" onClick={resetAll} disabled={saving}><Refresh size={13} />Reset to shipped</Button>
            )}
            {dirty && (
              <>
                <Button tone="ghost" size="sm" onClick={() => { setD(draftOf(e)); setErr(null); }} disabled={saving}>Discard</Button>
                <Button tone="primary" size="sm" onClick={save} disabled={saving} className="ml-auto">
                  {saving && <Spinner size={12} />}Save changes
                </Button>
              </>
            )}
          </div>
        </footer>
      )}
    </aside>
  );
}

function Group({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 pt-4 border-t border-line">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id={id} className="m-0 text-xs2 uppercase tracking-wide font-semibold text-muted">{title}</h3>
        {aside && <span className="text-xs text-faint">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

function CoverBox({ e }: { e: EngineInfo }) {
  const file = useRef<HTMLInputElement>(null);
  const { busy, upload, reset } = useCoverActions(e);
  const aspect = Math.max(clampAspect(e.cover ? e.cover_aspect : undefined), 4 / 5);
  return (
    <div className="flex flex-col gap-2">
      <div className="relative rounded-xl overflow-hidden bg-surface ring-1 ring-inset ring-white/[0.06] max-h-[300px]" style={{ aspectRatio: aspect }}>
        {e.cover_video ? (
          <video key={e.cover_video} src={e.cover_video} poster={e.cover ?? undefined} muted loop playsInline autoPlay aria-hidden className="absolute inset-0 w-full h-full object-cover" />
        ) : e.cover ? (
          <img key={e.cover} src={e.cover} alt="" className="absolute inset-0 w-full h-full object-cover" />
        ) : (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-faint text-sm">
            <ImageIcon size={22} />No cover yet
          </span>
        )}
        {busy && <span className="absolute inset-0 bg-black/40 flex items-center justify-center"><Spinner size={18} /></span>}
      </div>
      <input ref={file} type="file" accept={COVER_ACCEPT} hidden onChange={(ev) => { upload(ev.target.files?.[0]); ev.target.value = ""; }} />
      <div className="flex items-center gap-2">
        <Button size="sm" tone="secondary" onClick={() => file.current?.click()} disabled={busy}><ImageIcon size={13} />{e.cover ? "Change cover" : "Set cover"}</Button>
        {e.cover_custom && <Button size="sm" tone="ghost" onClick={reset} disabled={busy}>Reset</Button>}
        <span className="ml-auto text-xs text-faint">Image or ≤8 s video</span>
      </div>
    </div>
  );
}
