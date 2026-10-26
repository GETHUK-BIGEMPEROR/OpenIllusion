import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ABPlayer, typing } from "../components/ABPlayer";
import { CostPill } from "../components/bits";
import { useEngine, ParamFields } from "../components/Engine";
import { Compare, cx, I, jobProgress, QUEUED, Ring, useStatus, gpuName } from "../components/oi";
import { addToTray, bySlot, RefTray, useUploader, withRefs } from "../components/Refs";
import {
  invalidFields, LocalNeeds, NoTemplates, RawRequest, StageError, useCompose, useCurrent, useRunner, useStudio, type Fix,
} from "../components/Studio";
import { tplCategory, tplModel, tplName } from "../components/TemplateCard";
import { Trimmer } from "../components/Trimmer";
import { Spinner } from "../components/ui";
import { api, fileUrl, type EngineInfo, type GenerationRow, type Job, type Manifest, type Mode, type ParamSpec, type SizeSpec } from "../lib/api";
import { areaField, article, leadSlot, mediaFields, promptField, roleOf, settingsOf, slotNo, videoField, type MediaField } from "../lib/fields";
import { EDIT_ROLES, errMsg, ROLES, roleLabel } from "../lib/format";
import { isActive, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { newKey, slotOf, useApp, type RefSlot, type StudioState, type VideoSlot } from "../lib/store";
import { aspectName, choiceOf, dimsText, megapixels, plan, plans, SHAPES, shapeCrop, shapeOf, sizeNotes, usePrepImages, type Crop, type PrepInput } from "../lib/size";

type View = "input" | "result" | "compare" | "grid";
type SetS = ReturnType<typeof useStudio>[1];

const ACCEPT = "image/png,image/jpeg,image/webp";
const ACCEPT_VIDEO = "video/mp4,video/quicktime,video/webm,.m4v";
const FAILED = new Set(["failed", "moderated", "cancelled"]);
const AREA = "Keep the edit inside this area";

/** A studio change to one input's attributes (shape, size), photo or clip alike. */
const withInput = (slot: string, patch: { crop?: Crop; size?: string }) => (st: StudioState): Partial<StudioState> => slot.startsWith("video:")
  ? { video: st.video ? { ...st.video, ...patch } : null, current: null }
  : { refs: st.refs.map((r, i) => (`image:${slotOf(r, i)}` === slot ? { ...r, ...patch } : r)), current: null };

/** A template's sample for one photo input, as a tray entry. */
function sampleRef(e: EngineInfo, slot: string): RefSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === slot);
  if (!i) return null;
  return { ...i, key: newKey(), slot: slotNo(slot), sample: true, license: "stock", contains_person: false, consent: false, role: roleOf(e, slot) };
}

