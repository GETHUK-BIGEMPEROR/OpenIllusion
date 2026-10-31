// Create: the studio page for one template (Image or Video).
import { useQueries, useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { typing } from "../../components/ABPlayer";
import { dropIntoStudio, isMediaFile, useFileDrop } from "../../components/Drop";
import { OutputSize, useEngine, ParamFields } from "../../components/Engine";
import { cx, EmptyBox, GpuStat, I, jobProgress, KeyStat } from "../../components/oi";
import { invalidFields, LocalNeeds, NoTemplates, useCompose, useCurrent, useRunner, useStudio, type Fix } from "../../components/Studio";
import { tplName } from "../../components/TemplateCard";
import { api, isMedia, type Manifest, type Mode } from "../../lib/api";
import { clipSlots, clipWindow, fieldsOf, leadSlot, mediaFields, settingsOf, videoField } from "../../lib/fields";
import { needsFile, runInput } from "../../lib/edits";
import { errMsg } from "../../lib/format";
import { isActive, useJobs } from "../../lib/live";
import { go } from "../../lib/route";
import { autorun, clipIn, slotOf, useApp, type VideoSlot } from "../../lib/store";
import { canvasSize, dimsText, plans, usePrepImages, type PrepInput } from "../../lib/size";
import { Canvas } from "./Canvas";
import { HistList, HistStrip, useRuns } from "./History";
import { bakePending, FileCard, InputStage } from "./Inputs";
import { toSpec } from "../../lib/spec";
import { advSummary, Hero, PromptSection, RunBar, UseAsCover } from "./Panel";
import { FAILED, type View, withInput } from "./shared";

export const EditStudio = () => <CreateStudio mode="edit" />;

export const MotionStudio = () => <CreateStudio mode="motion" />;

/**
 * Create: the recipe on the left, the picture or clip in the middle, the prompt and Run under it, this template's runs
 * on the right. Everything on the left comes from the template's inputs, in its order; `mode` only says which draft
 * this is (Image or Video on Explore).
 */
function CreateStudio({ mode }: { mode: Mode }) {
  const [s, set] = useStudio(mode);
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const engine = useEngine(mode, s.engine);
  const media = mediaFields(engine);
  // The inputs list: photos, clips and sounds, in the template's order.
  const cards = fieldsOf(engine).filter(isMedia);
  const vField = videoField(engine);
  const lead = leadSlot(engine);
  const leadVideo = lead.startsWith("video:");
  const settings = settingsOf(engine);
  const { spec, compose } = useCompose(mode, s, engine);
  const { generation: m, job } = useCurrent(s.current);
  const invalid = invalidFields(compose, job?.error);
  const share = useApp((st) => st.share);
  const toast = useApp((st) => st.toast);
  const { data: jobs = [] } = useJobs();
  const [view, setView] = useState<View>("input");

  const base = leadVideo ? undefined : s.refs.find((r, i) => `image:${slotOf(r, i)}` === lead);
  const slots = clipSlots(engine, mode);
  const clipAt = vField?.key ?? "video:1";
  const lc = slots.includes(clipAt) ? clipIn(s, clipAt) : null;
  const clip = lc && !lc.missing ? lc : null;
  const hasInput = leadVideo ? !!clip : !!base;
  const photos = usePrepImages(s.refs);
  const images: PrepInput[] = [...photos, ...s.videos.filter((v) => slots.includes(v.slot) && !v.missing && v.width && v.height)
    .map((v) => runInput({ kind: "video" }, v.edits, { slot: v.slot, width: v.width!, height: v.height!, crop: v.crop, size: v.size }))];
  const sized = engine?.size;
  const local = sized ? plans(sized, images) : {};
  // Edits not made into a file yet: the server still sizes the old one, so the plan made here is the one a run gets.
  const waiting = new Set([...s.refs.flatMap((r, i) => (needsFile(r.edits, { kind: "image" }) ? [`image:${slotOf(r, i)}`] : [])),
    ...s.videos.flatMap((v) => (needsFile(v.edits, { kind: "video" }) ? [v.slot] : []))]);
  const planOf = (slot: string) => (waiting.has(slot) ? local[slot] : compose?.prep?.[slot]) ?? local[slot] ?? null;
  // The input the stage edits: the one you picked, else the lead.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [s.engine]);
  const selField = media.find((f) => f.key === picked) ?? media.find((f) => f.key === lead) ?? media[0];
  // A declared output size: the shape and step picked under Output. Without one, the workflow sizes its own output.
  const canvas = sized?.canvas ? canvasSize(sized, s.params.aspect, s.params.out_size) : null;
  const noInput = !!engine?.fields?.length && !media.length;

  const group = s.group.length ? s.group : s.current ? [s.current] : [];
  const variants = useQueries({ queries: group.map((id) => ({ queryKey: ["generation", id], queryFn: () => api.generation(id), retry: false })) });
  const vlist = variants.map((q) => q.data).filter(Boolean) as Manifest[];
  const shown = (m && group.includes(m.id) ? m : null) ?? vlist.find((v) => v.id === s.current) ?? m ?? vlist[0] ?? null;
  const shownJob = shown ? jobs.find((j) => j.id === shown.id) : job ?? undefined;
  const live = !!shownJob && isActive(shownJob);
  const done = shown?.status === "done" && !!shown.result?.file;
  const failed = shown && !live && FAILED.has(shown.status) ? shown : null;

  // The template's own example: its cover beside the input it was made from.
  const example = !!engine?.cover;
  // What the stage shows, given what exists.
  const eff: View | "live" | "failed" | "empty" =
    view === "grid" && group.length > 1 ? "grid"
      : view === "example" && !shown && example ? "example"
      : !shown || view === "input" ? (hasInput ? "input" : "empty")
      : live ? "live" : failed ? "failed" : !done ? (hasInput ? "input" : "empty")
      : view === "result" || noInput ? "result" : "compare";

  // A run that finishes while you watch flips the stage to its result.
  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevState.current && prevState.current !== "done" && job?.state === "done" && view === "input") setView("compare");
    prevState.current = job?.state;
  }, [job?.state, view]);

  // Opening a template shows a finished run, as after Run: your latest of it, else the template's example.
  const runs = useRuns(s.engine);
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!s.engine || !engine || opened.current === s.engine || !runs.isFetched) return;
    opened.current = s.engine;
    if (s.current) return setView("compare");
    const last = (runs.data ?? []).find((g) => g.status === "done");
    if (last) {
      set({ current: last.id, group: [last.id] });
      setView("compare");
    } else setView("example");
  }, [s.engine, engine, runs.isFetched, runs.data, s.current, set]);

  // A new lead input puts it back on the stage (the template's own sample filling in doesn't).
  const leadAsset = leadVideo ? clip?.asset : base?.asset;
  const prevLead = useRef(leadAsset);
  useEffect(() => {
    if (prevLead.current !== leadAsset && leadAsset && (prevLead.current || !leadAsset.startsWith("tpl:"))) setView("input");
    prevLead.current = leadAsset;
  }, [leadAsset]);

  // Edits that need a new file (turn, size, rate, sound) are made just before the run.
  const prepare = async () => {
    if (!engine) return null;
    const next = await bakePending(s, engine, media, photos);
    if (!next) return null;
    set({ refs: next.refs, videos: next.videos, sounds: next.sounds });
    return toSpec(mode, next, engine);
  };
  const runner = useRunner({
    set, spec, compose, prepare,
    onRan: (ids) => { set({ group: ids }); setView(ids.length > 1 ? "grid" : "compare"); },
  });

  // Fresh from the Builder: run the draft once with its samples, as soon as Run is unblocked. The first check
  // can still be of the state before the samples arrived, so wait for one that passes instead of giving up on it.
  const why = useRef(runner.reasons);
  why.current = runner.reasons;
  useEffect(() => {
    if (!compose || !s.engine || autorun.engine !== s.engine || runner.busy || runner.blocked) return;
    autorun.engine = null;
    void runner.run();
  }, [compose, s.engine, runner]);
  useEffect(() => {
    if (!s.engine || autorun.engine !== s.engine) return;
    const t = window.setTimeout(() => {
      if (autorun.engine !== s.engine) return;
      autorun.engine = null;
      toast({ text: `The test run didn't start${why.current.length ? `: ${why.current.join(". ")}` : ""}. Press Run when it's ready.`, tone: "error" });
    }, Math.max(0, autorun.until - Date.now()));
    return () => window.clearTimeout(t);
  }, [s.engine]);

  const rerun = async (id: string) => {
    try {
      const { ids } = await api.rerun(id);
      set((st) => ({ current: ids[0], group: ids, session: [...ids, ...st.session] }));
      setView("compare");
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  // Files dropped on a result fill the inputs in order. Each card takes its own drop.
  const stageDrop = useFileDrop((files) => void dropIntoStudio(mode, files), { accept: isMediaFile, disabled: !media.length });
  // Variants and Re-run only make sense when the workflow re-rolls its seed; a fixed one gives the same result again.
  const varies = engine?.varies !== false;
  useEffect(() => { if (!varies && s.variants !== 1) set({ variants: 1 }); }, [varies, s.variants, set]);

  // An earlier run than this template's newest: its inputs may no longer be the ones on the left, so the bar offers them back.
  const newest = runs.data?.[0];
  const earlier = done && !!shown && !!newest && shown.created < newest.created && !group.includes(newest.id);
  const useInputs = (g: Manifest) => {
    useApp.getState().loadGeneration(g);
    set({ current: null, group: [] });
    setView("input");
    toast({ text: "That run's inputs, prompt and settings are back. Change anything, then Run.", tone: "ok" });
  };

  // E exports what's on the stage.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() === "e" && shown?.status === "done") { e.preventDefault(); share(shown.id); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [shown, share]);

  // Failure on the shown run: plain words plus the fixes the engine suggested.
  const fixes: Fix[] = [];
  if (failed) {
    const suggested = shownJob?.fixes ?? [];
    if (suggested.includes("smaller") || /memory/i.test(String(shownJob?.detail ?? failed.result?.error?.message ?? ""))) {
      const size = engine?.params.find((p) => /^(size|resolution|megapixels|width)$/.test(p.key));
      const leadIn = sized && images.find((i) => i.slot === lead);
      const now = planOf(lead);
      const smaller = sized && leadIn ? sized.options
        .map((o) => ({ o, p: plans(sized, [{ ...leadIn, size: o.label }])[leadIn.slot] }))
        .filter((x) => now && x.p.width * x.p.height < now.width * now.height)
        .sort((a, b) => b.p.width * b.p.height - a.p.width * a.p.height)[0] : undefined;
      const steps = sized?.options.filter((o) => o.px) ?? [];
      const canvasAt = sized?.canvas ? steps.findIndex((o) => o.label === String(s.params.out_size ?? sized.canvas!.size)) : -1;
      const smallerOut = canvasAt > 0 ? steps[canvasAt - 1].label : null;
      if (smallerOut) fixes.push({ label: `Use ${smallerOut}`, run: () => { setParam("out_size", smallerOut); toast({ text: `Output set to ${smallerOut}. Press Run.`, tone: "ok" }); } });
      else if (smaller && leadIn) fixes.push({ label: `Use ${smaller.o.label} (${dimsText(smaller.p)})`, run: () => { set(withInput(leadIn.slot, { size: smaller.o.label })); toast({ text: `Size set to ${smaller.o.label}. Press Run.`, tone: "ok" }); } });
      else if (size) fixes.push({ label: "Use a smaller size", run: () => { const opts = size.options ?? []; const i = opts.indexOf(String(s.params[size.key] ?? size.default)); if (opts.length && i > 0) { set((st) => ({ params: { ...st.params, [size.key]: opts[i - 1] } })); toast({ text: `${size.label} set to ${opts[i - 1]}. Press Run.`, tone: "ok" }); } else if (size.type === "int") { set((st) => ({ params: { ...st.params, [size.key]: size.min ?? size.default } })); } } });
    }
    if (suggested.includes("trim") && s.videos.length) {
      // Every clip over its input's length gets cut to it.
      const cut = (v: VideoSlot): VideoSlot => {
        const w = clipWindow(engine, v.slot)?.[1] ?? 10;
        const end = v.trim[1] || v.duration || 0;
        return { ...v, trim: [v.trim[0], v.trim[0] + Math.min(w, end - v.trim[0])] };
      };
      const w = clipWindow(engine, clipAt)?.[1] ?? 10;
      fixes.push({ label: slots.length > 1 ? "Trim the clips to fit" : `Trim to ${w} s`, run: () => set((st) => ({ videos: st.videos.map(cut) })) });
    }
    if (suggested.includes("rerun") || failed.status !== "cancelled") fixes.push({ label: "Try again", run: () => rerun(failed.id), primary: true });
  }

  if (!s.engine && !engine) return <NoTemplates mode={mode} />;
  if (s.engine && engines.isError && !engine) {
    return <div className="page studio-missing"><EmptyBox icon="alert" title="Couldn't check the template" action={<button className="btn" type="button" onClick={() => engines.refetch()}>Try again</button>}>{errMsg(engines.error)}</EmptyBox></div>;
  }
  if (s.engine && engines.isSuccess && !engine) {
    const name = s.engine.split("/").pop() ?? s.engine;
    return (
      <div className="page studio-missing">
        <EmptyBox icon="alert" title="Template not installed" action={<div className="acts">
          <a className="btn primary" href="#/explore"><I n="search" />Choose a template</a>
          <button className="btn" type="button" onClick={() => window.dispatchEvent(new Event("oi:import"))}><I n="upload" />Import .illusion</button>
        </div>}>
          This recipe uses <b>{name}</b>. Install that template or choose another one explicitly. The imported inputs, prompt, and settings are still kept.
        </EmptyBox>
      </div>
    );
  }

  const inputView = eff === "input" || eff === "empty";
  const editing = inputView && !!engine && !!selField;
  const pickRun = (id: string) => { set({ current: id, group: [id] }); setView("compare"); };
  const setParam = (k: string, v: unknown) => set((st) => ({ params: { ...st.params, [k]: v } }));
  const required = cards.filter((f) => f.required !== false).length;

  return (
    <div className="page studio">
      <aside className="recipe" aria-label="Recipe">
        <div className="recipe-scroll">
          {engine ? <Hero e={engine} run={done && shown?.engine.model === engine.id ? shown.id : null} /> : <div className="thero"><div className="thero-img" /></div>}
          <HistStrip engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
          {engine?.kind === "local" && <div style={{ display: "grid", gap: 8 }}><LocalNeeds spec={spec} /></div>}

          {engine && !!cards.length && (
          <section className="sec" aria-labelledby="sec-inputs">
            <div className="sec-h"><h4 id="sec-inputs">Inputs</h4><span className="mono">{cards.length > required ? `${cards.length - required} optional` : `${cards.length} ${cards.length === 1 ? "input" : "inputs"}`}</span></div>
            <div className="flist">
              {cards.map((f) => (
                <FileCard key={f.key} e={engine} f={f as (typeof media)[number]} s={s} set={set} photos={photos} plan={planOf(f.key)}
                  on={inputView && f.key === selField?.key} onPick={() => { setPicked(f.key); setView("input"); }} />
              ))}
            </div>
          </section>
          )}

          <PromptSection s={s} set={set} engine={engine} invalid={invalid.has("prompt")} onRun={() => void runner.run()} />

          {(!!settings.main.length || !!sized?.canvas) && (
            <section className="sec" aria-labelledby="sec-set">
              <div className="sec-h"><h4 id="sec-set">Settings</h4></div>
              <div className="adv-body" style={{ padding: 0 }}>
                {sized?.canvas && <OutputSize size={sized} aspect={s.params.aspect} step={s.params.out_size} onChange={setParam} />}
                {!!settings.main.length && <ParamFields params={settings.main} values={s.params} invalid={invalid} onChange={setParam} />}
              </div>
            </section>
          )}

          {!!settings.advanced.length && <details className="adv">
            <summary><I n="sliders" />Advanced<span className="mono">{advSummary(settings.advanced, s)}</span><I n="down" className="chev" /></summary>
            <div className="adv-body">
              {engine && <ParamFields params={settings.advanced} values={s.params} invalid={invalid} onChange={setParam} />}
            </div>
          </details>}
        </div>
        <RunBar s={s} set={set} engine={engine} spec={spec} runner={runner} queued={jobs.filter(isActive).length} varies={varies} />
      </aside>

      <section className="stage" aria-label="Preview">
        <div className="stage-top">
          <div className="crumb">Create<span>/</span><b>{engine ? tplName(engine) : "…"}</b></div>
          <span style={{ flex: 1 }} />
          {(!!shown || example) && !!media.length && (
            <div className="vseg" role="group" aria-label="Show">
              <button type="button" aria-pressed={inputView} onClick={() => setView("input")} title="Edit the inputs"><I n="pencil" /><span className="lbl">Inputs</span></button>
              <button type="button" aria-pressed={!inputView} onClick={() => setView(shown ? (group.length > 1 ? "grid" : "compare") : "example")}
                title={shown ? "See the run" : "What this template makes. Run it to make your own."}>
                <I n="image" /><span className="lbl">Result</span>{live && (shownJob?.kind === "cloud" || !jobProgress(shownJob) ? <span className="pct dotpulse" aria-label="Running" /> : <span className="mono pct">{Math.round(jobProgress(shownJob) * 100)}%</span>)}
              </button>
            </div>
          )}
          {group.length > 1 && (
            <button className={cx("btn sm", eff === "grid" ? "primary" : "ghost")} type="button" aria-pressed={eff === "grid"}
              onClick={() => setView(eff === "grid" ? "compare" : "grid")} title="See every variant of this run"><I n="grid" /><span className="lbl">All {group.length}</span></button>
          )}
          {done && shown && (
            <>
              {varies && <button className="btn sm ghost" type="button" onClick={() => rerun(shown.id)} title="Same inputs, new seed"><I n="refresh" /><span className="lbl">Re-run</span></button>}
              <button className="btn sm" type="button" onClick={() => share(shown.id)} aria-keyshortcuts="E" title="Export (E)"><I n="share" /><span className="lbl">Export</span></button>
              {engine && shown.engine.model === engine.id && <UseAsCover e={engine} run={shown.id} />}
            </>
          )}
          <button className="icon-btn" type="button" aria-label="Open in Library" title="Open in Library" disabled={!shown} style={shown ? undefined : { opacity: 0.35 }}
            onClick={() => shown && go({ name: "generation", id: shown.id })}><I n="expand" /></button>
          <KeyStat />
          <GpuStat />
        </div>

        {editing ? (
          <div className="stage-ed">
            <InputStage key={selField!.key} e={engine} f={selField!} s={s} set={set} photos={photos} />
          </div>
        ) : (
        <div className={cx("canvas", stageDrop.over && "drop")} {...stageDrop.props} data-drop="Drop to fill the inputs in order">
          <Canvas mode={mode} lead={lead} eff={eff} s={s} set={set} engine={engine} base={base} out={noInput ? canvas : planOf(lead)} shown={shown} job={shownJob} group={group} vlist={vlist} jobs={jobs}
            fixes={fixes} earlier={earlier}
            action={shown && <button className="btn sm primary" type="button" onClick={() => useInputs(shown)} title="Put this run's photos, prompt and settings back on the left"><I n="undo" />Use these inputs</button>}
            onFocus={(id) => { set({ current: id }); setView("compare"); }} />
        </div>
        )}

        <aside className="hist" aria-label="Runs of this template">
          <HistList engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
        </aside>
      </section>
    </div>
  );
}
