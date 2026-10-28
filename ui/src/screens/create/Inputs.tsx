// Create's inputs: one card per photo, clip or sound input, and the editor the picked one opens on the stage.
// Edits wait on the input (store `edits`); crop and cut ride along as the run's crop and trim, the rest is made into a
// new file when it runs (bakePending), or now with "Apply now".
import { useRef, useState } from "react";
import { clipSlot as asClip, isAudio, isImage, isVideo } from "../../components/Drop";
import { Editor, FitLine, MediaThumb, metaOf, type Media } from "../../components/MediaEditor";
import { cx, I } from "../../components/oi";
import { bySlot, useUploader, withRefs } from "../../components/Refs";
import { tplModel } from "../../components/TemplateCard";
import { Spinner } from "../../components/ui";
import { api, type Asset, type EngineInfo, type SizeSpec } from "../../lib/api";
import { fitEdits, isEdited, needsFile, NO_EDITS, statusOf, toOps, type Edits } from "../../lib/edits";
import { fitOf, roleOf, slotNo, type MediaField } from "../../lib/fields";
import { EDIT_ROLES, errMsg } from "../../lib/format";
import { choiceOf, dimsText, plans, type PrepInput } from "../../lib/size";
import { clipIn, slotOf, soundIn, useApp, withClip, withSound, type RefSlot, type SoundSlot, type StudioState, type VideoSlot } from "../../lib/store";
import { ACCEPT, ACCEPT_AUDIO, ACCEPT_VIDEO, sampleRef, sampleVideo, type SetS } from "./shared";

type Kind = "image" | "video" | "audio";
type Held = RefSlot | VideoSlot | SoundSlot;
const kindOf = (f: MediaField): Kind => (f.type === "video" ? "video" : f.type === "audio" ? "audio" : "image");
const NOUN: Record<Kind, string> = { image: "photo", video: "clip", audio: "sound" };

/** The file in an input, if there is one. Photos get their pixel size from `photos` when the slot doesn't carry it. */
export function heldOf(st: StudioState, f: MediaField, photos: PrepInput[] = []): Held | null {
  const k = kindOf(f);
  if (k === "video") return clipIn(st, f.key);
  if (k === "audio") return soundIn(st, f.key);
  const n = slotNo(f.key);
  const r = st.refs.find((x, i) => slotOf(x, i) === n);
  if (!r) return null;
  const p = photos.find((x) => x.slot === f.key);
  return r.width && r.height ? r : p ? { ...r, width: p.width, height: p.height } : r;
}

/** The studio with one input's file put in, or (null) taken out. */
function withHeld(st: StudioState, f: MediaField, x: Held | null): Partial<StudioState> {
  const k = kindOf(f);
  if (k === "video") return { videos: withClip(st, f.key, x as VideoSlot | null), current: null };
  if (k === "audio") return { sounds: withSound(st, f.key, x as SoundSlot | null), current: null };
  const n = slotNo(f.key);
  return { refs: bySlot([...bySlot(st.refs).filter((y) => y.slot !== n), ...(x ? [{ ...(x as RefSlot), slot: n }] : [])]), current: null };
}

/** An upload as an input's file. */
function asHeld(e: EngineInfo, f: MediaField, a: Asset, old: Held | null): Held {
  const k = kindOf(f);
  if (k === "video") return asClip(a, e, f.key, (old as VideoSlot | null)?.size);
  if (k === "audio") return { ...a, slot: f.key, license: "own" } as SoundSlot;
  const [added] = withRefs([], [a], EDIT_ROLES, "base");
  return { ...added, slot: slotNo(f.key), size: (old as RefSlot | null)?.size, role: roleOf(e, f.key) };
}

/** The edits an input shows: its own, or the crop and cut it came with. */
export function editsOf(h: Held, k: Kind): Edits {
  if (h.edits) return h.edits;
  const v = k === "video" ? (h as VideoSlot) : null;
  const end = v ? v.trim[1] || v.duration || 0 : 0;
  return { ...NO_EDITS, crop: (h as RefSlot).crop ?? null, trim: v ? [v.trim[0], end] : null };
}

/** An input's file with new edits. Crop goes to the run's crop when the picture isn't turned; a clip's cut to its trim. */
function withEdits(h: Held, k: Kind, e: Edits): Held {
  const plain = !e.rotate && !e.fh && !e.fv;
  const out: Held = { ...h, edits: isEdited(e, h) ? e : undefined };
  if (k !== "audio") (out as RefSlot).crop = plain && e.crop ? e.crop : undefined;
  if (k === "video") (out as VideoSlot).trim = e.trim ?? [0, h.duration ?? 0];
  return out;
}

/** Makes an input's waiting edits into a new file; the input then holds it. */
async function bake(e: EngineInfo, f: MediaField, h: Held): Promise<Held> {
  const k = kindOf(f);
  const a = await api.mediaEdit(h.asset, toOps(editsOf(h, k), h), h.name);
  const next = asHeld(e, f, a, h);
  if (k === "image") return { ...next, license: h.sample ? "own" : (h as RefSlot).license };
  return next;
}

