import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
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
import { api, fileUrl, type EngineInfo, type GenerationRow, type Job, type Manifest, type Mode } from "../lib/api";
import { EDIT_ROLES, errMsg, ROLES, roleLabel } from "../lib/format";
import { isActive, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { newKey, slotOf, useApp, type RefSlot, type StudioState, type VideoSlot } from "../lib/store";
import { aspectName, dimsText, plans, usePrepImages } from "../lib/size";

type View = "input" | "result" | "compare" | "grid";
type SetS = ReturnType<typeof useStudio>[1];

const ACCEPT = "image/png,image/jpeg,image/webp";
const ACCEPT_VIDEO = "video/mp4,video/quicktime,video/webm,.m4v";
const FAILED = new Set(["failed", "moderated", "cancelled"]);
const AREA = "Keep the edit inside this area";

/** A template's sample for one slot, as a tray entry. */
function sampleRef(e: EngineInfo, n: number): RefSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === `image:${n}`);
  if (!i) return null;
  return { ...i, key: newKey(), slot: n, sample: true, license: "stock", contains_person: false, consent: false, role: e.mode === "motion" ? "character" : n === 1 ? "base" : "character" };
}

/** A template's sample clip, trimmed to fit its window. */
export function sampleVideo(e: EngineInfo): VideoSlot | null {
  const i = e.defaults?.inputs.find((x) => x.slot === "video:1");
  if (!i) return null;
  const d = i.duration ?? 0;
  return { ...i, trim: [0, e.video_window ? Math.min(d, e.video_window[1]) : d], sample: true, license: "stock", contains_person: false, consent: false };
}

/** The template's inputs that take a photo, numbered by their slot. */
const imageInputs = (e?: EngineInfo) => (e?.inputs ?? []).filter((i) => i.slot.startsWith("image:")).map((i) => ({ ...i, n: Number(i.slot.split(":")[1]) }));
const videoInput = (e?: EngineInfo) => (e?.needs_video ? (e.inputs ?? []).find((i) => i.slot.startsWith("video:")) ?? { slot: "video:1", label: "Source clip" } : null);

export const EditStudio = () => <CreateStudio mode="edit" />;
export const MotionStudio = () => <CreateStudio mode="motion" />;

