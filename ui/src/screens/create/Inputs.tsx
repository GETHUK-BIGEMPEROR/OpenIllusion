// Create's input tiles: photos, clips and sound, with their shape and size.
import { useRef, useState, type CSSProperties } from "react";
import { clipSlot as asClip } from "../../components/Drop";
import { cx, I } from "../../components/oi";
import { bySlot, useUploader, withRefs } from "../../components/Refs";
import { Trimmer } from "../../components/Trimmer";
import { Spinner } from "../../components/ui";
import type { EngineInfo, SizeSpec } from "../../lib/api";
import { clipFps, clipWindow, roleOf, slotNo, type MediaField } from "../../lib/fields";
import { EDIT_ROLES } from "../../lib/format";
import { clipIn, slotOf, soundIn, withClip, withSound, type RefSlot, type SoundSlot, type StudioState, type VideoSlot } from "../../lib/store";
import { choiceOf, dimsText, megapixels, plan, plans, SHAPES, shapeCrop, shapeOf, sizeNotes, type Crop, type PrepInput } from "../../lib/size";
import { CropBox, ShapeIcon } from "./Canvas";
import { ACCEPT, ACCEPT_AUDIO, ACCEPT_VIDEO, sampleRef, sampleVideo, type SetS, withInput } from "./shared";

/** One photo or clip input as a tile, named by its place: what each one is, the prompt says. Click or drop to fill or replace. */
export function Tile({ e, f, s, set }: { e: EngineInfo; f: MediaField; s: StudioState; set: SetS }) {
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

/** A sound input as a tile: click or drop to fill or replace. Sent as it is: no trim, no size. */
export function SoundTile({ e, f, s, set }: { e: EngineInfo; f: MediaField; s: StudioState; set: SetS }) {
  const { upload, busy } = useUploader();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const a = soundIn(s, f.key);
  const put = (x: Omit<SoundSlot, "slot"> | null) => set((st) => ({ sounds: withSound(st, f.key, x), current: null }));
  const d = e.defaults?.inputs.find((x) => x.slot === f.key);
  const sample = d ? { ...d, sample: true, license: "generated" } : null;
  const fill = async (files: File[]) => {
    const file = files.find((x) => x.type.startsWith("audio/")) ?? files[0];
    if (!file) return;
    const [got] = await upload([file], "audio");
    if (got) put({ ...got, license: "own" });
  };
  const drop = {
    onDragOver: (ev: React.DragEvent) => { if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); ev.stopPropagation(); setOver(true); } },
    onDragLeave: (ev: React.DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver(false); },
    onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.files.length) return; ev.preventDefault(); ev.stopPropagation(); setOver(false); void fill([...ev.dataTransfer.files]); },
  };
  return (
    <div data-own-drop {...drop} className={cx("tile", !a?.url && "empty", over && "drag", a?.missing && "missing", !a?.url && sample && "has-sample")}>
      <input ref={input} type="file" accept={ACCEPT_AUDIO} hidden onChange={(ev) => { void fill([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
      <button className="tile-main" type="button" onClick={() => input.current?.click()} aria-label={a?.url ? `Replace ${f.label}` : `Add ${f.label}`}
        title={a?.url ? `${a.name}: click or drop to replace` : "Drop a sound or click to browse"}>
        <I n="zap" />
        {busy > 0 && <span className="tile-busy"><Spinner size={16} /></span>}
      </button>
      <span className="tile-n">{f.label}{!a?.url && f.required === false ? " · optional" : ""}</span>
      {a?.url && a.sample && !a.missing && <span className="tag-sample tile-tag">SAMPLE</span>}
      {a?.missing && <span className="tile-miss">File missing</span>}
      {a?.url && !a.missing && !!a.duration && <span className="tile-dur">{a.duration.toFixed(1)}s</span>}
      {a?.url
        ? <button className="icon-btn sm glass tile-x" type="button" onClick={() => put(null)} aria-label={`Remove ${f.label}`} title="Remove"><I n="x" /></button>
        : sample && <button className="tile-sample" type="button" onClick={() => put(sample)}>Use sample</button>}
    </div>
  );
}

/** Under the tiles: each filled input's shape and size, and a clip's trim. */
export function InputExtras({ e, f, s, set, staged, named }: { e: EngineInfo; f: MediaField; s: StudioState; set: SetS; staged: boolean; named: boolean }) {
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
