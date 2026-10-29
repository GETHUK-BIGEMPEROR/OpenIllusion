// Create's left panel: the template header, the prompt, settings summary, and the Run bar.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx, I, useStatus, gpuName } from "../../components/oi";
import { useLocalCheck, useRunner } from "../../components/Studio";
import { TemplateTools, tplModel, tplName, useCoverActions } from "../../components/TemplateCard";
import { Spinner } from "../../components/ui";
import { api, type EngineInfo, type ParamSpec, type Spec } from "../../lib/api";
import { mediaFields, mentions, noNames, promptField, type MediaField, type Mention } from "../../lib/fields";
import { errMsg } from "../../lib/format";
import { Mentions } from "../../components/Mentions";
import { go } from "../../lib/route";
import { clipIn, slotOf, soundIn, useApp, type StudioState } from "../../lib/store";
import { useRuns } from "./History";
import { FAILED, type SetS } from "./shared";

export function advSummary(params: ParamSpec[], s: StudioState) {
  const steps = params.find((p) => p.key === "steps");
  const seed = params.find((p) => p.type === "seed");
  const parts = [];
  if (steps) parts.push(`${s.params.steps ?? steps.default} steps`);
  if (seed) { const v = Number(s.params[seed.key] ?? -1); parts.push(v < 0 ? "random seed" : `seed ${v}`); }
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ recipe */

/** `run`: the finished run of this template on the stage, if one is; a draft publishes with it. */
export function Hero({ e, run }: { e: EngineInfo; run?: string | null }) {
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
          : <span aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 90% at 100% 0%,rgba(255,79,163,.18),transparent 60%),linear-gradient(160deg,#261F3A,#141120)" }} />}
        <div className="thero-cap"><h2>{tplName(e)}</h2><p><i className={cx("dot", e.kind !== "local" && "violet")} />{tplModel(e)} · {where}{e.origin === "user" && <span className="pill mine">Yours</span>}</p></div>
      </div>
      <button className="btn sm glass change" type="button" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}><I n="refresh" />Change</button>
      {open && (
        <div className="tmenu" role="listbox" aria-label="Templates">
          {list.map((x) => (
            <button key={x.id} type="button" role="option" aria-selected={x.id === e.id} aria-current={x.id === e.id}
              onClick={() => { setOpen(false); if (x.id !== e.id) openTemplate(e.mode, x.id); }}>
              {x.cover ? <img src={x.cover} alt="" /> : <span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n={x.mode === "motion" ? "film" : "image"} /></span>}
              {tplName(x)}<small>{x.draft ? `Draft · ${tplModel(x)}` : tplModel(x)}{x.origin === "user" ? " · Yours" : ""}</small>
            </button>
          ))}
          <button type="button" onClick={() => { setOpen(false); openTemplate(e.mode, e.id); }}><span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n="undo" /></span>Start over with the samples</button>
          <button type="button" onClick={() => { setOpen(false); go({ name: "explore", t: e.id }); }}><span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n="compass" /></span>Browse all on Explore</button>
        </div>
      )}
      {e.draft && <DraftBar e={e} run={run} />}
      <TemplateTools e={e} />
      {e.blurb && <p className="thero-blurb">{e.blurb}</p>}
    </div>
  );
}

/** A template saved in the Builder and not published yet: it is only here, in Create, until a finished run of it
 *  shows it works. Publish puts it on Explore; that run becomes its cover when it has none. */