/** Before a run: every input whose edits need a new file gets one. Null when none do. */
export async function bakePending(st: StudioState, e: EngineInfo, media: MediaField[], photos: PrepInput[]): Promise<StudioState | null> {
  const todo = media.filter((f) => { const h = heldOf(st, f, photos); return !!h && !h.missing && needsFile(h.edits, h); });
  if (!todo.length) return null;
  let next = st;
  for (const f of todo) next = { ...next, ...withHeld(next, f, await bake(e, f, heldOf(next, f, photos)!)) };
  return next;
}

/** One input: what's in it, and the ways to change that. */
function useSlot(e: EngineInfo, f: MediaField, s: StudioState, set: SetS, photos: PrepInput[]) {
  const toast = useApp((st) => st.toast);
  const { upload, busy } = useUploader();
  const k = kindOf(f);
  const held = heldOf(s, f, photos);
  const put = (x: Held | null) => set((st) => withHeld(st, f, x));
  const sample: Held | null = k === "video" ? sampleVideo(e, f.key) : k === "image" ? sampleRef(e, f.key)
    : (() => { const d = e.defaults?.inputs.find((x) => x.slot === f.key); return d ? ({ ...d, slot: f.key, sample: true, license: "generated" } as SoundSlot) : null; })();
  const fits = (x: File) => (k === "video" ? isVideo(x) : k === "audio" ? isAudio(x) : isImage(x));
  const fill = async (files: File[]) => {
    const file = files.find(fits);
    if (!file) return void toast({ text: `${f.label} takes a ${NOUN[k]}.`, tone: "warn" });
    const [a] = await upload([file], k);
    if (a) put(asHeld(e, f, a, held));
  };
  const edits = held ? editsOf(held, k) : NO_EDITS;
  const setEdits = (ed: Edits) => set((st) => { const h = heldOf(st, f, photos); return h ? withHeld(st, f, withEdits(h, k, ed)) : {}; });
  return { k, held, put, sample, fill, busy: busy > 0, edits, setEdits };
}

const accept = (k: Kind) => (k === "video" ? ACCEPT_VIDEO : k === "audio" ? ACCEPT_AUDIO : ACCEPT);

/** What a run does to the file, or (no model limits) the size it runs at. */
function Line({ e, f, h, edits, plan }: { e: EngineInfo; f: MediaField; h: Held; edits: Edits; plan?: { width: number; height: number } | null }) {
  if (h.missing) return <span className="fline bad"><i className="dot" /><span>File missing: add your own</span></span>;
  return <FitLine m={h} fit={fitOf(e, f.key)} e={edits} model={tplModel(e)} fallback={plan && kindOf(f) !== "audio" ? <>Runs at <b className="mono">{dimsText(plan)}</b></> : undefined} />;
}