/** Create: the recipe on the left, the picture or clip in the middle, the prompt and Run under it, this template's runs on the right. */
function CreateStudio({ mode }: { mode: Mode }) {
  const motion = mode === "motion";
  const [s, set] = useStudio(mode);
  const engine = useEngine(mode, s.engine);
  const { spec, compose, estimate } = useCompose(mode, s, engine);
  const { generation: m, job } = useCurrent(s.current);
  const invalid = invalidFields(compose, job?.error);
  const share = useApp((st) => st.share);
  const toast = useApp((st) => st.toast);
  const setStudio = useApp((st) => st.setStudio);
  const { data: jobs = [] } = useJobs();
  const [view, setView] = useState<View>("input");
  const [marking, setMarking] = useState(false);

  const base = s.refs.find((r, i) => slotOf(r, i) === 1);
  const clip = motion && s.video && !s.video.missing ? s.video : null;
  const hasInput = motion ? !!clip : !!base;
  const images = usePrepImages(s.refs);
  const sized = engine?.size;
  const local = sized ? plans(sized, s.params.size, images) : {};
  const out = sized ? (compose?.prep?.[sized.follows] ?? local[sized.follows] ?? null) : null;

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
    toast({ text: `${picks.length} image${picks.length > 1 ? "s" : ""} sent to Motion as ${roleLabel(role)}.`, tone: "ok", action: { label: "Open Motion", run: () => go({ name: "motion" }) } });
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
      const smaller = sized && images.length ? sized.options
        .map((o) => ({ o, p: plans(sized, o.label, images)[sized.follows] }))
        .filter((x) => x.p && out && x.p.width * x.p.height < out.width * out.height)
        .sort((a, b) => b.p.width * b.p.height - a.p.width * a.p.height)[0] : undefined;
      if (smaller) fixes.push({ label: `Use ${smaller.o.label} (${dimsText(smaller.p)})`, run: () => { set((st) => ({ params: { ...st.params, size: smaller.o.label }, raw: null })); toast({ text: `Size set to ${smaller.o.label}. Press Run.`, tone: "ok" }); } });
      else if (size) fixes.push({ label: "Use a smaller size", run: () => { const opts = size.options ?? []; const i = opts.indexOf(String(s.params[size.key] ?? size.default)); if (opts.length && i > 0) { set((st) => ({ params: { ...st.params, [size.key]: opts[i - 1] }, raw: null })); toast({ text: `${size.label} set to ${opts[i - 1]}. Press Run.`, tone: "ok" }); } else if (size.type === "int") { set((st) => ({ params: { ...st.params, [size.key]: size.min ?? size.default }, raw: null })); } } });
    }
    if (suggested.includes("trim") && s.video) {
      const w = engine?.video_window?.[1] ?? 10;
      fixes.push({ label: `Trim to ${w} s`, run: () => set({ video: { ...s.video!, trim: [s.video!.trim[0], s.video!.trim[0] + Math.min(w, s.video!.trim[1] - s.video!.trim[0])] } }) });
    }
    if (suggested.includes("downscale") && s.video) fixes.push({ label: "Downscale to 720p", run: () => { set({ video: { ...s.video!, maxHeight: 720 } }); toast({ text: "The clip is re-encoded at 720p on the next run.", tone: "ok" }); } });
    if (suggested.includes("rerun") || failed.status !== "cancelled") fixes.push({ label: "Try again", run: () => rerun(failed.id), primary: true });
  }

  if (!s.engine && !engine) return <NoTemplates mode={mode} />;

  const canMark = !motion && eff === "input" && !!base;
  const vin = videoInput(engine);
  const pickRun = (id: string) => { set({ current: id, group: [id] }); setView("compare"); };

  return (
    <div className="page studio">
      <aside className="recipe" aria-label="Recipe">
        <div className="recipe-scroll">
          {engine ? <Hero e={engine} /> : <div className="thero"><div className="thero-img" /></div>}
          <HistStrip engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
          {engine?.kind === "local" && <div style={{ display: "grid", gap: 8 }}><LocalNeeds spec={spec} /></div>}

          <section className="sec" aria-labelledby="sec-photos">
            <div className="sec-h"><h4 id="sec-photos">{motion ? "Inputs" : "Photos"}</h4><span className="mono">{engine?.inputs?.length ? `${engine.inputs.length} needed` : `${s.refs.length} / ${engine?.max_images ?? 10}`}</span></div>
            {engine?.inputs?.length ? (
              <>
                {vin && engine && <ClipRow e={engine} label={vin.label ?? "Source clip"} hint={vin.hint} v={s.video} onChange={(video) => set({ video, current: null })} />}
                <Slots e={engine} refs={s.refs} onChange={(refs) => set({ refs, current: null })} />
              </>
            ) : (
              <div data-own-drop>
                <RefTray refs={s.refs} max={engine?.max_images ?? 10} roles={motion ? ROLES : EDIT_ROLES} defaultRole={motion ? "character" : "base"} aspect="1 / 1" onChange={(refs) => set({ refs })} />
                <p className="help">{motion ? "Drag to reorder." : "First image is the canvas. Drag to reorder."}</p>
              </div>
            )}
          </section>

          {sized && (
            <section className="sec" aria-labelledby="sec-size">
              <div className="sec-h"><h4 id="sec-size">Output size</h4>{out && <span className="mono">{dimsText(out)} · {aspectName(out)}</span>}</div>
              <div className="sizes" role="group" aria-label="Output size" style={{ gridTemplateColumns: `repeat(${Math.min(sized.options.length, 4)},1fr)` }}>
                {sized.options.map((o) => {
                  const d = images.some((i) => i.slot === sized.follows) ? plans(sized, o.label, images)[sized.follows] : null;
                  const cur = sized.options.some((x) => x.label === s.params.size) ? s.params.size : sized.default;
                  return (
                    <button key={o.label} type="button" aria-pressed={cur === o.label} onClick={() => set((st) => ({ params: { ...st.params, size: o.label }, raw: null }))}>
                      <b>{o.label}</b><span>{d ? dimsText(d) : o.px > 0 ? `~${o.px}²` : "as is"}</span>
                    </button>
                  );
                })}
              </div>
              <p className="help">Keeps your photo's shape. Cropped to a multiple of {sized.multiple}, never stretched.</p>
            </section>
          )}

          {!motion && (
            <section className="sec" aria-labelledby="sec-var">
              <div className="sec-h"><h4 id="sec-var">Variants</h4><span className="mono">one seed each</span></div>
              <div className="vgrid" role="group" aria-label="Variants">
                {[1, 2, 3, 4].map((v) => <button key={v} type="button" aria-pressed={s.variants === v} onClick={() => set({ variants: v })}>{v}</button>)}
              </div>
            </section>
          )}

          <details className="adv">
            <summary><I n="sliders" />Advanced<span className="mono">{advSummary(engine, s)}</span><I n="down" className="chev" /></summary>
            <div className="adv-body">
              {engine && <ParamFields params={engine.params} values={s.params} invalid={invalid} onChange={(k, v) => set((st) => ({ params: { ...st.params, [k]: v }, raw: null }))} />}
              <div style={{ margin: "0 -14px -14px", borderTop: "1px solid var(--line)" }}><RawRequest s={s} set={set} spec={spec} compose={compose} /></div>
            </div>
          </details>
        </div>
      </aside>

      <section className="stage" aria-label="Preview">
        <div className="stage-top">
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
              {anyDone && !motion && <button className="btn sm ghost" type="button" onClick={sendToMotion} title={`Lands in Motion's tray as ${roleLabel(s.returnRole ?? "character")}`}><I n="film" /><span className="lbl">{s.selected.length ? `Send ${s.selected.length} to Motion` : "To Motion"}</span></button>}
              <button className="btn sm" type="button" onClick={() => share(shown.id)} aria-keyshortcuts="E" title="Export (E)"><I n="share" /><span className="lbl">Export</span></button>
            </>
          )}
          {!motion && (
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
          <Canvas eff={eff} s={s} set={set} engine={engine} base={base} out={out} shown={shown} job={shownJob} group={group} vlist={vlist} jobs={jobs}
            marking={marking} setMarking={setMarking} fixes={fixes} onFocus={(id) => { set({ current: id }); setView("compare"); }} onStar={star} />
        </div>

        <Composer s={s} set={set} engine={engine} runner={runner} estimate={estimate} area={!!area}
          clearArea={() => set((st) => ({ boxes: st.boxes.filter((b) => b.label !== AREA) }))} queued={jobs.filter(isActive).length} invalid={invalid.has("prompt")} />

        <aside className="hist" aria-label="Runs of this template">
          <HistList engine={s.engine} current={s.current} jobs={jobs} onPick={pickRun} />
        </aside>
      </section>
    </div>
  );
}