/** A template's sample clip, trimmed to fit its window. */
function sampleVideo(e: EngineInfo, slot: string): VideoSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === slot);
  if (!i) return null;
  const d = i.duration ?? 0;
  return { ...i, trim: [0, e.video_window ? Math.min(d, e.video_window[1]) : d], sample: true, license: "stock", contains_person: false, consent: false };
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
  const markable = areaField(engine, mode);
  const { spec, compose, estimate } = useCompose(mode, s, engine);
  const { generation: m, job } = useCurrent(s.current);
  const invalid = invalidFields(compose, job?.error);
  const share = useApp((st) => st.share);
  const toast = useApp((st) => st.toast);
  const setStudio = useApp((st) => st.setStudio);
  const { data: jobs = [] } = useJobs();
  const [view, setView] = useState<View>("input");
  const [marking, setMarking] = useState(false);

  const base = leadVideo ? undefined : s.refs.find((r, i) => `image:${slotOf(r, i)}` === lead);
  const clip = (vField || (!engine?.fields?.length && mode === "motion")) && s.video && !s.video.missing ? s.video : null;
  const hasInput = leadVideo ? !!clip : !!base;
  const photos = usePrepImages(s.refs);
  const clipSlot = vField?.key ?? "video:1";
  const images: PrepInput[] = clip?.width && clip.height ? [...photos, { slot: clipSlot, width: clip.width, height: clip.height, crop: clip.crop, size: clip.size }] : photos;
  const sized = engine?.size;
  const local = sized ? plans(sized, images) : {};
  const planOf = (slot: string) => compose?.prep?.[slot] ?? local[slot] ?? null;
  const out = sized ? planOf(sized.follows) : null;

  const group = s.group.length ? s.group : s.current ? [s.current] : [];
  const variants = useQueries({ queries: group.map((id) => ({ queryKey: ["generation", id], queryFn: () => api.generation(id), retry: false })) });
  const vlist = variants.map((q) => q.data).filter(Boolean) as Manifest[];
  const shown = (m && group.includes(m.id) ? m : null) ?? vlist.find((v) => v.id === s.current) ?? m ?? vlist[0] ?? null;
  const shownJob = shown ? jobs.find((j) => j.id === shown.id) : job ?? undefined;
  const anyDone = vlist.some((v) => v.status === "done");
  const live = !!shownJob && isActive(shownJob);
  const done = shown?.status === "done" && !!shown.result?.file;
  const failed = shown && !live && FAILED.has(shown.status) ? shown : null;
  const area = s.boxes.find((b) => b.label === AREA);

  // What the stage shows, given what exists.
  const eff: View | "live" | "failed" | "empty" =
    view === "grid" && group.length > 1 ? "grid"
      : !shown || view === "input" ? (hasInput ? "input" : "empty")
      : live ? "live" : failed ? "failed" : !done ? (hasInput ? "input" : "empty")
      : view === "result" ? "result" : "compare";

  // A run that finishes while you watch flips the stage to its result.
  const prevState = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevState.current && prevState.current !== "done" && job?.state === "done" && view === "input") setView("compare");
    prevState.current = job?.state;
  }, [job?.state, view]);

  const runner = useRunner({
    s, set, spec, compose, estimate,
    onRan: (ids) => { set({ group: ids }); setView(ids.length > 1 ? "grid" : "compare"); setMarking(false); },
  });

  const star = (id: string) => set((st) => ({ selected: st.selected.includes(id) ? st.selected.filter((x) => x !== id) : [...st.selected, id] }));

  // Finished photos can go on to a video template.
  const sendToMotion = () => {
    const picks = (s.selected.length ? s.selected : s.current ? [s.current] : []).map((id) => vlist.find((v) => v.id === id) ?? (m?.id === id ? m : undefined))
      .filter((v): v is Manifest => !!v && v.status === "done" && !!v.result?.file);
    if (!picks.length) return toast({ text: "Star a finished variant first.", tone: "warn" });
    const role = s.returnRole ?? "character";
    setStudio("motion", (mo) => {
      const add: RefSlot[] = picks.map((v) => ({
        key: newKey(), asset: `gen:${v.id}/${v.result!.file}`, name: `${v.title}.webp`, kind: "image", url: fileUrl(v.id, v.result!.file!),
        role, license: "generated", contains_person: base?.contains_person ?? false, consent: base?.consent ?? false,
      }));
      return { refs: [...mo.refs, ...add].slice(0, 9), chain: [...new Set([...mo.chain, ...picks.map((v) => `edit:${v.id}`)])], current: null };
    });
    set({ returnRole: null });
    toast({ text: `${picks.length} image${picks.length > 1 ? "s" : ""} sent to Video as ${roleLabel(role)}.`, tone: "ok", action: { label: "Open", run: () => go({ name: "motion" }) } });
  };

  const rerun = async (id: string) => {
    try {
      const { ids } = await api.rerun(id);
      set((st) => ({ current: ids[0], group: ids, session: [...ids, ...st.session] }));
      setView("compare");
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
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
      const leadIn = sized && images.find((i) => i.slot === sized.follows);
      const smaller = sized && leadIn ? sized.options
        .map((o) => ({ o, p: plans(sized, [{ ...leadIn, size: o.label }])[leadIn.slot] }))
        .filter((x) => out && x.p.width * x.p.height < out.width * out.height)
        .sort((a, b) => b.p.width * b.p.height - a.p.width * a.p.height)[0] : undefined;
      if (smaller && leadIn) fixes.push({ label: `Use ${smaller.o.label} (${dimsText(smaller.p)})`, run: () => { set(withInput(leadIn.slot, { size: smaller.o.label })); toast({ text: `Size set to ${smaller.o.label}. Press Run.`, tone: "ok" }); } });
      else if (size) fixes.push({ label: "Use a smaller size", run: () => { const opts = size.options ?? []; const i = opts.indexOf(String(s.params[size.key] ?? size.default)); if (opts.length && i > 0) { set((st) => ({ params: { ...st.params, [size.key]: opts[i - 1] }, raw: null })); toast({ text: `${size.label} set to ${opts[i - 1]}. Press Run.`, tone: "ok" }); } else if (size.type === "int") { set((st) => ({ params: { ...st.params, [size.key]: size.min ?? size.default }, raw: null })); } } });
    }
    if (suggested.includes("trim") && s.video) {
      const w = engine?.video_window?.[1] ?? 10;
      fixes.push({ label: `Trim to ${w} s`, run: () => set({ video: { ...s.video!, trim: [s.video!.trim[0], s.video!.trim[0] + Math.min(w, s.video!.trim[1] - s.video!.trim[0])] } }) });
    }
    if (suggested.includes("downscale") && s.video && !sized) fixes.push({ label: "Downscale to 720p", run: () => { set({ video: { ...s.video!, maxHeight: 720 } }); toast({ text: "The clip is re-encoded at 720p on the next run.", tone: "ok" }); } });
    if (suggested.includes("rerun") || failed.status !== "cancelled") fixes.push({ label: "Try again", run: () => rerun(failed.id), primary: true });
  }

  if (!s.engine && !engine) return <NoTemplates mode={mode} />;

  const canMark = !!markable && markable === lead && eff === "input" && !!base;
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

          <section className="sec" aria-labelledby="sec-inputs">
            <div className="sec-h"><h4 id="sec-inputs">Inputs</h4><span className="mono">{media.length ? `${required} needed${media.length > required ? ` · ${media.length - required} optional` : ""}` : `${s.refs.length} / ${engine?.max_images ?? 10}`}</span></div>
            {engine && media.length ? (
              <div className="slots">
                {media.map((f) => f.type === "video"
                  ? <ClipRow key={f.key} e={engine} f={f} v={s.video} staged={f.key === lead} onChange={(video) => set({ video, current: null })} />
                  : f.type === "image" ? <PhotoRow key={f.key} e={engine} f={f} refs={s.refs} staged={f.key === lead} onChange={(refs) => set({ refs, current: null })} />
                  : null)}
              </div>
            ) : (
              <div data-own-drop>
                <RefTray refs={s.refs} max={engine?.max_images ?? 10} roles={mode === "motion" ? ROLES : EDIT_ROLES} defaultRole={mode === "motion" ? "character" : "base"} aspect="1 / 1" onChange={(refs) => set({ refs })} />
                <p className="help">Drag to reorder. Image 1 goes first.</p>
              </div>
            )}
          </section>

          <PromptSection s={s} set={set} engine={engine} area={!!area} invalid={invalid.has("prompt")} onRun={() => void runner.run()}
            clearArea={() => set((st) => ({ boxes: st.boxes.filter((b) => b.label !== AREA) }))} />

          {!!settings.main.length && (
            <section className="sec" aria-labelledby="sec-set">
              <div className="sec-h"><h4 id="sec-set">Settings</h4></div>
              <div className="adv-body" style={{ padding: 0 }}>
                <ParamFields params={settings.main} values={s.params} invalid={invalid} onChange={setParam} />
              </div>
            </section>
          )}

          <details className="adv">
            <summary><I n="sliders" />Advanced<span className="mono">{advSummary(settings.advanced, s)}</span><I n="down" className="chev" /></summary>
            <div className="adv-body">
              {engine && <ParamFields params={settings.advanced} values={s.params} invalid={invalid} onChange={setParam} />}
              <div style={{ margin: "0 -14px -14px", borderTop: "1px solid var(--line)" }}><RawRequest s={s} set={set} spec={spec} compose={compose} /></div>
            </div>
          </details>
        </div>
        <RunBar s={s} set={set} engine={engine} runner={runner} estimate={estimate} queued={jobs.filter(isActive).length} />
      </aside>

      <section className="stage" aria-label="Preview">
        <div className="stage-top" data-acts={done && shown ? "" : undefined}>
          <div className="crumb">Create<span>/</span><b>{engine ? tplName(engine) : "…"}</b></div>
          <span style={{ flex: 1 }} />
          <div className="seg" role="group" aria-label="Preview mode">
            <button type="button" aria-pressed={eff === "input" || eff === "empty"} onClick={() => setView("input")}>Input</button>
            <button type="button" aria-pressed={eff === "result"} disabled={!done} onClick={() => setView("result")}>Result</button>
            <button type="button" aria-pressed={eff === "compare"} disabled={!done} onClick={() => setView("compare")}><I n="compare" />Compare</button>
            {group.length > 1 && <button type="button" aria-pressed={eff === "grid"} onClick={() => setView("grid")}><I n="grid" />All {group.length}</button>}
          </div>
          <span style={{ flex: 1 }} />
          {done && shown && (
            <>
              <button className="btn sm ghost" type="button" onClick={() => rerun(shown.id)} title="Same recipe, new seed"><I n="refresh" /><span className="lbl">Re-run</span></button>
              <button className="btn sm ghost" type="button" onClick={() => remix(shown)} title="Load this run's inputs and settings as a new draft"><I n="remix" /><span className="lbl">Remix</span></button>
              {anyDone && shown.result?.kind !== "video" && <button className="btn sm ghost" type="button" onClick={sendToMotion} title={`Lands in the video template's inputs as ${roleLabel(s.returnRole ?? "character")}`}><I n="film" /><span className="lbl">{s.selected.length ? `Send ${s.selected.length} to Video` : "To Video"}</span></button>}
              <button className="btn sm" type="button" onClick={() => share(shown.id)} aria-keyshortcuts="E" title="Export (E)"><I n="share" /><span className="lbl">Export</span></button>
            </>
          )}
          {!!markable && (
            <button className={cx("btn sm", marking ? "primary" : "ghost")} type="button" disabled={!canMark && !area}
              onClick={() => (area ? set((st) => ({ boxes: st.boxes.filter((b) => b.label !== AREA) })) : setMarking(!marking))}
              title="Drag on the photo to keep the edit inside one area">
              <I n="area" /><span className="lbl">{area ? "Clear area" : marking ? "Drag on photo" : "Mark area"}</span>
            </button>
          )}
          <button className="icon-btn" type="button" aria-label="Open in Library" title="Open in Library" disabled={!shown} style={shown ? undefined : { opacity: 0.35 }}
            onClick={() => shown && go({ name: "generation", id: shown.id })}><I n="expand" /></button>
        </div>

        <div className="canvas">
          <Canvas mode={mode} lead={lead} eff={eff} s={s} set={set} engine={engine} base={base} out={planOf(lead)} shown={shown} job={shownJob} group={group} vlist={vlist} jobs={jobs}
            marking={marking} setMarking={setMarking} fixes={fixes} onFocus={(id) => { set({ current: id }); setView("compare"); }} onStar={star} />
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
              {tplName(x)}<small>{tplCategory(x)}</small>
            </button>
          ))}
          <button type="button" onClick={() => { setOpen(false); openTemplate(e.mode, e.id); }}><span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n="undo" /></span>Start over with the samples</button>
          <button type="button" onClick={() => { setOpen(false); go({ name: "explore", t: e.id }); }}><span className="empty-ic" style={{ width: 34, height: 34, margin: 0, borderRadius: 8 }}><I n="compass" /></span>Browse all on Explore</button>
        </div>
      )}
      {e.blurb && <p className="thero-blurb">{e.blurb}</p>}
    </div>
  );
}