/** One input as a card: the file as edited, what it is, and whether the model takes it. Pick it to edit it on the stage. */
export function FileCard({ e, f, s, set, photos, on, plan, onPick }: {
  e: EngineInfo; f: MediaField; s: StudioState; set: SetS; photos: PrepInput[]; on: boolean; plan?: { width: number; height: number } | null; onPick: () => void;
}) {
  const slot = useSlot(e, f, s, set, photos);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { held: h, k, edits } = slot;
  const fit = fitOf(e, f.key);
  const fixable = !!h && !h.missing && statusOf(h, fit, edits, "")?.state === "fix";
  const drop = {
    onDragOver: (ev: React.DragEvent) => { if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); ev.stopPropagation(); setOver(true); } },
    onDragLeave: (ev: React.DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver(false); },
    onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.files.length) return; ev.preventDefault(); ev.stopPropagation(); setOver(false); onPick(); void slot.fill([...ev.dataTransfer.files]); },
  };
  const edited = !!h && isEdited(edits, h) && !!h.edits;
  return (
    <div data-own-drop {...drop} className={cx("fcard", on && "on", over && "drag", !h && "vacant", h?.missing && "missing")}>
      <input ref={input} type="file" accept={accept(k)} hidden onChange={(ev) => { void slot.fill([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
      <button className="fcard-main" type="button" aria-current={on || undefined} onClick={() => { onPick(); if (!h) input.current?.click(); }}
        title={h ? `Edit ${f.label}` : `Add ${f.label}: drop a ${NOUN[k]} or click to choose`}>
        {h && !h.missing ? <MediaThumb m={h as Media} e={edits} /> : <span className="thumb vacant"><I n={k === "video" ? "film" : k === "audio" ? "sound" : "image"} /></span>}
        {slot.busy && <span className="fcard-busy"><Spinner size={16} /></span>}
        <span className="fcard-b">
          <span className="fcard-l1">
            <b>{f.label}</b>
            <small title={h?.name}>{h ? h.name : f.required === false ? "Optional" : "Needed to run"}</small>
            {edited && <em className="tag-ed" title="Changed in the editor. Made when it runs; the original stays.">Edited</em>}
            {h?.sample && !h.missing && !edited && <em className="tag-sample">SAMPLE</em>}
          </span>
          {h ? <>
            {!h.missing && <span className="fcard-meta mono">{metaOf(h, edits)}</span>}
            <Line e={e} f={f} h={h} edits={edits} plan={plan} />
          </> : <span className="fline"><span>Drop a {NOUN[k]} or click to choose</span></span>}
        </span>
      </button>
      <span className="fcard-acts">
        {fixable && fit && <button className="fcard-fit" type="button" onClick={() => { slot.setEdits(fitEdits(h!, fit, edits).edits); onPick(); }} title="Change it so the model takes it as it is">Fit</button>}
        {h ? <>
          <button className="icon-btn sm" type="button" onClick={() => input.current?.click()} aria-label={`Replace ${f.label}`} title="Replace"><I n="upload" /></button>
          <button className="icon-btn sm" type="button" onClick={() => slot.put(null)} aria-label={`Remove ${f.label}`} title="Remove"><I n="x" /></button>
        </> : slot.sample && <button className="fcard-fit" type="button" onClick={() => { slot.put(slot.sample); onPick(); }}>Use sample</button>}
      </span>
    </div>
  );
}

/** Local templates: the pixel budget a photo or clip runs at, its own or one of the template's steps. */
function RunsAt({ size, input, onPick }: { size: SizeSpec; input: PrepInput; onPick: (label: string) => void }) {
  const choice = choiceOf(size, input.slot, input.size);
  return (
    <div className="ed-runs">
      <h4>When it runs</h4>
      <div className="ed-chips">
        {size.options.map((o) => (
          <button key={o.label} type="button" aria-pressed={choice === o.label} onClick={() => onPick(o.label)} title={o.px ? `About ${o.label} at its shape` : "Its own pixels"}>
            {o.px ? o.label : "Own"}<span className="mono">{dimsText(plans(size, [{ ...input, size: o.label }])[input.slot])}</span>
          </button>
        ))}
      </div>
      <p className="ed-hint">What the workflow gets, at the file's shape. Never stretched.</p>
    </div>
  );
}

/** The stage while you set up a run: the picked input in the editor, or a place to drop one. */
export function InputStage({ e, f, s, set, photos }: { e: EngineInfo; f: MediaField; s: StudioState; set: SetS; photos: PrepInput[] }) {
  const toast = useApp((st) => st.toast);
  const slot = useSlot(e, f, s, set, photos);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const { held: h, k, edits } = slot;
  if (!h || h.missing) {
    return (
      <div className="ed-empty">
        <input ref={input} type="file" accept={accept(k)} hidden onChange={(ev) => { void slot.fill([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
        <div className="empty-ic">{slot.busy ? <Spinner size={18} /> : <I n={k === "video" ? "film" : k === "audio" ? "sound" : "image"} />}</div>
        <h3>{h?.missing ? `${f.label}'s file is missing` : `Add ${f.label}`}</h3>
        <p>Drop a {NOUN[k]} here, or choose one. Any common format; others are converted.</p>
        <div className="ed-empty-acts">
          <button className="btn" type="button" onClick={() => input.current?.click()}><I n="upload" />Choose a {NOUN[k]}</button>
          {slot.sample && <button className="btn ghost" type="button" onClick={() => slot.put(slot.sample)}>Use sample</button>}
        </div>
      </div>
    );
  }
  const changed = isEdited(edits, h) && !!h.edits;
  const pending = needsFile(h.edits, h);
  const applyNow = async () => {
    setBusy(true);
    try {
      const next = await bake(e, f, h);
      set((st) => withHeld(st, f, next));
      toast({ text: `Saved as ${next.name}. The original is kept.`, tone: "ok" });
    } catch (err) {
      toast({ text: errMsg(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const runSize = e.size && k !== "audio" && h.width && h.height
    ? <RunsAt size={e.size} input={{ slot: f.key, width: h.width, height: h.height, crop: (h as RefSlot).crop, size: (h as RefSlot).size }}
      onPick={(label) => set((st) => { const x = heldOf(st, f, photos); return x ? withHeld(st, f, { ...x, size: label } as Held) : {}; })} />
    : undefined;
  return (
    <Editor key={h.asset} m={h as Media} fit={fitOf(e, f.key)} model={tplModel(e)} role={(f as { role?: string }).role} edits={edits} onEdits={slot.setEdits}
      title={f.label} sizeExtra={runSize}
      note={changed ? (pending ? "Made into a new file when it runs · the original stays" : "Applied when it runs · the original stays") : undefined}
      actions={<>
        <button type="button" className="btn ghost" disabled={!changed || busy} onClick={() => slot.setEdits(NO_EDITS)}>Undo edits</button>
        {pending && <button type="button" className="btn" disabled={busy} onClick={() => void applyNow()} title="Make the new file now, so the checks use it">{busy ? <Spinner size={12} /> : <I n="check" />}Apply now</button>}
      </>} />
  );
}