function advSummary(e: EngineInfo | undefined, s: StudioState) {
  const steps = e?.params.find((p) => p.key === "steps");
  const seed = e?.params.find((p) => p.type === "seed");
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

/** One row per input the template names. Click, drop, or bring the sample back. */
function Slots({ e, refs, onChange }: { e: EngineInfo; refs: RefSlot[]; onChange: (refs: RefSlot[]) => void }) {
  const { upload } = useUploader();
  const [busy, setBusy] = useState<number | null>(null);
  const at = (n: number) => refs.find((r, i) => slotOf(r, i) === n);
  const fill = async (n: number, files: File[]) => {
    const f = files.find((x) => /^image\//.test(x.type)) ?? files[0];
    if (!f) return;
    setBusy(n);
    try {
      const [asset] = await upload([f], "image");
      if (!asset) return;
      const rest = bySlot(refs).filter((r) => r.slot !== n);
      const [added] = withRefs([], [asset], EDIT_ROLES, "base");
      onChange(bySlot([...rest, { ...added, slot: n, role: e.mode === "motion" ? "character" : n === 1 ? "base" : "character" }]));
    } finally {
      setBusy(null);
    }
  };
  const put = (n: number, r: RefSlot | null) => onChange(bySlot([...bySlot(refs).filter((x) => x.slot !== n), ...(r ? [r] : [])]));
  return (
    <div className="slots">
      {imageInputs(e).map(({ slot, n, label, hint }) => (
        <SlotRow key={slot} n={n} label={label ?? `Image ${n}`} hint={hint} r={at(n)} busy={busy === n}
          sample={!!sampleRef(e, n)} onFiles={(files) => fill(n, files)} onClear={() => put(n, null)} onSample={() => put(n, sampleRef(e, n))} />
      ))}
    </div>
  );
}

/** The clip a motion template follows: a row like the photo slots, with the trimmer under it. */
function ClipRow({ e, label, hint, v, onChange }: { e: EngineInfo; label: string; hint?: string; v: VideoSlot | null; onChange: (v: VideoSlot | null) => void }) {
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
    onChange({ ...a, trim: [0, win ? Math.min(d, win[1]) : d], license: "own-footage", contains_person: true, consent: false });
  };
  const drop = {
    onDragOver: (ev: React.DragEvent) => { if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); ev.stopPropagation(); setOver(true); } },
    onDragLeave: (ev: React.DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver(false); },
    onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.files.length) return; ev.preventDefault(); ev.stopPropagation(); setOver(false); void fill([...ev.dataTransfer.files]); },
  };
  const file = <input ref={input} type="file" accept={ACCEPT_VIDEO} hidden onChange={(ev) => { void fill([...(ev.target.files ?? [])]); ev.target.value = ""; }} />;
  const name = `Video 1 · ${label}`;
  const sample = sampleVideo(e);
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
      {!v.missing && !!v.duration && (
        <Trimmer src={v.url} duration={v.duration} trim={v.trim} onChange={(trim) => onChange({ ...v, trim })} window={win} fps={e.fps_window[0] === e.fps_window[1] ? e.fps_window[0] : v.fps}
          height={e.video_max_height && v.height ? Math.min(v.height, e.video_max_height) : v.height} />
      )}
    </div>
  );
}