/** One photo input: click, drop, or bring the sample back; its shape and size under it. */
function PhotoRow({ e, f, refs, staged, onChange }: { e: EngineInfo; f: MediaField; refs: RefSlot[]; staged: boolean; onChange: (refs: RefSlot[]) => void }) {
  const { upload } = useUploader();
  const [busy, setBusy] = useState(false);
  const n = slotNo(f.key);
  const r = refs.find((x, i) => slotOf(x, i) === n);
  const put = (x: RefSlot | null) => onChange(bySlot([...bySlot(refs).filter((y) => y.slot !== n), ...(x ? [x] : [])]));
  const fill = async (files: File[]) => {
    const file = files.find((x) => /^image\//.test(x.type)) ?? files[0];
    if (!file) return;
    setBusy(true);
    try {
      const [asset] = await upload([file], "image");
      if (!asset) return;
      const [added] = withRefs([], [asset], EDIT_ROLES, "base");
      put({ ...added, slot: n, size: r?.size, role: roleOf(e, f.key) });
    } finally {
      setBusy(false);
    }
  };
  const sample = sampleRef(e, f.key);
  const attrs = r?.url && !r.missing && r.width && r.height && e.size
    ? <InputAttrs size={e.size} input={{ slot: f.key, width: r.width, height: r.height, crop: r.crop, size: r.size }} preview={r.url} staged={staged}
        onChange={(patch) => put({ ...r, ...patch })} />
    : null;
  return (
    <SlotRow n={n} label={f.label} hint={f.hint} optional={f.required === false} r={r} busy={busy} attrs={attrs}
      sample={!!sample} onFiles={fill} onClear={() => put(null)} onSample={() => put(sampleRef(e, f.key))} />
  );
}

/** A clip input: a row like the photo ones, with the trimmer under it. */
function ClipRow({ e, f, v, staged, onChange }: { e: EngineInfo; f: MediaField; v: VideoSlot | null; staged: boolean; onChange: (v: VideoSlot | null) => void }) {
  const { label, hint } = f;
  const { upload, busy } = useUploader();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const win = e.video_window;
  const pick = () => input.current?.click();
  const fill = async (files: File[]) => {
    const f = files.find((x) => /^video\//.test(x.type)) ?? files[0];
    if (!f) return;
    const [a] = await upload([f], "video");
    if (!a) return;
    const d = a.duration ?? 0;
    onChange({ ...a, trim: [0, win ? Math.min(d, win[1]) : d], size: v?.size, license: "own-footage", contains_person: true, consent: false });
  };
  const drop = {
    onDragOver: (ev: React.DragEvent) => { if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); ev.stopPropagation(); setOver(true); } },
    onDragLeave: (ev: React.DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver(false); },
    onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.files.length) return; ev.preventDefault(); ev.stopPropagation(); setOver(false); void fill([...ev.dataTransfer.files]); },
  };
  const file = <input ref={input} type="file" accept={ACCEPT_VIDEO} hidden onChange={(ev) => { void fill([...(ev.target.files ?? [])]); ev.target.value = ""; }} />;
  const name = `Video ${slotNo(f.key)} · ${label}`;
  const sample = sampleVideo(e, f.key);
  const span = win ? `${win[0]}–${win[1]} s` : "any length";
  if (!v?.url) {
    return (
      <div data-own-drop {...drop} className={cx("slotrow empty", over && "drag")} role="button" tabIndex={0} aria-label={`Add ${label.toLowerCase()}${hint ? `. ${hint}` : ""}`}
        onClick={pick} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); pick(); } }}>
        {file}
        <span className="sth">{busy ? <Spinner size={16} /> : <I n="film" />}</span>
        <div className="st"><b>{name}</b><span className="sub" style={{ fontFamily: "var(--body)" }}>{hint ?? `Drop a clip or click to browse · ${span}`}</span></div>
        {sample && <button className="btn sm ghost" type="button" onClick={(ev) => { ev.stopPropagation(); onChange(sample); }}>Use sample</button>}
      </div>
    );
  }
  const len = (v.trim[1] || v.duration || 0) - v.trim[0];
  const prepIn: PrepInput | null = !v.missing && v.width && v.height ? { slot: f.key, width: v.width, height: v.height, crop: v.crop, size: v.size } : null;
  const p = prepIn && e.size ? plans(e.size, [prepIn])[prepIn.slot] : null;
  return (
    <div className="cliprow">
      <div data-own-drop {...drop} className={cx("slotrow", over && "drag")}>
        {file}
        <button className="sth" type="button" onClick={pick} aria-label={`Replace ${label.toLowerCase()}`}>
          {v.poster ? <img src={v.poster} alt="" style={v.missing ? { opacity: 0.5 } : undefined} /> : <I n="film" />}
          {busy ? <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,.45)" }}><Spinner size={16} /></span>
            : <span className="dur">{len.toFixed(1)}s</span>}
        </button>
        <div className="st">
          <b>{name}</b>
          <span className="sub">
            {v.missing ? <span style={{ color: "var(--orange)" }}>File missing · replace it</span>
              : v.sample ? <span className="tag-sample">SAMPLE</span> : <span style={{ color: "var(--mint)" }}>Your clip</span>}
            {v.width && v.height ? `${v.width}×${v.height}` : ""}
          </span>
        </div>
        <div className="sacts">
          <button className="icon-btn sm" type="button" onClick={pick} aria-label={`Replace ${label.toLowerCase()}`} title="Replace"><I n="refresh" /></button>
          <button className="icon-btn sm" type="button" onClick={() => onChange(null)} aria-label={`Remove ${label.toLowerCase()}`} title="Remove"><I n="x" /></button>
        </div>
      </div>
      {prepIn && e.size && <InputAttrs size={e.size} input={prepIn} preview={v.poster ?? undefined} staged={staged} onChange={(patch) => onChange({ ...v, ...patch })} />}
      {!v.missing && !!v.duration && (
        <Trimmer src={v.url} duration={v.duration} trim={v.trim} onChange={(trim) => onChange({ ...v, trim })} window={win} fps={e.fps_window[0] === e.fps_window[1] ? e.fps_window[0] : v.fps}
          height={p?.height ?? v.height} />
      )}
    </div>
  );
}

