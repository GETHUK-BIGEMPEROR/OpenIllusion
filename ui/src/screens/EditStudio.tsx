import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ABPlayer, typing } from "../components/ABPlayer";
import { CostPill } from "../components/bits";
import { clipSlot as asClip, dropIntoStudio, isImage, isMediaFile, isVideo, useFileDrop } from "../components/Drop";
import { useEngine, ParamFields } from "../components/Engine";
import { Compare, cx, GpuStat, I, jobProgress, QUEUED, Ring, useStatus, gpuName } from "../components/oi";
import { bySlot, useUploader, withRefs } from "../components/Refs";
import {
  invalidFields, LocalNeeds, NoTemplates, RawRequest, StageError, useCompose, useCurrent, useRunner, useStudio, type Fix,
} from "../components/Studio";
import { TemplateTools, tplModel, tplName, useCoverActions } from "../components/TemplateCard";
import { Trimmer } from "../components/Trimmer";
import { Spinner } from "../components/ui";
import { api, fileUrl, type EngineInfo, type GenerationRow, type Job, type Manifest, type Mode, type ParamSpec, type SizeSpec } from "../lib/api";
import { clipFps, clipSlots, clipWindow, leadSlot, mediaFields, promptField, roleOf, settingsOf, slotNo, videoField, type MediaField } from "../lib/fields";
import { EDIT_ROLES, errMsg } from "../lib/format";
import { isActive, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { autorun, clipIn, newKey, posterOf, slotOf, withClip, useApp, type RefSlot, type StudioState, type VideoSlot } from "../lib/store";
import { aspectName, canvasSize, choiceOf, dimsText, megapixels, plan, plans, SHAPES, shapeCrop, shapeOf, sizeNotes, usePrepImages, type Crop, type PrepInput } from "../lib/size";

type View = "input" | "result" | "compare" | "grid";
type SetS = ReturnType<typeof useStudio>[1];

const ACCEPT = "image/png,image/jpeg,image/webp";
const ACCEPT_VIDEO = "video/mp4,video/quicktime,video/webm,.m4v";
const FAILED = new Set(["failed", "moderated", "cancelled"]);

/** A studio change to one input's attributes (shape, size), photo or clip alike. */
const withInput = (slot: string, patch: { crop?: Crop; size?: string }) => (st: StudioState): Partial<StudioState> => slot.startsWith("video:")
  ? { videos: st.videos.map((v) => (v.slot === slot ? { ...v, ...patch } : v)), current: null }
  : { refs: st.refs.map((r, i) => (`image:${slotOf(r, i)}` === slot ? { ...r, ...patch } : r)), current: null };

/** A template's sample for one photo input, as a tray entry. */
function sampleRef(e: EngineInfo, slot: string): RefSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === slot);
  if (!i) return null;
  return { ...i, key: newKey(), slot: slotNo(slot), sample: true, license: "generated", contains_person: false, consent: false, role: roleOf(e, slot) };
}

