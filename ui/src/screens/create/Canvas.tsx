// Create's canvas: the input or result in the middle, crop box, compare, variant grid.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ABPlayer, type Side } from "../../components/ABPlayer";
import { clipSlot as asClip, dropIntoStudio } from "../../components/Drop";
import { cx, I, jobProgress, QUEUED, Ring } from "../../components/oi";
import { bySlot, useUploader } from "../../components/Refs";
import { StageError, type Fix } from "../../components/Studio";
import { Spinner } from "../../components/ui";
import { api, fileUrl, type EngineInfo, type Job, type Manifest, type Mode } from "../../lib/api";
import { clipFps, clipWindow, mediaFields } from "../../lib/fields";
import { ago } from "../../lib/format";
import { isActive } from "../../lib/live";
import { clipIn, posterOf, slotOf, withClip, type RefSlot, type StudioState } from "../../lib/store";
import { aspectName, dimsText, type Crop } from "../../lib/size";
import { FAILED, sampleRef, sampleVideo, type SetS, type View, withInput } from "./shared";

export function Canvas({ mode, lead, eff, s, set, engine, base, out, shown, job, group, vlist, jobs, fixes, earlier, action, onFocus }: {
  mode: Mode; lead: string; eff: View | "live" | "failed" | "empty"; s: StudioState; set: SetS; engine?: EngineInfo; base?: RefSlot; out: { width: number; height: number } | null;
  shown: Manifest | null; job?: Job; group: string[]; vlist: Manifest[]; jobs: Job[]; fixes: Fix[];
  /** The shown run is older than this template's newest; `action` (Use these inputs) goes in the bar beside it. */
  earlier?: boolean; action?: ReactNode;
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

  // Every result, the template's example included, sits over one bar: what it is on the left, how to compare on the right.
  const player = (a: Side | null, b: Side, info: ReactNode, act?: ReactNode, tip?: string) => (
    <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column" }}>
      <ABPlayer key={b.src ?? ""} a={a} b={b} info={<><div className="ab-info" title={tip}>{info}</div>{act}</>} />
    </div>
  );

  // The template's example: its cover beside the input it was made from, like a finished run.
  if (eff === "example" && engine?.cover) {
    const b = engine.cover_before;
    const after: Side = engine.cover_video ? { kind: "video", src: engine.cover_video, poster: engine.cover, label: "Example" }
      : { kind: "image", src: engine.cover, label: "Example" };
    // A clip's bar holds the timeline too, so its caption stays short; the whole sentence is on hover.
    const clip = after.kind === "video" || b?.kind === "video";
    return player(b ? { kind: b.kind, src: b.url, label: "Input" } : null, after,
      <><span className="ex"><I n="info" size={14} /></span><b>Example</b>{!clip && <span>made with this template. Run it to make your own.</span>}</>,
      null, "Made with this template. Run it to make your own.");
  }

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

  if ((eff === "compare" || eff === "result") && shown && result) {
    const moving = motion || videoOut;
    const src: Side | null = moving
      ? (drove ? { kind: "video", src: fileUrl(shown.id, drove.file!), poster: fileUrl(shown.id, posterOf(drove.file!)), label: "Input" } : null)
      : beforeUrl ? { kind: "image", src: beforeUrl, label: "Input" } : null;
    const res: Side = { kind: shown.result?.kind ?? (moving ? "video" : "image"), src: result, poster: shown.result?.poster ? fileUrl(shown.id, shown.result.poster) : null, label: "Result" };
    const seed = shown.result?.seed;
    const meta = [ago(shown.created), size && `${size.w}×${size.h}`, seed != null && `seed ${seed}`].filter(Boolean).join(" · ");
    return player(eff === "compare" ? src : null, res, <><b>{earlier ? "Earlier run" : "Your run"}</b><span className="mono">{meta}</span></>, earlier ? action : null);
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
export function CropBox({ crop, onChange }: { crop: Crop; onChange: (c: Crop) => void }) {
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
export function ShapeIcon({ r }: { r: number }) {
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