function SlotRow({ n, label, hint, optional, r, busy, sample, attrs, onFiles, onClear, onSample }: {
  n: number; label: string; hint?: string; optional?: boolean; r?: RefSlot; busy: boolean; sample: boolean; attrs?: ReactNode; onFiles: (f: File[]) => void; onClear: () => void; onSample: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = () => input.current?.click();
  const drop = {
    onDragOver: (ev: React.DragEvent) => { if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); ev.stopPropagation(); setOver(true); } },
    onDragLeave: (ev: React.DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver(false); },
    onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.files.length) return; ev.preventDefault(); ev.stopPropagation(); setOver(false); onFiles([...ev.dataTransfer.files]); },
  };
  const name = `Image ${n} · ${label}`;
  const file = <input ref={input} type="file" accept={ACCEPT} hidden onChange={(ev) => { onFiles([...(ev.target.files ?? [])]); ev.target.value = ""; }} />;
  if (!r?.url) {
    return (
      <div data-own-drop {...drop} className={cx("slotrow empty", over && "drag")} role="button" tabIndex={0} aria-label={`Add ${label.toLowerCase()} photo${hint ? `. ${hint}` : ""}`}
        onClick={pick} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); pick(); } }}>
        {file}
        <span className="sth">{busy ? <Spinner size={16} /> : <I n="upload" />}</span>
        <div className="st"><b>{name}{optional && <span className="opt"> · optional</span>}</b><span className="sub" style={{ fontFamily: "var(--body)" }}>{hint ?? "Drop a photo or click to browse"}</span></div>
        {sample && <button className="btn sm ghost" type="button" onClick={(ev) => { ev.stopPropagation(); onSample(); }}>Use sample</button>}
      </div>
    );
  }
  return (
    <div className="inp">
    <div data-own-drop {...drop} className={cx("slotrow", over && "drag")}>
      {file}
      <button className="sth" type="button" onClick={pick} aria-label={`Replace ${label.toLowerCase()} photo`}>
        <img src={r.url} alt="" style={r.missing ? { opacity: 0.5 } : undefined} />
        {busy && <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,.45)" }}><Spinner size={16} /></span>}
      </button>
      <div className="st">
        <b>{name}</b>
        <span className="sub">
          {r.missing ? <span style={{ color: "var(--orange)" }}>File missing · replace it</span>
            : r.sample ? <span className="tag-sample">SAMPLE</span> : <span style={{ color: "var(--mint)" }}>Your photo</span>}
          {r.width && r.height ? `${r.width}×${r.height}` : ""}
        </span>
      </div>
      <div className="sacts">
        <button className="icon-btn sm" type="button" onClick={pick} aria-label={`Replace ${label.toLowerCase()} photo`} title="Replace"><I n="refresh" /></button>
        <button className="icon-btn sm" type="button" onClick={onClear} aria-label={`Remove ${label.toLowerCase()} photo`} title="Remove"><I n="x" /></button>
      </div>
    </div>
    {attrs}
    </div>
  );
}