/** A template's sample clip, trimmed to fit its window. */
function sampleVideo(e: EngineInfo, slot: string): VideoSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === slot);
  if (!i) return null;
  const d = i.duration ?? 0;
  const win = clipWindow(e, slot);
  return { ...i, trim: [0, win ? Math.min(d, win[1]) : d], sample: true, license: "generated", contains_person: false, consent: false };
}

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
  const vField = videoField(engine);
  const lead = leadSlot(engine);
  const leadVideo = lead.startsWith("video:");
  const settings = settingsOf(engine);
  const { spec, compose, estimate } = useCompose(mode, s, engine);
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

  const runner = useRunner({
    s, set, spec, compose, estimate,
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
  // Dropping on the stage replaces the input it shows; several files fill the inputs in order.
  const replaceLead = async (files: File[]) => {
    if (files.length > 1) return void dropIntoStudio(mode, files);
    const f = files.find(leadVideo ? isVideo : isImage);
    if (!f) return toast({ text: leadVideo ? "This input takes a video." : "This input takes a photo.", tone: "warn" });
    let a;
    try {
      a = await api.upload(f);
    } catch (e) {
      return toast({ text: `${f.name}: ${errMsg(e)}`, tone: "error" });
    }
    if (leadVideo) set((st) => ({ videos: withClip(st, lead, asClip(a, engine, lead, clipIn(st, lead)?.size)), current: null }));
    else {
      const n = slotNo(lead);
      set((st) => {
        const [added] = withRefs([], [a], EDIT_ROLES, "base");
        const old = bySlot(st.refs).find((r) => r.slot === n);
        return { refs: bySlot([...bySlot(st.refs).filter((r) => r.slot !== n), { ...added, slot: n, size: old?.size, role: engine ? roleOf(engine, lead) : added.role }]), current: null };
      });
    }
    setView("input");
  };
  const stageDrop = useFileDrop((files) => void replaceLead(files), { accept: isMediaFile, disabled: !media.length });
  const leadName = media.find((f) => f.key === lead)?.label;
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
      else if (size) fixes.push({ label: "Use a smaller size", run: () => { const opts = size.options ?? []; const i = opts.indexOf(String(s.params[size.key] ?? size.default)); if (opts.length && i > 0) { set((st) => ({ params: { ...st.params, [size.key]: opts[i - 1] }, raw: null })); toast({ text: `${size.label} set to ${opts[i - 1]}. Press Run.`, tone: "ok" }); } else if (size.type === "int") { set((st) => ({ params: { ...st.params, [size.key]: size.min ?? size.default }, raw: null })); } } });
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

  const pickRun = (id: string) => { set({ current: id, group: [id] }); setView("compare"); };
  const setParam = (k: string, v: unknown) => set((st) => ({ params: { ...st.params, [k]: v }, raw: null }));
  const required = media.filter((f) => f.required !== false).length;

  return (
    <div className="page studio">
      <aside className="recipe" aria-label="Recipe">
        <div className="recipe-scroll">
          {engine ? <Hero e={engine} /> : <div className="thero"><div className="thero-img" /></div>}
          <HistStrip engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
          {engine?.kind === "local" && <div style={{ display: "grid", gap: 8 }}><LocalNeeds spec={spec} /></div>}

          {engine && !!media.length && (
          <section className="sec" aria-labelledby="sec-inputs">
            <div className="sec-h"><h4 id="sec-inputs">Inputs</h4>{media.length > required && <span className="mono">{media.length - required} optional</span>}</div>
            <div className="tiles">
              {media.map((f) => <Tile key={f.key} e={engine} f={f} s={s} set={set} />)}
            </div>
            {media.map((f) => <InputExtras key={f.key} e={engine} f={f} s={s} set={set} staged={f.key === lead} named={media.length > 1} />)}
          </section>
          )}

          <PromptSection s={s} set={set} engine={engine} invalid={invalid.has("prompt")} onRun={() => void runner.run()} />

          {!!settings.main.length && (
            <section className="sec" aria-labelledby="sec-set">
              <div className="sec-h"><h4 id="sec-set">Settings</h4></div>
              <div className="adv-body" style={{ padding: 0 }}>
                <ParamFields params={settings.main} values={s.params} invalid={invalid} onChange={setParam} />
              </div>
            </section>
          )}

          {!!settings.advanced.length && <details className="adv">
            <summary><I n="sliders" />Advanced<span className="mono">{advSummary(settings.advanced, s)}</span><I n="down" className="chev" /></summary>
            <div className="adv-body">
              {engine && <ParamFields params={settings.advanced} values={s.params} invalid={invalid} onChange={setParam} />}
              <div style={{ margin: "0 -14px -14px", borderTop: "1px solid var(--line)" }}><RawRequest s={s} set={set} spec={spec} compose={compose} /></div>
            </div>
          </details>}
        </div>
        <RunBar s={s} set={set} engine={engine} runner={runner} estimate={estimate} queued={jobs.filter(isActive).length} varies={varies} />
      </aside>

      <section className="stage" aria-label="Preview">
        <div className="stage-top" data-acts={done && shown ? "" : undefined}>
          <div className="crumb">Create<span>/</span><b>{engine ? tplName(engine) : "…"}</b></div>
          <span style={{ flex: 1 }} />
          {group.length > 1 && (
            <button className={cx("btn sm", eff === "grid" ? "primary" : "ghost")} type="button" aria-pressed={eff === "grid"}
              onClick={() => setView(eff === "grid" ? "compare" : "grid")} title="See every variant of this run"><I n="grid" /><span className="lbl">All {group.length}</span></button>
          )}
          {done && shown && (
            <>
              {varies && <button className="btn sm ghost" type="button" onClick={() => rerun(shown.id)} title="Same inputs, new seed"><I n="refresh" /><span className="lbl">Re-run</span></button>}
              <button className="btn sm ghost" type="button" onClick={() => remix(shown)} title="Load this run's inputs and settings as a new draft"><I n="remix" /><span className="lbl">Remix</span></button>
              <button className="btn sm" type="button" onClick={() => share(shown.id)} aria-keyshortcuts="E" title="Export (E)"><I n="share" /><span className="lbl">Export</span></button>
              {engine?.draft && shown.engine.model === engine.id && <Publish e={engine} run={shown.id} />}
            </>
          )}
          <button className="icon-btn" type="button" aria-label="Open in Library" title="Open in Library" disabled={!shown} style={shown ? undefined : { opacity: 0.35 }}
            onClick={() => shown && go({ name: "generation", id: shown.id })}><I n="expand" /></button>
          <GpuStat />
        </div>

        <div className={cx("canvas", stageDrop.over && "drop")} {...stageDrop.props} data-drop={`Drop to replace ${leadName ?? "the input"}`}>
          <Canvas mode={mode} lead={lead} eff={eff} s={s} set={set} engine={engine} base={base} out={noInput ? canvas : planOf(lead)} shown={shown} job={shownJob} group={group} vlist={vlist} jobs={jobs}
            fixes={fixes} onFocus={(id) => { set({ current: id }); setView("compare"); }} />
        </div>

        <aside className="hist" aria-label="Runs of this template">
          <HistList engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
        </aside>
      </section>
    </div>
  );
}

function advSummary(params: ParamSpec[], s: StudioState) {
  const steps = params.find((p) => p.key === "steps");
  const seed = params.find((p) => p.type === "seed");
  const parts = [];
  if (steps) parts.push(`${s.params.steps ?? steps.default} steps`);
  if (seed) { const v = Number(s.params[seed.key] ?? -1); parts.push(v < 0 ? "random seed" : `seed ${v}`); }
  if (s.raw) parts.push("edited JSON");
  return parts.join(" · ");
}

/* ------------------------------------------------------------------ recipe */

function Hero({ e }: { e: EngineInfo }) {
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
              {tplName(x)}<small>{tplModel(x)}</small>
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
function Publish({ e, run }: { e: EngineInfo; run: string }) {
  const { busy, fromRun } = useCoverActions(e);
  return (
    <button className="btn sm primary" type="button" disabled={busy} onClick={() => void fromRun(run)} title="This result becomes the cover and the template goes on Explore">
      {busy ? <Spinner size={13} /> : <I n="upload" />}<span className="lbl">Publish</span>
    </button>
  );
}

/** One photo or clip input as a tile, named by its place: what each one is, the prompt says. Click or drop to fill or replace. */
function Tile({ e, f, s, set }: { e: EngineInfo; f: MediaField; s: StudioState; set: SetS }) {
  const video = f.type === "video";
  const n = slotNo(f.key);
  const { upload, busy } = useUploader();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const r = video ? undefined : s.refs.find((x, i) => slotOf(x, i) === n);
  const v = video ? clipIn(s, f.key) : null;
  const held = video ? v : r;
  const thumb = video ? v?.poster : r?.url;
  const putRef = (x: RefSlot | null) => set((st) => ({ refs: bySlot([...bySlot(st.refs).filter((y) => y.slot !== n), ...(x ? [x] : [])]), current: null }));
  const putClip = (x: Omit<VideoSlot, "slot"> | null) => set((st) => ({ videos: withClip(st, f.key, x), current: null }));
  const clear = () => (video ? putClip(null) : putRef(null));
  const sample = video ? sampleVideo(e, f.key) : sampleRef(e, f.key);
  const useSample = () => (video ? putClip(sample as VideoSlot) : putRef(sample as RefSlot));
  const pick = () => input.current?.click();
  const fill = async (files: File[]) => {
    const file = files.find((x) => (video ? /^video\// : /^image\//).test(x.type)) ?? files[0];
    if (!file) return;
    const [a] = await upload([file], video ? "video" : "image");
    if (!a) return;
    if (video) putClip(asClip(a, e, f.key, v?.size));
    else {
      const [added] = withRefs([], [a], EDIT_ROLES, "base");
      putRef({ ...added, slot: n, size: r?.size, role: roleOf(e, f.key) });
    }
  };
  const drop = {
    onDragOver: (ev: React.DragEvent) => { if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); ev.stopPropagation(); setOver(true); } },
    onDragLeave: (ev: React.DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver(false); },
    onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.files.length) return; ev.preventDefault(); ev.stopPropagation(); setOver(false); void fill([...ev.dataTransfer.files]); },
  };
  const len = v ? (v.trim[1] || v.duration || 0) - v.trim[0] : 0;
  return (
    <div data-own-drop {...drop} className={cx("tile", !held?.url && "empty", over && "drag", held?.missing && "missing", !held?.url && sample && "has-sample")}>
      <input ref={input} type="file" accept={video ? ACCEPT_VIDEO : ACCEPT} hidden onChange={(ev) => { void fill([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
      <button className="tile-main" type="button" onClick={pick} aria-label={held?.url ? `Replace ${f.label}` : `Add ${f.label}`}
        title={held?.url ? "Click or drop to replace" : `Drop ${video ? "a clip" : "a photo"} or click to browse`}>
        {thumb ? <img src={thumb} alt="" /> : <I n={video ? "film" : "image"} />}
        {busy > 0 && <span className="tile-busy"><Spinner size={16} /></span>}
      </button>
      <span className="tile-n">{f.label}{!held?.url && f.required === false ? " · optional" : ""}</span>
      {held?.url && held.sample && !held.missing && <span className="tag-sample tile-tag">SAMPLE</span>}
      {held?.missing && <span className="tile-miss">File missing</span>}
      {v?.url && !v.missing && <span className="tile-dur">{len.toFixed(1)}s</span>}
      {held?.url
        ? <button className="icon-btn sm glass tile-x" type="button" onClick={clear} aria-label={`Remove ${f.label}`} title="Remove"><I n="x" /></button>
        : sample && <button className="tile-sample" type="button" onClick={useSample}>Use sample</button>}
    </div>
  );
}

/** Under the tiles: each filled input's shape and size, and a clip's trim. */
function InputExtras({ e, f, s, set, staged, named }: { e: EngineInfo; f: MediaField; s: StudioState; set: SetS; staged: boolean; named: boolean }) {
  if (!e.size) return null;
  const name = named ? f.label : undefined;
  if (f.type === "video") {
    const v = clipIn(s, f.key);
    if (!v?.url || v.missing) return null;
    const prepIn: PrepInput | null = v.width && v.height ? { slot: f.key, width: v.width, height: v.height, crop: v.crop, size: v.size } : null;
    const p = prepIn ? plans(e.size, [prepIn])[prepIn.slot] : null;
    const rate = clipFps(e, f.key);
    return (
      <div className="inx">
        {prepIn && <InputAttrs name={name} size={e.size} input={prepIn} preview={v.poster ?? undefined} staged={staged} onChange={(patch) => set(withInput(f.key, patch))} />}
        {!!v.duration && (
          <Trimmer src={v.url} duration={v.duration} trim={v.trim} window={clipWindow(e, f.key)} fps={rate[0] === rate[1] ? rate[0] : v.fps} height={p?.height ?? v.height}
            onChange={(trim) => set((st) => ({ videos: st.videos.map((x) => (x.slot === f.key ? { ...x, trim } : x)), current: null }))} />
        )}
      </div>
    );
  }
  const n = slotNo(f.key);
  const r = s.refs.find((x, i) => slotOf(x, i) === n);
  if (!r?.url || r.missing || !r.width || !r.height) return null;
  return (
    <div className="inx">
      <InputAttrs name={name} size={e.size} input={{ slot: f.key, width: r.width, height: r.height, crop: r.crop, size: r.size }} preview={r.url} staged={staged}
        onChange={(patch) => set(withInput(f.key, patch))} />
    </div>
  );
}

/**
 * What every photo and clip has: a shape (its own, or a crop to a common one) and a size (its own pixels, or a
 * megapixel budget at its shape). One line under the input; open it to change either. The input on the stage is
 * cropped there, the others in a small preview here.
 */
function InputAttrs({ name, size, input, preview, staged, onChange }: {
  name?: string; size: SizeSpec; input: PrepInput; preview?: string; staged: boolean; onChange: (patch: { crop?: Crop; size?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const choice = choiceOf(size, input.slot, input.size);
  const p = plans(size, [input])[input.slot];
  const shape = shapeOf(input.width, input.height, input.crop);
  const own = input.width / input.height;
  const notes = sizeNotes(p);
  const capMp = +((size.cap ?? 0) ** 2 / 1e6).toFixed(1);
  const capped = !!size.cap && plan(input.width, input.height, 0, size.multiple, input.crop).width > p.width;
  return (
    <div className={cx("attrs", open && "open")}>
      <button className="attrs-h" type="button" aria-expanded={open} onClick={() => setOpen(!open)} title="The shape and size this input runs at">
        <ShapeIcon r={p.width / p.height} />
        {name && <><b>{name}</b><i>·</i></>}
        <span>{shape === "Own" ? "Own shape" : shape}</span><i>·</i><span>{choice === size.original ? "Own size" : choice}</span>
        {notes.length > 0 && <I n="alert" className="warn" />}
        <span className="mono">{dimsText(p)}</span>
        <I n="down" className="chev" />
      </button>
      {open && (
        <div className="attrs-b">
          <div className="sizes shapes" role="group" aria-label="Shape" style={{ gridTemplateColumns: `repeat(${SHAPES.length},minmax(0,1fr))` }}>
            {SHAPES.map(([label, r]) => (
              <button key={label} type="button" aria-pressed={shape === label} title={r ? `Crop to ${label}` : "Keep its own shape"}
                onClick={() => onChange({ crop: r ? shapeCrop(input.width, input.height, r) : undefined })}>
                <ShapeIcon r={r || own} /><b>{label}</b>
              </button>
            ))}
          </div>
          {input.crop && !staged && preview && (
            <div className="attrs-crop" style={{ "--ar": own } as CSSProperties}>
              <img src={preview} alt="" draggable={false} />
              <CropBox crop={input.crop} onChange={(crop) => onChange({ crop })} />
            </div>
          )}
          <div className="sizes" role="group" aria-label="Size" style={{ gridTemplateColumns: `repeat(${Math.min(size.options.length, 5)},minmax(0,1fr))` }}>
            {size.options.map((o) => (
              <button key={o.label} type="button" aria-pressed={choice === o.label} title={o.px ? `About ${o.label} at its shape` : "Its own pixels"} onClick={() => onChange({ size: o.label })}>
                <b>{o.px ? o.label : "Own"}</b><span>{dimsText(plans(size, [{ ...input, size: o.label }])[input.slot])}</span>
              </button>
            ))}
          </div>
          <p className="help">
            {choice !== size.original ? `About ${megapixels(p).toFixed(2)} MP at its shape. Never stretched.`
              : capped ? `Over the ${capMp} MP cap, so it runs at about ${megapixels(p).toFixed(2)} MP. Lift the cap in Settings.`
              : `Kept at its own pixels, trimmed to a multiple of ${size.multiple}.`}
            {input.crop && staged ? " Drag the frame on the preview to choose what stays." : ""}
          </p>
          {notes.map((t) => <p key={t} className="help warn"><I n="alert" />{t}</p>)}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- stage */

function Canvas({ mode, lead, eff, s, set, engine, base, out, shown, job, group, vlist, jobs, fixes, onFocus }: {
  mode: Mode; lead: string; eff: View | "live" | "failed" | "empty"; s: StudioState; set: SetS; engine?: EngineInfo; base?: RefSlot; out: { width: number; height: number } | null;
  shown: Manifest | null; job?: Job; group: string[]; vlist: Manifest[]; jobs: Job[]; fixes: Fix[];
  onFocus: (id: string) => void;
}) {
  const { upload, busy } = useUploader();
  const [over, setOver] = useState(false);
  const qc = useQueryClient();
  // The stage follows the lead input: a clip plays, a photo can be cropped and marked. Results show as what they are.
  const motion = lead.startsWith("video:");
  const leadField = mediaFields(engine).find((f) => f.key === lead);
  const result = shown?.result?.file ? fileUrl(shown.id, shown.result.file) : null;
  const videoOut = shown?.result?.kind === "video";
  const size = useImageSize(videoOut ? null : result);
  const drove = shown?.inputs.find((i) => i.slot === lead && i.file) ?? shown?.inputs.find((i) => i.slot.startsWith("video:") && i.file);
  const lc = motion ? clipIn(s, lead) : null;
  const clip = lc && !lc.missing ? lc : null;
  const ar = motion
    ? (drove?.width && drove.height ? drove.width / drove.height : clip?.width && clip.height ? clip.width / clip.height : 16 / 9)
    : size ? size.w / size.h : out ? out.width / out.height : base?.width && base?.height ? base.width / base.height : 1;
  const before = shown?.inputs.find((i) => i.slot === lead)?.file;
  const beforeUrl = motion
    ? (shown && drove ? fileUrl(shown.id, posterOf(drove.file!)) : clip?.poster ?? undefined)
    : shown && before ? fileUrl(shown.id, before) : base?.url;

  // Words only: nothing to drop, the prompt is the whole input.
  if (eff === "empty" && engine && (engine.size?.canvas || !engine.inputs?.length)) {
    return (
      <div className="frame" style={{ "--ar": ar } as CSSProperties}>
        <div className="empty" style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", justifyItems: "center", textAlign: "center", padding: 20 }}>
          <div className="empty-ic"><I n={mode === "motion" ? "film" : "image"} /></div>
          <h3>Describe it, then Run</h3>
          <p>This template makes {mode === "motion" ? "a video" : "a picture"} from the prompt alone.</p>
        </div>
        {out && <div className="corner r"><span className="pill mono">Out {dimsText(out)}</span></div>}
      </div>
    );
  }

  if (eff === "empty" && motion) {
    const sample = engine ? sampleVideo(engine, lead) : null;
    const leadWin = clipWindow(engine, lead);
    const fill = async (files: File[]) => {
      const f = files.find((x) => /^video\//.test(x.type));
      if (!f) return;
      const [a] = await upload([f], "video");
      if (!a) return;
      set((st) => ({ videos: withClip(st, lead, asClip(a, engine, lead)), current: null }));
    };
    return (
      <div data-own-drop className={cx("empty", over && "drag")} style={{ padding: 20, borderRadius: 18, border: `1.5px dashed ${over ? "var(--violet)" : "var(--line-2)"}` }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); void fill([...e.dataTransfer.files]); }}>
        <div className="empty-ic">{busy ? <Spinner size={18} /> : <I n="film" />}</div>
        <h3>Add {leadField?.label ?? "a clip"}</h3>
        <p>Drop a clip here.{leadWin ? ` ${leadWin[0]}–${leadWin[1]} s; longer clips get trimmed.` : ""}</p>
        {sample && <button className="btn" type="button" onClick={() => set((st) => ({ videos: withClip(st, lead, sample) }))}>Use sample</button>}
      </div>
    );
  }

  if ((motion || videoOut) && (eff === "compare" || eff === "result") && shown && result) {
    const src = drove ? { kind: "video" as const, src: fileUrl(shown.id, drove.file!), poster: fileUrl(shown.id, posterOf(drove.file!)), label: "Source" } : null;
    const res = { kind: (shown.result?.kind ?? "video") as "video" | "image", src: result, poster: shown.result?.poster ? fileUrl(shown.id, shown.result.poster) : null, label: "Result" };
    return <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}><ABPlayer a={eff === "compare" ? src : null} b={res} /></div>;
  }

  if (motion && eff === "input" && clip) {
    const leadFps = clipFps(engine, clip.slot);
    return (
      <div className="frame" style={{ "--ar": ar } as CSSProperties}>
        <video key={clip.url} src={clip.url} poster={clip.poster ?? undefined} muted loop playsInline autoPlay controls={!clip.crop} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        {clip.crop && <CropBox crop={clip.crop} onChange={(crop) => set(withInput(clip.slot, { crop }))} />}
        {clip.width && clip.height ? <div className="corner l"><span className="pill mono">Source {clip.width}×{clip.height}</span></div> : null}
        <div className="corner r"><span className="pill mono" title="OpenIllusion crops and sizes every frame to this before the run. What the workflow makes of it is up to the workflow.">
          {out ? `In ${dimsText(out)} · ` : ""}{((clip.trim[1] || clip.duration || 0) - clip.trim[0]).toFixed(1)} s{leadFps[0] === leadFps[1] ? ` · ${leadFps[0]} fps` : ""}
        </span></div>
      </div>
    );
  }

  if (eff === "empty") {
    const sample = engine ? sampleRef(engine, lead) : null;
    return (
      <div data-own-drop className={cx("empty", over && "drag")} style={{ padding: 20, borderRadius: 18, border: `1.5px dashed ${over ? "var(--violet)" : "var(--line-2)"}` }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); void dropIntoStudio(mode, [...e.dataTransfer.files]); }}>
        <div className="empty-ic">{busy ? <Spinner size={18} /> : <I n="image" />}</div>
        <h3>Add {leadField?.label ?? "a photo"}</h3>
        <p>Drop a photo here. Several fill the inputs in order.</p>
        {sample && <button className="btn" type="button" onClick={() => set((st) => ({ refs: bySlot([...bySlot(st.refs).filter((r) => r.slot !== sample.slot), sample]) }))}>Use sample</button>}
      </div>
    );
  }

  if (eff === "grid") {
    const rows = group.length > 2 ? 2 : 1;
    const a = ar;
    return (
      <div className="vstage" style={{ "--ar": a, "--cw": `min(calc((100cqw - 12px) / 2), calc((100cqh - ${(rows - 1) * 12}px) / ${rows} * ${a}))` } as CSSProperties}>
        {group.map((id, i) => {
          const v = vlist.find((x) => x.id === id);
          const j = jobs.find((x) => x.id === id);
          return <VCell key={id} n={i + 1} v={v} job={j} fallback={beforeUrl} onOpen={() => onFocus(id)} />;
        })}
      </div>
    );
  }

  if (eff === "live" && shown) {
    const q = !!job && QUEUED.has(job.state);
    const p = jobProgress(job);
    const steps = job?.progress?.steps;
    const step = job?.progress?.step;
    const img = job?.preview ?? beforeUrl;
    return (
      <div className="frame live" style={{ "--ar": ar, "--p": p } as CSSProperties}>
        {img && <img src={img} alt="" style={q || !job?.preview ? { filter: "blur(8px) saturate(.3) brightness(.55)" } : undefined} />}
        <div className="noise" style={q ? { opacity: 0.18 } : undefined} />
        <div className="hud"><div className="hud-in">
          <Ring p={p} />
          <b>{q ? "Waiting in queue" : job?.state === "downloading" ? "Saving result" : "Sampling"}</b>
          <span>{q ? (job?.queue_position ? `#${job.queue_position} in queue` : "starts after the current run")
            : step && steps ? `step ${step}/${steps}` : job?.progress?.nodes_total ? `node ${job.progress.nodes_done ?? 0}/${job.progress.nodes_total}` : job?.detail || "starting"}</span>
        </div></div>
        {job && <div className="corner r"><button className="btn sm glass" type="button" onClick={async () => { await api.cancel(job.id); qc.invalidateQueries({ queryKey: ["jobs"] }); }}>Cancel</button></div>}
      </div>
    );
  }

  if (eff === "failed" && shown) {
    return (
      <div className="frame" style={{ "--ar": ar } as CSSProperties}>
        {beforeUrl && <img src={beforeUrl} alt="" style={{ filter: "saturate(.3) brightness(.4)" }} />}
        <div style={{ position: "absolute", inset: 0, zIndex: 3, display: "grid", placeItems: "center", padding: 16, background: "linear-gradient(rgba(255,107,126,.06),rgba(255,107,126,.14))", overflow: "auto" }}>
          <StageError state={shown.status} error={job?.error ?? shown.result?.error} detail={job?.detail} fixes={fixes} compact />
        </div>
      </div>
    );
  }

  if ((eff === "compare" || eff === "result") && shown?.result?.file) {
    const after = fileUrl(shown.id, shown.result.file);
    const dims = size ? `${size.w}×${size.h}` : "";
    return (
      <div className="frame" style={{ "--ar": ar } as CSSProperties}>
        {eff === "compare" && beforeUrl ? <Compare key={after} before={beforeUrl} after={after} lb="Input" la="Result" intro /> : <img src={after} alt="Result" className="alpha" />}
        {eff === "result" && <div className="corner r"><span className="pill mono">{dims}{shown.result.seed != null ? `${dims ? " · " : ""}seed ${shown.result.seed}` : ""}</span></div>}
      </div>
    );
  }

  if (!base) return null;
  return <InputFrame base={base} out={out} set={set} />;
}

/** Pixel size of an image, once it loads. */
function useImageSize(url: string | null) {
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.onload = () => { if (live && img.naturalWidth) setSize({ url, w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = url;
    return () => { live = false; };
  }, [url]);
  return size && size.url === url ? size : null;
}

/** The input photo, with its crop box. */
function InputFrame({ base, out, set }: { base: RefSlot; out: { width: number; height: number } | null; set: SetS }) {
  const [nat, setNat] = useState<{ w: number; h: number } | null>(base.width && base.height ? { w: base.width, h: base.height } : null);
  useLayoutEffect(() => setNat(base.width && base.height ? { w: base.width, h: base.height } : null), [base.url, base.width, base.height]);
  const ar = nat ? nat.w / nat.h : 1;

  return (
    <div className="frame" style={{ "--ar": ar } as CSSProperties}>
      <img src={base.url} alt="Input" draggable={false} onLoad={(e) => { const i = e.currentTarget; if (!nat && i.naturalWidth) setNat({ w: i.naturalWidth, h: i.naturalHeight }); }} />
      {base.crop && (
        <CropBox crop={base.crop} onChange={(crop) => set((st) => ({ refs: st.refs.map((r, i) => (slotOf(r, i) === 1 ? { ...r, crop } : r)), current: null }))} />
      )}
      {nat && <div className="corner l"><span className="pill mono">Source {nat.w}×{nat.h}</span></div>}
      {out && <div className="corner r"><span className="pill mono" title="OpenIllusion crops and sizes the photo to this before the run. What the workflow makes of it is up to the workflow.">In {dimsText(out)} · {aspectName(out)}</span></div>}
    </div>
  );
}

/** The kept part of a cropped input. Its shape is set by the Shape buttons; drag it (or use the arrow keys) to choose what stays. */
function CropBox({ crop, onChange }: { crop: Crop; onChange: (c: Crop) => void }) {
  const [x, y, w, h] = crop;
  const place = (nx: number, ny: number) => onChange([Math.min(Math.max(nx, 0), 1 - w), Math.min(Math.max(ny, 0), 1 - h), w, h]);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const t = e.currentTarget;
    const r = t.parentElement!.getBoundingClientRect();
    const [x0, y0] = [e.clientX, e.clientY];
    t.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => place(x + (ev.clientX - x0) / r.width, y + (ev.clientY - y0) / r.height);
    const up = () => { t.removeEventListener("pointermove", move); t.removeEventListener("pointerup", up); t.removeEventListener("pointercancel", up); };
    t.addEventListener("pointermove", move);
    t.addEventListener("pointerup", up);
    t.addEventListener("pointercancel", up);
  };
  const key = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? 0.1 : 0.01;
    const step = { ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] }[e.key];
    if (!step) return;
    e.preventDefault();
    place(x + step[0], y + step[1]);
  };
  const [l, t, r, b] = [x * 100, y * 100, (x + w) * 100, (y + h) * 100];
  const hole = `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l}% ${t}%, ${l}% ${b}%, ${r}% ${b}%, ${r}% ${t}%, ${l}% ${t}%)`;
  return (
    <>
    <div className="cropshade" style={{ clipPath: hole }} />
    <div className="cropbox" role="group" tabIndex={0} aria-label="Crop frame. Drag or use the arrow keys to move it." title="Drag to choose what stays"
      style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }} onPointerDown={down} onKeyDown={key}>
      <i /><i /><i /><i />
    </div>
    </>
  );
}

/** A small outline at a shape's proportions, for the Shape buttons. */
function ShapeIcon({ r }: { r: number }) {
  const [w, h] = r >= 1 ? [14, 14 / r] : [14 * r, 14];
  return <svg className="shape-ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x={8 - w / 2} y={8 - h / 2} width={w} height={h} rx="2" /></svg>;
}

function VCell({ n, v, job, fallback, onOpen }: { n: number; v?: Manifest; job?: Job; fallback?: string; onOpen: () => void }) {
  const live = !!job && isActive(job);
  const q = live && QUEUED.has(job!.state);
  const p = jobProgress(job);
  const done = v?.status === "done" && v.result?.file;
  const failed = v && !live && FAILED.has(v.status);
  const img = done ? fileUrl(v!.id, v!.result!.poster ?? v!.result!.file!) : job?.preview ?? fallback;
  return (
    <div className={cx("vcell", live && "live")} style={{ "--p": p } as CSSProperties} role="button" tabIndex={0} aria-label={`Variant ${n}`}
      onClick={onOpen} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpen(); } }}>
      {img && <img src={img} alt="" style={!done ? { filter: "blur(8px) saturate(.3) brightness(.55)" } : undefined} />}
      {live && (
        <>
          <div className="noise" style={q ? { opacity: 0.18 } : undefined} />
          <div className="hud"><div className="hud-in"><Ring p={p} sm /><span>{q ? "waiting" : job?.progress?.step && job.progress.steps ? `${job.progress.step}/${job.progress.steps}` : "starting"}</span></div></div>
        </>
      )}
      {failed && <div className="gfail"><span className="ic"><I n="alert" /></span><b>{v!.status === "cancelled" ? "Cancelled" : "Failed"}</b></div>}
      <div className="corner l"><span className="pill mono">{n}{v?.result?.seed != null ? ` · seed ${v.result.seed}` : ""}</span></div>
    </div>
  );
}