function DraftBar({ e, run }: { e: EngineInfo; run?: string | null }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const runs = useRuns(e.id);
  const [busy, setBusy] = useState(false);
  const list = runs.data ?? [];
  const tested = run ?? list.find((g) => g.status === "done")?.id ?? null;
  const covered = !!(e.cover || e.cover_video);
  const say = tested
    ? covered ? "Tested. Publish puts it on Explore." : `Tested. Publish puts it on Explore, with ${run ? "this" : "your latest"} result as its cover.`
    : list.some((g) => g.status === "running") ? "Testing. Publish once the run is done and looks right."
    : list[0] && FAILED.has(list[0].status) ? "Its last run failed. Fix what went wrong and run it again."
    : "Run it once to test it. Only a template that works goes on Explore.";
  const publish = async () => {
    if (!tested) return;
    setBusy(true);
    try {
      const next = await api.publishTemplate(e.id, tested);
      qc.setQueryData<EngineInfo[]>(["engines"], (l) => l?.map((x) => (x.id === next.id ? next : x)));
      toast({ text: `${tplName(e)} is published on Explore.`, tone: "ok", action: { label: "View", run: () => go({ name: "explore", t: e.id }) } });
    } catch (x) {
      toast({ text: `Couldn't publish: ${errMsg(x)}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx("draftbar", tested && "ok")} role="status">
      <span className="pill draftp"><i className="dot" />Draft</span>
      <p><b>Not on Explore yet.</b> {say}</p>
      <button className="btn sm primary" type="button" disabled={!tested || busy} onClick={() => void publish()}
        title={tested ? "Put it on Explore" : "Run it once first: only a tested template can be published"}>
        {busy ? <Spinner size={13} /> : <I n="compass" />}<span className="lbl">Publish</span>
      </button>
    </div>
  );
}

/** Any finished run of this template, a draft's too: its result becomes the cover. Loud while there's none. */
export function UseAsCover({ e, run }: { e: EngineInfo; run: string }) {
  const { busy, fromRun } = useCoverActions(e);
  const none = !e.cover && !e.cover_video;
  return (
    <button className={cx("btn sm", none ? "primary" : "ghost")} type="button" disabled={busy} onClick={() => void fromRun(run)}
      title={none ? "This result becomes the template's cover" : "This result replaces the template's cover"}>
      {busy ? <Spinner size={13} /> : <I n="image" />}<span className="lbl">Use as cover</span>
    </button>
  );
}

/** The prompt, whole: what's in the box is what the workflow gets. */
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
  const files = engine?.kind === "cloud" ? filled(engine, s) : [];
  const named = engine?.kind === "cloud" && !!Object.keys(engine.mentions ?? {}).length;
  const def = pf.default ?? engine?.defaults?.prompt ?? "";
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
        <div className="pbox-foot">{named ? <span title={`Image 1, Video 1… go to ${tplModel(engine!)} in its own form, such as ${(engine!.mentions!.image ?? Object.values(engine!.mentions!)[0]).replace("{n}", "1")}`}>Names sent in {tplModel(engine!)}'s form</span> : <span>Sent exactly as written</span>}<kbd>Ctrl</kbd><kbd>↵</kbd><span>runs</span></div>
      </div>
      {engine?.kind === "cloud" && <Mentions list={mentions(engine.mentions, files)} none={noNames(engine.mentions, files, tplModel(engine))} model={tplModel(engine)} ta={ta} value={s.prompt} onChange={(v) => set({ prompt: v })} />}
    </section>
  );
}

/** The run's filled photos, clips and sounds, in the template's order (the order the request carries them). */
function filled(e: EngineInfo, s: StudioState): Omit<Mention, "token" | "name">[] {
  return mediaFields(e).flatMap((f): Omit<Mention, "token" | "name">[] => {
    if (f.type === "video") {
      const c = clipIn(s, f.key);
      return c && !c.missing ? [{ key: f.key, kind: "video", label: f.label, thumb: c.poster ?? null }] : [];
    }
    if (f.type === "audio") {
      const x = soundIn(s, f.key);
      return x?.url && !x.missing ? [{ key: f.key, kind: "audio", label: f.label }] : [];
    }
    const r = s.refs.find((r, k) => `image:${slotOf(r, k)}` === f.key && r.url && !r.missing);
    return r ? [{ key: f.key, kind: "image", label: f.label, thumb: r.url }] : [];
  });
}

/** Pinned under the recipe: how many, what's in the way, Run. */
export function RunBar({ s, set, engine, spec, runner, queued, varies }: {
  s: StudioState; set: SetS; engine?: EngineInfo; spec: Spec; runner: ReturnType<typeof useRunner>; queued: number; varies: boolean;
}) {
  const status = useStatus();
  // The same check LocalNeeds shows the missing list from; here only its all-clear.
  const check = useLocalCheck(spec).data;
  const found = !!check && check.reachable !== false && !check.missing_nodes.length && !check.missing_models.length && !check.bad_values.length;
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
        {missing ? (
          <span className="warn"><I n="alert" />Add {missing.label} to run</span>
        ) : reasons.length ? (
          <span className="warn" title={reasons.join("\n")}><I n="alert" />{reasons[0]}{reasons.length > 1 ? ` · +${reasons.length - 1} more` : ""}</span>
        ) : runner.isLocal ? (
          <span className="rdy"><i className="dot" />{gpu ?? "Your ComfyUI"}<em>{queued ? `${queued} in queue` : "free"}</em>
            {found && <span className="ok" title="Every node and model this workflow uses is in your ComfyUI"><I n="check" size={12} />Models found</span>}</span>
        ) : (
          <span className="rdy"><i className="dot violet" />Comfy Router{queued ? <em>{queued} in queue</em> : null}</span>
        )}
      </div>
      <div className="rb-row">
        <div className="rb-count" role="group" aria-label="Variants, one seed each"
          title={varies ? "Variants, one seed each" : "This workflow uses a fixed seed, so each run makes one result"}>
          {[1, 2, 3, 4].map((v) => <button key={v} type="button" aria-pressed={s.variants === v} disabled={!varies && v > 1} onClick={() => set({ variants: v })}>{v}</button>)}
        </div>
        <button className="run" type="button" disabled={runner.blocked || !!missing} onClick={() => void runner.run()} aria-keyshortcuts="Control+Enter R">
          {runner.busy ? <Spinner /> : <I n="zap" />}{s.variants > 1 ? `Run ${s.variants} variants` : "Run"}<kbd>R</kbd>
        </button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- history */