function SlotRow({ n, label, hint, r, busy, sample, onFiles, onClear, onSample }: {
  n: number; label: string; hint?: string; r?: RefSlot; busy: boolean; sample: boolean; onFiles: (f: File[]) => void; onClear: () => void; onSample: () => void;
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
        <div className="st"><b>{name}</b><span className="sub" style={{ fontFamily: "var(--body)" }}>{hint ?? "Drop a photo or click to browse"}</span></div>
        {sample && <button className="btn sm ghost" type="button" onClick={(ev) => { ev.stopPropagation(); onSample(); }}>Use sample</button>}
      </div>
    );
  }
  return (
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
  );
}

/* ------------------------------------------------------------------- stage */

function Canvas({ eff, s, set, engine, base, out, shown, job, group, vlist, jobs, marking, setMarking, fixes, onFocus, onStar }: {
  eff: View | "live" | "failed" | "empty"; s: StudioState; set: SetS; engine?: EngineInfo; base?: RefSlot; out: { width: number; height: number } | null;
  shown: Manifest | null; job?: Job; group: string[]; vlist: Manifest[]; jobs: Job[]; marking: boolean; setMarking: (v: boolean) => void; fixes: Fix[];
  onFocus: (id: string) => void; onStar: (id: string) => void;
}) {
  const { upload, busy } = useUploader();
  const [over, setOver] = useState(false);
  const qc = useQueryClient();
  const motion = engine?.mode === "motion";
  const result = shown?.result?.file ? fileUrl(shown.id, shown.result.file) : null;
  const size = useImageSize(motion ? null : result);
  const drove = shown?.inputs.find((i) => i.slot.startsWith("video:") && i.file);
  const clip = s.video && !s.video.missing ? s.video : null;
  const ar = motion
    ? (drove?.width && drove.height ? drove.width / drove.height : clip?.width && clip.height ? clip.width / clip.height : 16 / 9)
    : size ? size.w / size.h : out ? out.width / out.height : base?.width && base?.height ? base.width / base.height : 1;
  const before = shown?.inputs.find((i) => i.slot === "image:1")?.file;
  const beforeUrl = motion
    ? (shown && drove ? fileUrl(shown.id, "driving/poster.webp") : clip?.poster ?? undefined)
    : shown && before ? fileUrl(shown.id, before) : base?.url;

  if (eff === "empty" && motion) {
    const sample = engine ? sampleVideo(engine) : null;
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
        <h3>Add a {(videoInput(engine)?.label ?? "source clip").toLowerCase()}</h3>
        <p>Drop it here or on the Video 1 row.{engine?.video_window ? ` ${engine.video_window[0]}–${engine.video_window[1]} s; longer clips get trimmed.` : ""}</p>
        {sample && <button className="btn" type="button" onClick={() => set({ video: sample })}>Use sample</button>}
      </div>
    );
  }

  if (motion && (eff === "compare" || eff === "result") && shown && result) {
    const src = drove ? { kind: "video" as const, src: fileUrl(shown.id, drove.file!), poster: fileUrl(shown.id, "driving/poster.webp"), label: "Source" } : null;
    const res = { kind: (shown.result?.kind ?? "video") as "video" | "image", src: result, poster: shown.result?.poster ? fileUrl(shown.id, shown.result.poster) : null, label: "Result" };
    return <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}><ABPlayer a={eff === "compare" ? src : null} b={res} /></div>;
  }

  if (motion && eff === "input" && clip) {
    return (
      <div className="frame" style={{ "--ar": ar } as CSSProperties}>
        <video key={clip.url} src={clip.url} poster={clip.poster ?? undefined} muted loop playsInline autoPlay controls style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        {clip.width && clip.height ? <div className="corner l"><span className="pill mono">In {clip.width}×{clip.height}</span></div> : null}
        <div className="corner r"><span className="pill mono">{((clip.trim[1] || clip.duration || 0) - clip.trim[0]).toFixed(1)} s{engine?.fps_window[0] === engine?.fps_window[1] ? ` · ${engine?.fps_window[0]} fps` : ""}</span></div>
      </div>
    );
  }

  if (eff === "empty") {
    const first = engine?.inputs?.[0]?.label ?? "photo";
    return (
      <div data-own-drop className={cx("empty", over && "drag")} style={{ padding: 20, borderRadius: 18, border: `1.5px dashed ${over ? "var(--violet)" : "var(--line-2)"}` }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setOver(true); } }} onDragLeave={() => setOver(false)}
        onDrop={async (e) => { if (!e.dataTransfer.files.length) return; e.preventDefault(); setOver(false); addToTray("edit", await upload([...e.dataTransfer.files].slice(0, engine?.max_images ?? 4), "image")); }}>
        <div className="empty-ic">{busy ? <Spinner size={18} /> : <I n="image" />}</div>
        <h3>Add {/^[aeiou]/i.test(first) ? "an" : "a"} {first.toLowerCase()} photo</h3>
        <p>Drop it here or on the Image 1 row. Several photos fill the inputs in order.</p>
        {engine && sampleRef(engine, 1) && <button className="btn" type="button" onClick={() => set((st) => ({ refs: bySlot([...bySlot(st.refs).filter((r) => r.slot !== 1), sampleRef(engine, 1)!]) }))}>Use sample</button>}
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
        {eff === "compare" && beforeUrl ? <Compare before={beforeUrl} after={after} lb="Input" la="Result" /> : <img src={after} alt="Result" />}
        {eff === "result" && <div className="corner r"><span className="pill mono">{dims}{shown.result.seed != null ? `${dims ? " · " : ""}seed ${shown.result.seed}` : ""}</span></div>}
      </div>
    );
  }

  if (!base) return null;
  return <InputFrame base={base} out={out} s={s} set={set} marking={marking} setMarking={setMarking} />;
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
function InputFrame({ base, out, s, set, marking, setMarking }: { base: RefSlot; out: { width: number; height: number } | null; s: StudioState; set: SetS; marking: boolean; setMarking: (v: boolean) => void }) {
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
          <button className={cx("icon-btn sm glass fav")} type="button" aria-pressed={starred} aria-label={starred ? `Unstar variant ${n}` : `Star variant ${n}`} title="Star to send to Motion"
            onClick={(e) => { e.stopPropagation(); onStar(); }}><I n="star" /></button>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- composer */

function Composer({ s, set, engine, runner, estimate, area, clearArea, queued, invalid }: {
  s: StudioState; set: SetS; engine?: EngineInfo; runner: ReturnType<typeof useRunner>; estimate?: ReturnType<typeof useCompose>["estimate"];
  area: boolean; clearArea: () => void; queued: number; invalid: boolean;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const status = useStatus();
  useLayoutEffect(() => {
    const t = ta.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
  }, [s.prompt]);
  const label = engine?.prompt?.label ?? "Instruction";
  const def = engine?.defaults?.prompt ?? "";
  const slots = engine?.inputs?.length ? imageInputs(engine) : null;
  const vin = videoInput(engine);
  const clip = vin && s.video && !s.video.missing ? s.video : null;
  const missingSlot = slots?.find(({ n }) => !s.refs.some((r, k) => slotOf(r, k) === n && r.url && !r.missing));
  const missing = vin && !clip ? { ...vin, what: "" } : missingSlot ? { ...missingSlot, what: " photo" } : null;
  const gpu = gpuName(status.data?.local.gpu);
  const ideas = engine?.examples ?? [];
  const thumbs = [
    ...(vin ? [clip ? { url: clip.poster ?? undefined } : undefined] : []),
    ...(slots ? slots.map(({ n }) => s.refs.find((r, k) => slotOf(r, k) === n)) : s.refs.slice(0, 3)),
  ];
  const reasons = missing ? [] : runner.reasons;

  return (
    <div className="composer">
      <div className="cx">
        {!!ideas.length && (
          <div className="cx-ex" role="group" aria-label="Prompt ideas">
            <span className="lab">Try</span>
            {ideas.map((x) => <button key={x} className="ex" type="button" aria-pressed={s.prompt === x} onClick={() => set({ prompt: x })}>{x}</button>)}
          </div>
        )}
        <div className="cx-box" style={invalid && s.prompt.trim() ? { borderColor: "rgba(255,107,126,.6)" } : undefined}>
          <div className="cx-ins" aria-hidden>
            {thumbs.map((r, i) => (r?.url ? <img key={i} src={r.url} alt="" /> : <span key={i} className="ph"><I n="image" /></span>))}
          </div>
          <div className="cx-mid">
            <label htmlFor="prompt">
              {label}{engine?.prompt?.required === false && <span style={{ color: "var(--text-3)" }}>optional</span>}
              {area && <span className="areachip">Only inside the area<button type="button" aria-label="Clear area" onClick={clearArea}><I n="x" /></button></span>}
            </label>
            <textarea ref={ta} id="prompt" rows={1} spellCheck value={s.prompt} placeholder={engine?.prompt?.hint ?? "Describe the change. Keep it to one clear instruction."}
              onChange={(e) => set({ prompt: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void runner.run(); } }} />
          </div>
          <button className="run" type="button" disabled={runner.blocked || !!missing} onClick={() => void runner.run()} aria-keyshortcuts="Control+Enter R">
            {runner.busy ? <Spinner /> : <I n="zap" />}Run{s.variants > 1 ? ` ×${s.variants}` : ""}<kbd>↵</kbd>
          </button>
        </div>
        <div className="cx-foot">
          {runner.confirm ? (
            <span className="warn" role="alertdialog" aria-label="Unknown cost">
              <I n="alert" />Router can't price this run.
              <button className="btn sm" type="button" onClick={() => void runner.run(true)} autoFocus>Run anyway</button>
              <button className="btn sm ghost" type="button" onClick={() => runner.setConfirm(false)}>Cancel</button>
            </span>
          ) : missing ? (
            <span className="warn"><I n="alert" />Add {/^[aeiou]/i.test(missing.label ?? "") ? "an" : "a"} {(missing.label ?? "photo").toLowerCase()}{missing.what} to run</span>
          ) : reasons.length ? (
            <span className="warn" title={reasons.join("\n")}><I n="alert" />{reasons[0]}{reasons.length > 1 ? ` · +${reasons.length - 1} more` : ""}</span>
          ) : runner.isLocal ? (
            <span className="rdy"><i className="dot" />Ready on {gpu ?? "your ComfyUI"}{queued ? ` · ${queued} in queue` : " · free"}</span>
          ) : (
            <span className="rdy" style={{ gap: 10 }}><i className="dot violet" />Comfy Router<CostPill estimate={estimate} times={s.variants} /></span>
          )}
          <span className="fspacer" />
          <span className="hide-m">Sent exactly as typed</span>
          <span className="mono hide-m">{s.prompt.length}</span>
          {def && s.prompt !== def && <button className="btn sm ghost hide-m" type="button" onClick={() => set({ prompt: def })}><I n="undo" />Default prompt</button>}
        </div>
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
      aria-label={`${g.prompt || g.title}, ${live ? "running" : failed ? "failed" : "done"}`} title={g.prompt || g.title}>
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