/* ---------------------------------------------------------------- prompt + run */

/** The prompt, whole: what's in the box is what the workflow gets. Ideas swap in a complete prompt. */
function PromptSection({ s, set, engine, invalid, onRun }: {
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
function RunBar({ s, set, engine, runner, estimate, queued, varies }: {
  s: StudioState; set: SetS; engine?: EngineInfo; runner: ReturnType<typeof useRunner>; estimate?: ReturnType<typeof useCompose>["estimate"]; queued: number; varies: boolean;
}) {
  const status = useStatus();
  const media = mediaFields(engine);
  const held = (f: MediaField) => f.type === "video"
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

function useRuns(engine: string) {
  return useQuery({
    queryKey: ["generations", "runs", engine],
    queryFn: () => api.generations({ model: engine, shelf: "mine" }),
    enabled: !!engine,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === "running") ? 5000 : false),
  });
}

function HThumb({ g, on, job, onPick }: { g: GenerationRow; on: boolean; job?: Job; onPick: () => void }) {
  const live = (!!job && isActive(job)) || g.status === "running";
  const failed = !live && FAILED.has(g.status);
  const img = (live && job?.preview) || (g.poster ? fileUrl(g.id, g.poster) : null);
  return (
    <button className={cx("hthumb", failed && "failed")} type="button" aria-current={on} onClick={onPick} style={{ "--p": jobProgress(job) } as CSSProperties}
      aria-label={`${g.prompt || g.title}, ${live ? "running" : failed ? `failed: ${g.error ?? "open it to see why"}` : "done"}`}
      title={failed ? `Failed · ${g.error ?? "open it to see why"}` : g.prompt || g.title}>
      {img ? <img src={img} alt="" style={live ? { filter: "blur(6px) saturate(.3)" } : undefined} /> : <span style={{ position: "absolute", inset: 0, background: "var(--raised)" }} />}
      {live && <Ring p={jobProgress(job)} sm />}
    </button>
  );
}

function HistList({ engine, current, jobs, onPick }: { engine: string; current: string | null; jobs: Job[]; onPick: (id: string) => void }) {
  const runs = useRuns(engine);
  const list = runs.data ?? [];
  return (
    <>
      <h5>Runs · {list.length}</h5>
      <div className="hist-list">
        {list.length ? list.slice(0, 60).map((g) => <HThumb key={g.id} g={g} on={g.id === current} job={jobs.find((j) => j.id === g.id)} onPick={() => onPick(g.id)} />)
          : <p className="none">{runs.isLoading ? "…" : "Your runs of this template land here."}</p>}
      </div>
    </>
  );
}

function HistStrip({ engine, current, jobs, onPick }: { engine: string; current: string | null; jobs: Job[]; onPick: (id: string) => void }) {
  const runs = useRuns(engine);
  const list = useMemo(() => (runs.data ?? []).slice(0, 30), [runs.data]);
  if (!list.length) return null;
  return (
    <div className="hist-strip" aria-label="Runs of this template">
      <span className="lab">Runs</span>
      {list.map((g) => <HThumb key={g.id} g={g} on={g.id === current} job={jobs.find((j) => j.id === g.id)} onPick={() => onPick(g.id)} />)}
    </div>
  );
}

