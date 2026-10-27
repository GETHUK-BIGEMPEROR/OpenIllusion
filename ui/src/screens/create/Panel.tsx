// Create's left panel: the template header, the prompt, settings summary, and the Run bar.
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CostPill } from "../../components/bits";
import { cx, I, useStatus, gpuName } from "../../components/oi";
import { useCompose, useRunner } from "../../components/Studio";
import { TemplateTools, tplModel, tplName, useCoverActions } from "../../components/TemplateCard";
import { Spinner } from "../../components/ui";
import { api, type EngineInfo, type ParamSpec } from "../../lib/api";
import { mediaFields, promptField, type MediaField } from "../../lib/fields";
import { go } from "../../lib/route";
import { clipIn, slotOf, soundIn, useApp, type StudioState } from "../../lib/store";
import type { SetS } from "./shared";

export function advSummary(params: ParamSpec[], s: StudioState) {
  const steps = params.find((p) => p.key === "steps");
  const seed = params.find((p) => p.type === "seed");
  const parts = [];
  if (steps) parts.push(`${s.params.steps ?? steps.default} steps`);
  if (seed) { const v = Number(s.params[seed.key] ?? -1); parts.push(v < 0 ? "random seed" : `seed ${v}`); }
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ recipe */

export function Hero({ e }: { e: EngineInfo }) {
  const [open, setOpen] = useState(false);
  const openTemplate = useApp((s) => s.openTemplate);
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const status = useStatus();
  const list = (engines.data ?? []).filter((x) => x.mode === e.mode);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const on = (ev: PointerEvent) => { if (!ref.current?.contains(ev.target as Node)) setOpen(false); };
    const key = (ev: KeyboardEvent) => { if (ev.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", on);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("pointerdown", on); window.removeEventListener("keydown", key); };
  }, [open]);
  const where = e.kind === "local" ? (gpuName(status.data?.local.gpu) ? `Your GPU` : "Local") : "Comfy Router";
  return (
    <div className="thero" ref={ref}>
      <div className="thero-img">
        {e.cover_video ? <video src={e.cover_video} poster={e.cover ?? undefined} muted loop playsInline autoPlay aria-hidden style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 22%" }} />
          : e.cover ? <img src={e.cover} alt="" />
          : <span aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 90% at 100% 0%,rgba(242,255,89,.18),transparent 60%),linear-gradient(160deg,#30233a,#1c1622)" }} />}
        <div className="thero-cap"><h2>{tplName(e)}</h2><p><i className={cx("dot", e.kind !== "local" && "violet")} />{tplModel(e)} · {where}</p></div>
      </div>
      <button className="btn sm glass change" type="button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}><I n="refresh" />Change</button>
      {open && (
        <div className="tmenu" role="listbox" aria-label="Templates">
          {list.map((x) => (
            <button key={x.id} type="button" role="option" aria-selected={x.id === e.id} aria-current={x.id === e.id}
              onClick={() => { setOpen(false); if (x.id !== e.id) openTemplate(e.mode, x.id); }}>
              {x.cover ? <img src={x.cover} alt="" /> : <span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n={x.mode === "motion" ? "film" : "image"} /></span>}
              {tplName(x)}{x.draft && <em className="tdraft" title="Not on Explore yet. Run it, then Publish the result you like.">Draft</em>}<small>{tplModel(x)}</small>
            </button>
          ))}
          <button type="button" onClick={() => { setOpen(false); openTemplate(e.mode, e.id); }}><span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n="undo" /></span>Start over with the samples</button>
          <button type="button" onClick={() => { setOpen(false); go({ name: "explore", t: e.id }); }}><span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n="compass" /></span>Browse all on Explore</button>
        </div>
      )}
      <TemplateTools e={e} />
      {e.draft && <div className="draft-note"><I n="info" /><p><b>Draft. Not on Explore yet.</b> Run it, then press Publish on the result you like. That result becomes its cover.</p></div>}
      {e.blurb && <p className="thero-blurb">{e.blurb}</p>}
    </div>
  );
}

/** Puts a draft on the wall, with this run's result as its cover. */
export function Publish({ e, run }: { e: EngineInfo; run: string }) {
  const { busy, fromRun } = useCoverActions(e);
  return (
    <button className="btn sm primary" type="button" disabled={busy} onClick={() => void fromRun(run)} title="This result becomes the cover and the template goes on Explore">
      {busy ? <Spinner size={13} /> : <I n="upload" />}<span className="lbl">Publish</span>
    </button>
  );
}

/** The prompt, whole: what's in the box is what the workflow gets. Ideas swap in a complete prompt. */
export function PromptSection({ s, set, engine, invalid, onRun }: {
  s: StudioState; set: SetS; engine?: EngineInfo; invalid: boolean; onRun: () => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  // Fit the box to its text; again when the panel's width changes or the fonts arrive.
  const fit = () => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight + 2, 420)}px`;
  };
  useLayoutEffect(fit, [s.prompt]);
  useEffect(() => {
    const t = ta.current;
    if (!t) return;
    let w = t.clientWidth;
    const ro = new ResizeObserver(() => { if (t.clientWidth !== w) { w = t.clientWidth; fit(); } });
    ro.observe(t);
    void document.fonts?.ready.then(fit);
    return () => ro.disconnect();
  }, []);
  const pf = promptField(engine);
  if (!pf) return null;
  const def = pf.default ?? engine?.defaults?.prompt ?? "";
  const ideas = pf.examples ?? [];
  return (
    <section className="sec" aria-labelledby="sec-prompt">
      <div className="sec-h">
        <h4 id="sec-prompt">Prompt{pf.required === false && <span className="opt"> · optional</span>}</h4>
        {def && s.prompt !== def
          ? <button className="sec-act" type="button" onClick={() => set({ prompt: def })} title="Put the template's prompt back"><I n="undo" />Reset</button>
          : <span className="mono">{s.prompt.length}</span>}
      </div>
      <div className={cx("pbox", invalid && s.prompt.trim() && "bad")}>
        <textarea ref={ta} id="prompt" aria-labelledby="sec-prompt" rows={4} spellCheck value={s.prompt} placeholder="Describe what you want."
          onChange={(e) => set({ prompt: e.target.value })}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); onRun(); } }} />
        <div className="pbox-foot"><span>Sent exactly as written</span><kbd>Ctrl</kbd><kbd>↵</kbd><span>runs</span></div>
      </div>
      {!!ideas.length && (
        <div className="ideas" role="group" aria-label="Prompt ideas">
          {ideas.map((x) => <button key={x.label} className="ex" type="button" title={x.text} aria-pressed={s.prompt === x.text} onClick={() => set({ prompt: x.text })}>{x.label}</button>)}
        </div>
      )}
    </section>
  );
}

/** Pinned under the recipe: how many, what's in the way, Run. */
export function RunBar({ s, set, engine, runner, estimate, queued, varies }: {
  s: StudioState; set: SetS; engine?: EngineInfo; runner: ReturnType<typeof useRunner>; estimate?: ReturnType<typeof useCompose>["estimate"]; queued: number; varies: boolean;
}) {
  const status = useStatus();
  const media = mediaFields(engine);
  const held = (f: MediaField) => f.type === "audio" ? !!soundIn(s, f.key)?.url && !soundIn(s, f.key)!.missing : f.type === "video"
    ? !!clipIn(s, f.key) && !clipIn(s, f.key)!.missing
    : s.refs.some((r, k) => `image:${slotOf(r, k)}` === f.key && r.url && !r.missing);
  const missing = media.find((f) => f.required !== false && !held(f));
  const gpu = gpuName(status.data?.local.gpu);
  const reasons = missing ? [] : runner.reasons;
  return (
    <div className="runbar">
      <div className="rb-status" aria-live="polite">
        {runner.confirm ? (
          <span className="warn" role="alertdialog" aria-label="Unknown cost">
            <I n="alert" />Router can't price this run.
            <button className="btn sm" type="button" onClick={() => void runner.run(true)} autoFocus>Run anyway</button>
            <button className="btn sm ghost" type="button" onClick={() => runner.setConfirm(false)}>Cancel</button>
          </span>
        ) : missing ? (
          <span className="warn"><I n="alert" />Add {missing.label} to run</span>
        ) : reasons.length ? (
          <span className="warn" title={reasons.join("\n")}><I n="alert" />{reasons[0]}{reasons.length > 1 ? ` · +${reasons.length - 1} more` : ""}</span>
        ) : runner.isLocal ? (
          <span className="rdy"><i className="dot" />{gpu ?? "Your ComfyUI"}<em>{queued ? `${queued} in queue` : "free"}</em></span>
        ) : (
          <span className="rdy"><i className="dot violet" />Comfy Router<CostPill estimate={estimate} times={s.variants} /></span>
        )}
      </div>
      <div className="rb-row">
        {varies && <div className="rb-count" role="group" aria-label="Variants, one seed each" title="Variants, one seed each">
          {[1, 2, 3, 4].map((v) => <button key={v} type="button" aria-pressed={s.variants === v} onClick={() => set({ variants: v })}>{v}</button>)}
        </div>}
        <button className="run" type="button" disabled={runner.blocked || !!missing} onClick={() => void runner.run()} aria-keyshortcuts="Control+Enter R">
          {runner.busy ? <Spinner /> : <I n="zap" />}{s.variants > 1 ? `Run ${s.variants} variants` : "Run"}<kbd>R</kbd>
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- history */
