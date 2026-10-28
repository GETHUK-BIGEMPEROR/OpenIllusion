// Create: the studio page for one template (Image or Video).
import { useQueries } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { typing } from "../../components/ABPlayer";
import { dropIntoStudio, isMediaFile, useFileDrop } from "../../components/Drop";
import { OutputSize, useEngine, ParamFields } from "../../components/Engine";
import { cx, GpuStat, I, KeyStat } from "../../components/oi";
import { invalidFields, LocalNeeds, NoTemplates, useCompose, useCurrent, useRunner, useStudio, type Fix } from "../../components/Studio";
import { tplName } from "../../components/TemplateCard";
import { api, isMedia, type Manifest, type Mode } from "../../lib/api";
import { clipSlots, clipWindow, fieldsOf, leadSlot, mediaFields, refmodFields, settingsOf, videoField } from "../../lib/fields";
import { errMsg } from "../../lib/format";
import { isActive, useJobs } from "../../lib/live";
import { go } from "../../lib/route";
import { autorun, clipIn, slotOf, useApp, type VideoSlot } from "../../lib/store";
import { canvasSize, dimsText, plans, usePrepImages, type PrepInput } from "../../lib/size";
import { Canvas } from "./Canvas";
import { HistList, HistStrip } from "./History";
import { bakePending, FileCard, InputStage } from "./Inputs";
import { RefModCard, RefModStage } from "./RefModInput";
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
  const engine = useEngine(mode, s.engine);
  const media = mediaFields(engine);
  const mods = refmodFields(engine);
  // The inputs list: photos, clips, sounds and RefMods, in the template's order.
  const cards = fieldsOf(engine).filter((f) => isMedia(f) || f.type === "refmod");
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
    .map((v) => ({ slot: v.slot, width: v.width!, height: v.height!, crop: v.crop, size: v.size }))];
  const sized = engine?.size;
  const local = sized ? plans(sized, images) : {};
  const planOf = (slot: string) => compose?.prep?.[slot] ?? local[slot] ?? null;
  // The input the stage edits: the one you picked, else the lead.
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => setPicked(null), [s.engine]);
  const selMod = mods.find((f) => f.key === picked);
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

  // What the stage shows, given what exists.
  const eff: View | "live" | "failed" | "empty" =
    view === "grid" && group.length > 1 ? "grid"
      : !shown || view === "input" ? (hasInput ? "input" : "empty")
      : live ? "live" : failed ? "failed" : !done ? (hasInput ? "input" : "empty")
      : view === "result" || noInput ? "result" : "compare";

  // A run that finishes while you watch flips the stage to its result.
  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevState.current && prevState.current !== "done" && job?.state === "done" && view === "input") setView("compare");
    prevState.current = job?.state;
  }, [job?.state, view]);

  // A new lead input puts it back on the stage.
  const leadAsset = leadVideo ? clip?.asset : base?.asset;
  const prevLead = useRef(leadAsset);
  useEffect(() => {
    if (prevLead.current !== leadAsset && leadAsset) setView("input");
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

  // Fresh from the Builder: run the draft once with its samples.
  useEffect(() => {
    if (!compose || !s.engine || autorun.engine !== s.engine || runner.busy) return;
    autorun.engine = null;
    void runner.run();
  }, [compose, s.engine, runner]);

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

  const remix = (g: Manifest) => {
    useApp.getState().loadGeneration(g);
    set({ current: null, group: [] });
    setView("input");
    toast({ text: "Loaded into a new draft. Change anything, then Run.", tone: "ok" });
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

  const inputView = eff === "input" || eff === "empty";
  const editing = inputView && !!engine && (!!selMod || !!selField);
  const pickRun = (id: string) => { set({ current: id, group: [id] }); setView("compare"); };
  const setParam = (k: string, v: unknown) => set((st) => ({ params: { ...st.params, [k]: v } }));
  const required = cards.filter((f) => f.required !== false).length;

  return (
    <div className="page studio">
      <aside className="recipe" aria-label="Recipe">
        <div className="recipe-scroll">
          {engine ? <Hero e={engine} /> : <div className="thero"><div className="thero-img" /></div>}
          <HistStrip engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
          {engine?.kind === "local" && <div style={{ display: "grid", gap: 8 }}><LocalNeeds spec={spec} /></div>}

          {engine && !!cards.length && (
          <section className="sec" aria-labelledby="sec-inputs">
            <div className="sec-h"><h4 id="sec-inputs">Inputs</h4><span className="mono">{cards.length > required ? `${cards.length - required} optional` : `${cards.length} ${cards.length === 1 ? "input" : "inputs"}`}</span></div>
            <div className="flist">
              {cards.map((f) => f.type === "refmod" ? (
                <RefModCard key={f.key} e={engine} f={f as (typeof mods)[number]} s={s} set={set}
                  on={inputView && f.key === selMod?.key} onPick={() => { setPicked(f.key); setView("input"); }} />
              ) : (
                <FileCard key={f.key} e={engine} f={f as (typeof media)[number]} s={s} set={set} photos={photos} plan={planOf(f.key)}
                  on={inputView && !selMod && f.key === selField?.key} onPick={() => { setPicked(f.key); setView("input"); }} />
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
        <RunBar s={s} set={set} engine={engine} runner={runner} queued={jobs.filter(isActive).length} varies={varies} />
      </aside>

      <section className="stage" aria-label="Preview">
        <div className="stage-top" data-acts={done && shown ? "" : undefined}>
          <div className="crumb">Create<span>/</span><b>{engine ? tplName(engine) : "…"}</b></div>
          <span style={{ flex: 1 }} />
          {!!shown && !!media.length && (
            <div className="vseg" role="group" aria-label="Show">
              <button type="button" aria-pressed={inputView} onClick={() => setView("input")} title="Edit the inputs"><I n="pencil" /><span className="lbl">Inputs</span></button>
              <button type="button" aria-pressed={!inputView} onClick={() => setView(group.length > 1 ? "grid" : "compare")} title="See the run"><I n="image" /><span className="lbl">{live ? "Running" : "Result"}</span></button>
            </div>
          )}
          {group.length > 1 && (
            <button className={cx("btn sm", eff === "grid" ? "primary" : "ghost")} type="button" aria-pressed={eff === "grid"}
              onClick={() => setView(eff === "grid" ? "compare" : "grid")} title="See every variant of this run"><I n="grid" /><span className="lbl">All {group.length}</span></button>
          )}
          {done && shown && (
            <>
              {varies && <button className="btn sm ghost" type="button" onClick={() => rerun(shown.id)} title="Same inputs, new seed"><I n="refresh" /><span className="lbl">Re-run</span></button>}
              <button className="btn sm ghost" type="button" onClick={() => remix(shown)} title="Load this run's inputs and settings as a new draft"><I n="remix" /><span className="lbl">Remix</span></button>
              <button className="btn sm" type="button" onClick={() => share(shown.id)} aria-keyshortcuts="E" title="Export (E)"><I n="share" /><span className="lbl">Export</span></button>
              {engine && !engine.cover && !engine.cover_video && shown.engine.model === engine.id && <UseAsCover e={engine} run={shown.id} />}
            </>
          )}
          <button className="icon-btn" type="button" aria-label="Open in Library" title="Open in Library" disabled={!shown} style={shown ? undefined : { opacity: 0.35 }}
            onClick={() => shown && go({ name: "generation", id: shown.id })}><I n="expand" /></button>
          <KeyStat />
          <GpuStat />
        </div>

        {editing ? (
          <div className="stage-ed">
            {selMod ? <RefModStage e={engine} f={selMod} s={s} set={set} />
              : <InputStage key={selField!.key} e={engine} f={selField!} s={s} set={set} photos={photos} />}
          </div>
        ) : (
        <div className={cx("canvas", stageDrop.over && "drop")} {...stageDrop.props} data-drop="Drop to fill the inputs in order">
          <Canvas mode={mode} lead={lead} eff={eff} s={s} set={set} engine={engine} base={base} out={noInput ? canvas : planOf(lead)} shown={shown} job={shownJob} group={group} vlist={vlist} jobs={jobs}
            fixes={fixes} onFocus={(id) => { set({ current: id }); setView("compare"); }} />
        </div>
        )}

        <aside className="hist" aria-label="Runs of this template">
          <HistList engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
        </aside>
      </section>
    </div>
  );
}