/**
 * What every photo and clip has: a shape (its own, or a crop to a common one) and a size (its own pixels, or a
 * megapixel budget at its shape). One line under the input; open it to change either. The input on the stage is
 * cropped there, the others in a small preview here.
 */
function InputAttrs({ size, input, preview, staged, onChange }: {
  size: SizeSpec; input: PrepInput; preview?: string; staged: boolean; onChange: (patch: { crop?: Crop; size?: string }) => void;
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

function Canvas({ mode, lead, eff, s, set, engine, base, out, shown, job, group, vlist, jobs, marking, setMarking, fixes, onFocus, onStar }: {
  mode: Mode; lead: string; eff: View | "live" | "failed" | "empty"; s: StudioState; set: SetS; engine?: EngineInfo; base?: RefSlot; out: { width: number; height: number } | null;
  shown: Manifest | null; job?: Job; group: string[]; vlist: Manifest[]; jobs: Job[]; marking: boolean; setMarking: (v: boolean) => void; fixes: Fix[];
  onFocus: (id: string) => void; onStar: (id: string) => void;
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
  const drove = shown?.inputs.find((i) => i.slot.startsWith("video:") && i.file);
  const clip = s.video && !s.video.missing ? s.video : null;
  const ar = motion
    ? (drove?.width && drove.height ? drove.width / drove.height : clip?.width && clip.height ? clip.width / clip.height : 16 / 9)
    : size ? size.w / size.h : out ? out.width / out.height : base?.width && base?.height ? base.width / base.height : 1;
  const before = shown?.inputs.find((i) => i.slot === lead)?.file;
  const beforeUrl = motion
    ? (shown && drove ? fileUrl(shown.id, "driving/poster.webp") : clip?.poster ?? undefined)
    : shown && before ? fileUrl(shown.id, before) : base?.url;

  if (eff === "empty" && motion) {
    const sample = engine ? sampleVideo(engine, lead) : null;
    const fill = async (files: File[]) => {
      const f = files.find((x) => /^video\//.test(x.type));
      if (!f) return;
      const [a] = await upload([f], "video");
      if (!a) return;
      const w = engine?.video_window;
      const d = a.duration ?? 0;
      set({ video: { ...a, trim: [0, w ? Math.min(d, w[1]) : d], license: "own-footage", contains_person: true, consent: false }, current: null });
    };
    return (
      <div data-own-drop className={cx("empty", over && "drag")} style={{ padding: 20, borderRadius: 18, border: `1.5px dashed ${over ? "var(--violet)" : "var(--line-2)"}` }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); void fill([...e.dataTransfer.files]); }}>
        <div className="empty-ic">{busy ? <Spinner size={18} /> : <I n="film" />}</div>
        <h3>Add {article(leadField?.label ?? "source clip")}</h3>
        <p>Drop it here or on the Video {slotNo(lead)} row.{engine?.video_window ? ` ${engine.video_window[0]}–${engine.video_window[1]} s; longer clips get trimmed.` : ""}</p>
        {sample && <button className="btn" type="button" onClick={() => set({ video: sample })}>Use sample</button>}
      </div>
    );
  }

  if ((motion || videoOut) && (eff === "compare" || eff === "result") && shown && result) {
    const src = drove ? { kind: "video" as const, src: fileUrl(shown.id, drove.file!), poster: fileUrl(shown.id, "driving/poster.webp"), label: "Source" } : null;
    const res = { kind: (shown.result?.kind ?? "video") as "video" | "image", src: result, poster: shown.result?.poster ? fileUrl(shown.id, shown.result.poster) : null, label: "Result" };
    return <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}><ABPlayer a={eff === "compare" ? src : null} b={res} /></div>;
  }

  if (motion && eff === "input" && clip) {
    return (
      <div className="frame" style={{ "--ar": ar } as CSSProperties}>
        <video key={clip.url} src={clip.url} poster={clip.poster ?? undefined} muted loop playsInline autoPlay controls={!clip.crop} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        {clip.crop && <CropBox crop={clip.crop} onChange={(crop) => set((st) => ({ video: st.video ? { ...st.video, crop } : null, current: null }))} />}
        {clip.width && clip.height ? <div className="corner l"><span className="pill mono">In {clip.width}×{clip.height}</span></div> : null}
        <div className="corner r"><span className="pill mono" title="OpenIllusion crops and sizes every frame to this before the run">
          {out ? `Out ${dimsText(out)} · ` : ""}{((clip.trim[1] || clip.duration || 0) - clip.trim[0]).toFixed(1)} s{engine?.fps_window[0] === engine?.fps_window[1] ? ` · ${engine?.fps_window[0]} fps` : ""}
        </span></div>
      </div>
    );
  }

  if (eff === "empty") {
    const first = leadField?.label ?? "photo";
    const sample = engine ? sampleRef(engine, lead) : null;
    return (
      <div data-own-drop className={cx("empty", over && "drag")} style={{ padding: 20, borderRadius: 18, border: `1.5px dashed ${over ? "var(--violet)" : "var(--line-2)"}` }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={async (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); addToTray(mode, await upload([...e.dataTransfer.files].slice(0, engine?.max_images ?? 4), "image")); }}>
        <div className="empty-ic">{busy ? <Spinner size={18} /> : <I n="image" />}</div>
        <h3>Add {article(first)}</h3>
        <p>Drop it here or on the Image {slotNo(lead)} row. Several photos fill the inputs in order.</p>
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
          return <VCell key={id} n={i + 1} v={v} job={j} fallback={beforeUrl} starred={s.selected.includes(id)} onOpen={() => onFocus(id)} onStar={() => onStar(id)} />;
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
        {eff === "compare" && beforeUrl ? <Compare before={beforeUrl} after={after} lb="Input" la="Result" /> : <img src={after} alt="Result" className="alpha" />}
        {eff === "result" && <div className="corner r"><span className="pill mono">{dims}{shown.result.seed != null ? `${dims ? " · " : ""}seed ${shown.result.seed}` : ""}</span></div>}
      </div>
    );
  }

  if (!base) return null;
  return <InputFrame base={base} out={out} s={s} set={set} marking={marking} setMarking={setMarking} cropping />;
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

/** The input photo. With Mark area on, drag a rectangle; the edit stays inside it. */
function InputFrame({ base, out, s, set, marking, setMarking, cropping }: {
  base: RefSlot; out: { width: number; height: number } | null; s: StudioState; set: SetS; marking: boolean; setMarking: (v: boolean) => void; cropping: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(base.width && base.height ? { w: base.width, h: base.height } : null);
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null);
  useLayoutEffect(() => setNat(base.width && base.height ? { w: base.width, h: base.height } : null), [base.url, base.width, base.height]);
  const area = s.boxes.find((b) => b.label === AREA);
  const rect = draft ?? area?.rect ?? null;
  const ar = nat ? nat.w / nat.h : 1;

  const at = (e: { clientX: number; clientY: number }) => {
    const r = el.current!.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))] as const;
  };
  const down = (e: React.PointerEvent) => {
    if (!marking) return;
    e.preventDefault();
    el.current!.setPointerCapture(e.pointerId);
    const [x0, y0] = at(e);
    let box: [number, number, number, number] | null = null;
    const move = (ev: PointerEvent) => {
      const [x1, y1] = at(ev);
      box = [Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0)];
      setDraft(box);
    };
    const up = () => {
      el.current?.removeEventListener("pointermove", move);
      el.current?.removeEventListener("pointerup", up);
      el.current?.removeEventListener("pointercancel", up);
      setDraft(null);
      setMarking(false);
      if (box && box[2] > 0.03 && box[3] > 0.03) {
        const b = box;
        set((st) => ({ boxes: [...st.boxes.filter((x) => x.label !== AREA), { id: newKey(), rect: b, label: AREA }] }));
      }
    };
    el.current!.addEventListener("pointermove", move);
    el.current!.addEventListener("pointerup", up);
    el.current!.addEventListener("pointercancel", up);
  };

  return (
    <div ref={el} className={cx("frame", marking && "marking")} style={{ "--ar": ar } as CSSProperties} onPointerDown={down}>
      <img src={base.url} alt="Input" draggable={false} onLoad={(e) => { const i = e.currentTarget; if (!nat && i.naturalWidth) setNat({ w: i.naturalWidth, h: i.naturalHeight }); }} />
      {cropping && base.crop && !marking && !rect && (
        <CropBox crop={base.crop} onChange={(crop) => set((st) => ({ refs: st.refs.map((r, i) => (slotOf(r, i) === 1 ? { ...r, crop } : r)), current: null }))} />
      )}
      {rect ? (
        <div className="region" style={{ left: `${rect[0] * 100}%`, top: `${rect[1] * 100}%`, width: `${rect[2] * 100}%`, height: `${rect[3] * 100}%` }}><span className="pill yellow">Area</span></div>
      ) : marking ? <div className="tophint"><span className="pill yellow">Drag over the part you want changed</span></div> : null}
      {s.boxes.filter((b) => b.label !== AREA && b.label.trim()).map((b) => (
        <div key={b.id} className="region" style={{ left: `${b.rect[0] * 100}%`, top: `${b.rect[1] * 100}%`, width: `${b.rect[2] * 100}%`, height: `${b.rect[3] * 100}%`, boxShadow: "none", borderStyle: "dashed" }}><span className="pill">{b.label}</span></div>
      ))}
      {nat && <div className="corner l"><span className="pill mono">In {nat.w}×{nat.h}</span></div>}
      {out && <div className="corner r"><span className="pill mono" title="OpenIllusion crops and sizes the photo to this before the run">Out {dimsText(out)} · {aspectName(out)}</span></div>}
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

function VCell({ n, v, job, fallback, starred, onOpen, onStar }: { n: number; v?: Manifest; job?: Job; fallback?: string; starred: boolean; onOpen: () => void; onStar: () => void }) {
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
      {done && (
        <div className="corner r">
          <button className={cx("icon-btn sm glass fav")} type="button" aria-pressed={starred} aria-label={starred ? `Unstar variant ${n}` : `Star variant ${n}`} title="Star to send to Video"
            onClick={(e) => { e.stopPropagation(); onStar(); }}><I n="star" /></button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- prompt + run */

/** The prompt, whole: what's in the box is what the workflow gets. Ideas swap in a complete prompt. */
function PromptSection({ s, set, engine, area, clearArea, invalid, onRun }: {
  s: StudioState; set: SetS; engine?: EngineInfo; area: boolean; clearArea: () => void; invalid: boolean; onRun: () => void;
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
        <h4 id="sec-prompt">{pf.label}{pf.required === false && <span className="opt"> · optional</span>}</h4>
        {def && s.prompt !== def
          ? <button className="sec-act" type="button" onClick={() => set({ prompt: def })} title="Put the template's prompt back"><I n="undo" />Reset</button>
          : <span className="mono">{s.prompt.length}</span>}
      </div>
      <div className={cx("pbox", invalid && s.prompt.trim() && "bad")}>
        {area && <span className="areachip">Only inside the marked area<button type="button" aria-label="Clear area" onClick={clearArea}><I n="x" /></button></span>}
        <textarea ref={ta} id="prompt" aria-labelledby="sec-prompt" rows={4} spellCheck value={s.prompt} placeholder={pf.hint ?? "Describe the change. Keep it to one clear instruction."}
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
function RunBar({ s, set, engine, runner, estimate, queued }: {
  s: StudioState; set: SetS; engine?: EngineInfo; runner: ReturnType<typeof useRunner>; estimate?: ReturnType<typeof useCompose>["estimate"]; queued: number;
}) {
  const status = useStatus();
  const media = mediaFields(engine);
  const held = (f: MediaField) => f.type === "video"
    ? !!s.video && !s.video.missing
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
          <span className="warn"><I n="alert" />Add {article(missing.label)} to run</span>
        ) : reasons.length ? (
          <span className="warn" title={reasons.join("\n")}><I n="alert" />{reasons[0]}{reasons.length > 1 ? ` · +${reasons.length - 1} more` : ""}</span>
        ) : runner.isLocal ? (
          <span className="rdy"><i className="dot" />{gpu ?? "Your ComfyUI"}<em>{queued ? `${queued} in queue` : "free"}</em></span>
        ) : (
          <span className="rdy"><i className="dot violet" />Comfy Router<CostPill estimate={estimate} times={s.variants} /></span>
        )}
      </div>
      <div className="rb-row">
        <div className="rb-count" role="group" aria-label="Variants, one seed each" title="Variants, one seed each">
          {[1, 2, 3, 4].map((v) => <button key={v} type="button" aria-pressed={s.variants === v} onClick={() => set({ variants: v })}>{v}</button>)}
        </div>
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

