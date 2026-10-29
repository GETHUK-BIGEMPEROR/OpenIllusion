// One editor for every photo, clip and sound in the app: inline on Create's stage, a sheet over the Builder.
// Crop, turn, size, cut, frame rate, sound. The model's limits sit on top as pills; "Fit to spec" meets them.
// The editor only holds edits (lib/edits.ts); its host decides when a new file is made (server/edit.py).
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type Asset, type Fit } from "../lib/api";
import { byState, checks, deltaOf, fitEdits, inRange, isEdited, keepBox, NO_EDITS, outOf, statusOf, toOps, type Edits, type MediaLike, type Rot, type Tool } from "../lib/edits";
import { clock, errMsg } from "../lib/format";
import { dimsText, shapeCrop, type Crop } from "../lib/size";
import { useApp } from "../lib/store";
import { I } from "./oi";
import type { IconName } from "./sprite";
import { Trimmer } from "./Trimmer";
import { cx, Spinner, Toggle } from "./ui";

export type Media = MediaLike & { asset: string; name: string; url: string; poster?: string | null };

const SHAPES: [string, number][] = [["1:1", 1], ["4:5", 4 / 5], ["3:4", 3 / 4], ["9:16", 9 / 16], ["16:9", 16 / 9], ["4:3", 4 / 3], ["3:2", 3 / 2]];
const RATES = [12, 24, 25, 30, 60];
const MIN = 0.04; // smallest crop, as a share of a side
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const TOOLS: { t: Tool; label: string; icon: IconName; kinds: MediaLike["kind"][] }[] = [
  { t: "crop", label: "Crop", icon: "crop", kinds: ["image", "video"] },
  { t: "turn", label: "Turn", icon: "turn", kinds: ["image", "video"] },
  { t: "size", label: "Size", icon: "expand", kinds: ["image", "video"] },
  { t: "cut", label: "Cut", icon: "cut", kinds: ["video", "audio"] },
  { t: "rate", label: "Rate", icon: "rate", kinds: ["video"] },
  { t: "sound", label: "Sound", icon: "sound", kinds: ["video"] },
];

/** The kept part, in the turned picture: drag to move, corners to resize (to the shape when one is locked). */
function CropFrame({ crop, ratio, label, onChange }: { crop: Crop; ratio: number | null; label: string; onChange: (c: Crop) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [x, y, w, h] = crop;
  const start = (mode: "move" | "nw" | "ne" | "sw" | "se") => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const box = ref.current!.parentElement!.getBoundingClientRect();
    const [x0, y0] = [e.clientX, e.clientY];
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / box.width, dy = (ev.clientY - y0) / box.height;
      if (mode === "move") return onChange([clamp(x + dx, 0, 1 - w), clamp(y + dy, 0, 1 - h), w, h]);
      const left = mode[1] === "w", top = mode[0] === "n";
      const ax = left ? x + w : x, ay = top ? y + h : y; // the corner that stays
      const maxW = left ? ax : 1 - ax, maxH = top ? ay : 1 - ay;
      let nw = clamp(left ? ax - (x + dx) : x + w + dx - ax, MIN, maxW);
      let nh = clamp(top ? ay - (y + dy) : y + h + dy - ay, MIN, maxH);
      if (ratio) {
        if (nw / nh > ratio) nw = nh * ratio;
        else nh = nw / ratio;
        if (nw > maxW) [nw, nh] = [maxW, maxW / ratio];
        if (nh > maxH) [nw, nh] = [maxH * ratio, maxH];
      }
      onChange([left ? ax - nw : ax, top ? ay - nh : ay, nw, nh]);
    };
    const up = () => { el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const key = (e: React.KeyboardEvent) => {
    const d = e.shiftKey ? 0.05 : 0.005;
    const s = ({ ArrowLeft: [-d, 0], ArrowRight: [d, 0], ArrowUp: [0, -d], ArrowDown: [0, d] } as Record<string, number[]>)[e.key];
    if (!s) return;
    e.preventDefault();
    onChange([clamp(x + s[0], 0, 1 - w), clamp(y + s[1], 0, 1 - h), w, h]);
  };
  const [l, t, r, b] = [x * 100, y * 100, (x + w) * 100, (y + h) * 100];
  return (
    <>
      <div className="ed-shade" style={{ clipPath: `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${l}% ${t}%, ${l}% ${b}%, ${r}% ${b}%, ${r}% ${t}%, ${l}% ${t}%)` }} />
      <div ref={ref} className="ed-crop" role="group" tabIndex={0} aria-label="Crop frame. Drag to move, drag a corner to resize, or use the arrow keys."
        style={{ left: `${l}%`, top: `${t}%`, width: `${w * 100}%`, height: `${h * 100}%` }} onPointerDown={start("move")} onKeyDown={key}>
        {(["nw", "ne", "sw", "se"] as const).map((c) => <b key={c} className={`ed-h ${c}`} onPointerDown={start(c)} aria-hidden />)}
        <span className="ed-dims mono">{label}</span>
      </div>
    </>
  );
}

/** A picture or clip turned and flipped the way the edit will: the element is sized to its own shape inside the turned frame. */
function Turned({ m, e, video, onTime, still }: { m: Media; e: Pick<Edits, "rotate" | "fh" | "fv">; video?: React.RefObject<HTMLVideoElement>; onTime?: () => void; still?: boolean }) {
  const side = e.rotate % 180 !== 0;
  const [w, h] = [m.width ?? 1, m.height ?? 1];
  const style: CSSProperties = {
    width: side ? `${(w / h) * 100}%` : "100%",
    height: side ? `${(h / w) * 100}%` : "100%",
    transform: `translate(-50%, -50%) scale(${e.fh ? -1 : 1}, ${e.fv ? -1 : 1}) rotate(${e.rotate}deg)`,
  };
  if (m.kind === "video" && !still) return <video ref={video} className="ed-turn" src={m.url} poster={m.poster ?? undefined} style={style} muted playsInline preload="auto" onTimeUpdate={onTime} />;
  const src = m.kind === "video" ? m.poster : m.url;
  return src ? <img className="ed-turn" src={src} alt="" style={style} draggable={false} /> : null;
}

/** A file as its edits leave it: turned, then cropped. Sounds show as a wave mark. */
export function MediaThumb({ m, e = NO_EDITS, className }: { m: Media; e?: Edits; className?: string }) {
  if (m.kind === "audio" || !m.width || !m.height) {
    return <span className={cx("thumb", m.kind === "audio" && "audio", className)} aria-hidden><I n={m.kind === "audio" ? "sound" : m.kind === "video" ? "film" : "image"} /></span>;
  }
  const o = outOf(m, e);
  const [x, y, w, h] = e.crop ?? [0, 0, 1, 1];
  return (
    <span className={cx("thumb", className)} aria-hidden>
      <span className="thumb-in" style={{ "--ar": o.w / o.h } as CSSProperties}>
        <span className="thumb-t" style={{ left: `${(-x / w) * 100}%`, top: `${(-y / h) * 100}%`, width: `${100 / w}%`, height: `${100 / h}%` }}>
          <Turned m={m} e={e} still />
        </span>
      </span>
      {m.kind === "video" && <span className="thumb-len mono">{o.len.toFixed(1)} s</span>}
    </span>
  );
}

/** "Fits Kling", "Run crops it to 5:2": one line under a file. */
export function FitLine({ m, fit, e = NO_EDITS, model, fallback, lead }: { m: MediaLike; fit?: Fit; e?: Edits; model: string; fallback?: ReactNode; lead?: string }) {
  const st = statusOf(m, fit, e, model);
  // `lead` (the file's size) goes first, so a card says what the file is and how it runs on one line.
  const pre = lead ? <span className="fl-meta mono">{lead}</span> : null;
  if (!st) return fallback || pre ? <span className="fline">{pre}{pre && fallback && <span className="fl-sep" aria-hidden>·</span>}{fallback}</span> : null;
  return <span className={cx("fline", st.state)} title={st.text}>{pre}<i className="dot" /><span>{st.text}</span></span>;
}

/** What a file is: its size, length and rate after the edits. */
export const metaOf = (m: MediaLike, e: Edits = NO_EDITS) => {
  const o = outOf(m, e);
  return [m.kind !== "audio" && m.width && m.height && `${o.w}×${o.h}`, m.kind !== "image" && m.duration && `${o.len.toFixed(1)} s`, m.kind === "video" && o.fps && `${+o.fps.toFixed(2)} fps`].filter(Boolean).join(" · ");
};

export interface EditorProps {
  m: Media; fit?: Fit; model?: string; role?: string;
  edits: Edits; onEdits: (e: Edits) => void;
  title: string; sheet?: boolean; onClose?: () => void;
  note?: string; actions: ReactNode; runs?: RunSizes;
}

/** The sizes a local template runs a photo or clip at: its steps, and its own pixels (`own`), each as the run makes it. */
export interface RunSizes {
  options: { label: string; own: boolean; dims: { width: number; height: number } }[];
  choice: string; multiple: number; onPick: (label: string) => void;
}

/** The editor. The host keys it by file, so a new file starts on its first tool. */
export function Editor({ m, fit, model, role, edits: e, onEdits, title, sheet, onClose, note, actions, runs }: EditorProps) {
  const video = useRef<HTMLVideoElement>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const [tool, setTool] = useState<Tool>(m.kind === "audio" ? "cut" : "crop");
  const [playing, setPlaying] = useState(false);
  const [orig, setOrig] = useState(false);
  const [flash, setFlash] = useState<{ tools: Tool[]; n: number }>({ tools: [], n: 0 });

  const dur = m.duration ?? 0;
  const pic = m.kind !== "audio" && !!m.width && !!m.height;
  const o = outOf(m, e);
  const trim = e.trim ?? [0, dur];
  const list = checks(m.kind, fit, o).sort(byState);
  const todo = list.some((c) => c.state === "fix");
  const tools = TOOLS.filter((x) => x.kinds.includes(m.kind) && (pic || x.t === "cut" || x.t === "rate" || x.t === "sound"));
  const shown = orig ? { ...NO_EDITS } : e;
  const so = outOf(m, shown);
  const keep = orig ? null : keepBox(m, e, fit);
  const who = model ?? "The model";
  const set = (p: Partial<Edits>) => onEdits({ ...e, ...p });

  // The clip or sound plays its kept part, round and round.
  const el = () => (m.kind === "audio" ? audio.current : video.current);
  useEffect(() => { const v = el(); if (v) v.currentTime = trim[0]; }, [trim[0], trim[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const tick = () => { const v = el(); if (v && (v.currentTime >= trim[1] || v.currentTime < trim[0] - 0.05)) v.currentTime = trim[0]; };
  const play = () => { const v = el(); if (!v) return; if (v.paused) { void v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); } };

  // Turning moves the picture under the crop: start the crop again. Flipping mirrors it.
  const turn = (d: 90 | -90) => set({ rotate: (((e.rotate + d + 360) % 360) as Rot), crop: null, ratio: null, width: null });
  const mirror = () => set({ fh: !e.fh, crop: e.crop && [1 - e.crop[0] - e.crop[2], e.crop[1], e.crop[2], e.crop[3]] });
  const flip = () => set({ fv: !e.fv, crop: e.crop && [e.crop[0], 1 - e.crop[1] - e.crop[3], e.crop[2], e.crop[3]] });
  const shape = (r: number) => set({ ratio: r, crop: shapeCrop(o.tw, o.th, r), width: null });
  const cw = e.crop ? e.crop[2] * o.tw : o.tw, ch = e.crop ? e.crop[3] * o.th : o.th;
  const setSide = (v: number, which: "w" | "h") => { if (Number.isFinite(v) && v > 0) set({ width: which === "w" ? v : Math.round((v * cw) / ch) }); };
  const fitIt = () => {
    if (!fit) return;
    const f = fitEdits(m, fit, e);
    onEdits(f.edits);
    setFlash((x) => ({ tools: f.changed, n: x.n + 1 }));
  };
  const outShape = (r: number) => !!fit?.aspect && !inRange(r, fit.aspect, 0.002);
  // A template's step sets the pixels itself, so picking one drops a size typed here.
  const runAt = runs?.options.find((x) => x.label === runs.choice);
  const custom = !runs || !!runAt?.own;
  const pickRun = (x: RunSizes["options"][number]) => { runs?.onPick(x.label); if (!x.own && e.width != null) set({ width: null }); };

  const panel = (t: Tool) => {
    switch (t) {
      case "crop": return (
        <section className="ed-sec">
          <h3>Crop</h3>
          <div className="ed-shapes" role="group" aria-label="Shape">
            <button type="button" aria-pressed={!e.crop} onClick={() => set({ crop: null, ratio: null, width: null })}><span className="ic"><I n="whole" /></span>Whole</button>
            <button type="button" aria-pressed={!!e.crop && e.ratio == null} onClick={() => set({ ratio: null, crop: e.crop ?? [0.1, 0.1, 0.8, 0.8] })}><span className="ic"><I n="free" /></span>Free</button>
            {SHAPES.map(([label, r]) => (
              <button key={label} type="button" aria-pressed={e.ratio === r} className={cx(outShape(r) && "out")} onClick={() => shape(r)}
                title={outShape(r) ? `${who} doesn't take ${label}: a run crops it again` : `Crop to ${label}`}>
                <span className="ic"><i style={{ width: r >= 1 ? 18 : 18 * r, height: r >= 1 ? 18 / r : 18 }} /></span>{label}
              </button>
            ))}
          </div>
          <p className="ed-hint">Drag the frame to choose what stays; corners resize it.{fit?.aspect ? " Faded shapes are ones the model won't take." : ""}</p>
        </section>
      );
      case "turn": return (
        <section className="ed-sec">
          <h3>Turn and flip</h3>
          <div className="ed-big">
            <button type="button" onClick={() => turn(-90)}><I n="turnl" />Turn left</button>
            <button type="button" onClick={() => turn(90)}><I n="turnr" />Turn right</button>
            <button type="button" aria-pressed={e.fh} onClick={mirror}><I n="mirror" />Mirror</button>
            <button type="button" aria-pressed={e.fv} onClick={flip}><I n="flipv" />Upside down</button>
          </div>
          <p className="ed-hint">Turning starts the crop again; mirroring moves it with the picture.</p>
        </section>
      );
      case "size": return (
        <section className="ed-sec">
          <h3>{runs ? "Size it runs at" : "Size"}</h3>
          {runs && <>
            <div className="ed-chips ed-steps" role="group" aria-label="Size it runs at">
              {runs.options.map((x) => (
                <button key={x.label} type="button" aria-pressed={runs.choice === x.label} onClick={() => pickRun(x)}
                  title={x.own ? "Set the pixels yourself" : `About ${x.label}, at the crop's shape`}>
                  {x.own ? "Custom" : x.label}<span className="mono">{dimsText(x.dims)}</span>
                </button>
              ))}
            </div>
            <p className="ed-hint">{custom
              ? "Custom: the pixels you set below."
              : "This template's sizes, at the crop's shape. Bigger is sharper and slower. Custom sets the pixels yourself."}</p>
          </>}
          {custom && <div className={cx(runs && "ed-own")}>
          <div className="ed-wh">
            <label><span>W</span><input className="mono" type="number" min={8} max={8192} value={o.w} onChange={(ev) => setSide(+ev.target.value, "w")} aria-label="Width" /></label>
            <i>×</i>
            <label><span>H</span><input className="mono" type="number" min={8} max={8192} value={o.h} onChange={(ev) => setSide(+ev.target.value, "h")} aria-label="Height" /></label>
          </div>
          <div className="ed-chips">
            {([["Original", null], ["75%", 0.75], ["50%", 0.5], ["25%", 0.25], ["2×", 2]] as const).map(([label, k]) => (
              <button key={label} type="button" aria-pressed={k == null ? e.width == null : e.width === Math.round(cw * k)} onClick={() => set({ width: k == null ? null : Math.round(cw * k) })}>{label}</button>
            ))}
          </div>
          <p className="ed-hint">{runAt && (runAt.dims.width !== o.w || runAt.dims.height !== o.h)
            ? `Keeps the crop's shape. Runs at ${dimsText(runAt.dims)}: the workflow takes sides in steps of ${runs!.multiple}.`
            : "Keeps the crop's shape: nothing is stretched."}</p>
          </div>}
        </section>
      );
      case "cut": return (
        <section className="ed-sec">
          <h3>Cut</h3>
          <div className="ed-stat"><span>Starts</span><b className="mono">{clock(trim[0])}</b></div>
          <div className="ed-stat"><span>Ends</span><b className="mono">{clock(trim[1])}</b></div>
          <div className="ed-stat"><span>Keeps</span><b className="mono">{o.len.toFixed(1)} s</b></div>
          <p className="ed-hint">Drag the bright ends, or use the arrow keys on them (Shift for whole seconds).</p>
          {m.kind === "audio" && <p className="ed-hint">Saved as MP3.</p>}
        </section>
      );
      case "rate": return (
        <section className="ed-sec">
          <h3>Frame rate</h3>
          <div className="ed-chips">
            <button type="button" aria-pressed={e.fps == null} onClick={() => set({ fps: null })}>Original{m.fps ? ` ${+m.fps.toFixed(2)}` : ""}</button>
            {RATES.map((r) => <button key={r} type="button" aria-pressed={e.fps === r} className={cx(fit?.fps && !inRange(r, fit.fps) && "out")} onClick={() => set({ fps: r })}>{r}</button>)}
          </div>
          <p className="ed-hint">{fit?.fps ? "Faded rates are outside what the model takes." : "Frames are dropped or repeated to the new rate."}</p>
        </section>
      );
      case "sound": return (
        <section className="ed-sec">
          <h3>Sound</h3>
          {m.has_audio
            ? <label className="ed-toggle"><span>Keep the clip's sound</span><Toggle checked={!e.mute} onChange={(v) => set({ mute: !v })} label="Keep the clip's sound" /></label>
            : <p className="ed-hint">This clip has no sound.</p>}
        </section>
      );
    }
  };

  const badge = (t: Tool) => { const s = list.filter((c) => c.tool === t).map((c) => c.state); return s.includes("bad") ? "bad" : s.includes("fix") ? "fix" : null; };
  const deltas = deltaOf(m, e);
  return (
    <div className={cx("ed", sheet ? "sheet" : "inline")} data-kind={m.kind}>
      <header className="ed-top">
        {sheet ? <Dialog.Title asChild><h2>{title}</h2></Dialog.Title> : <h2>{title}</h2>}
        <span className="ed-file mono" title={m.name}>{m.name}{m.kind === "audio" ? (dur ? ` · ${clock(dur)}` : "") : m.width ? ` · ${m.width}×${m.height}` : ""}</span>
        <span className="grow" />
        {pic && (
          <button type="button" className="ed-hold" aria-pressed={orig} onPointerDown={() => setOrig(true)} onPointerUp={() => setOrig(false)} onPointerLeave={() => setOrig(false)}
            onKeyDown={(ev) => { if (ev.key === " " || ev.key === "Enter") setOrig(true); }} onKeyUp={() => setOrig(false)} title="Hold to see the file as it came">
            <I n="hold" />Hold for original
          </button>
        )}
        {onClose && <button type="button" className="icon-btn" onClick={onClose} aria-label="Close"><I n="x" /></button>}
      </header>

      {fit && list.length > 0 && (
        <section className="ed-spec" aria-label="What the model takes">
          <div className="ed-who"><b>{who}</b>{role && <span>as its {role.toLowerCase()}</span>}</div>
          <div className="ed-pills">
            {list.map((c) => (
              <button key={flash.tools.includes(c.tool as Tool) ? `${c.key}-${flash.n}` : c.key} type="button" className={cx("lpill", c.state, flash.n > 0 && flash.tools.includes(c.tool as Tool) && "flash")}
                disabled={!c.tool} onClick={() => c.tool && tools.some((x) => x.t === c.tool) && setTool(c.tool)}
                title={c.state === "fix" ? `Doesn't fit yet: a run ${c.run}` : c.state === "bad" ? `Can't run: ${c.run}` : c.state === "auto" ? "Made so when it runs" : "Fits"}>
                <i className="dot" />{c.label}<span className="mono">{c.value}</span>
              </button>
            ))}
          </div>
          {todo
            ? <button type="button" className="btn sm" onClick={fitIt} title="Change the file so it meets every limit"><I n="wand" />Fit to spec</button>
            : !list.some((c) => c.state === "bad") && <span className="ed-ok"><I n="check" />Fits as it is</span>}
        </section>
      )}

      {m.kind !== "audio" && (
        <nav className="ed-tools" aria-label="Tools">
          {tools.map((x) => (
            <button key={x.t} type="button" aria-pressed={tool === x.t} onClick={() => setTool(x.t)}>
              <I n={x.icon} />{x.label}{badge(x.t) && <b className={cx("badge", badge(x.t)!)} aria-label="Needs a change" />}
            </button>
          ))}
        </nav>
      )}

      <div className="ed-stage">
        {pic ? (
          <div className="ed-fit">
            <div className="ed-frame" style={{ "--ar": so.tw / so.th } as CSSProperties}>
              <Turned m={m} e={shown} video={video} onTime={tick} />
              {shown.crop && <CropFrame crop={shown.crop} ratio={e.ratio ? (e.ratio * o.th) / o.tw : null} label={`${o.w}×${o.h}`} onChange={(crop) => set({ crop })} />}
              {keep && <div className="ed-keep" style={{ left: `${keep[0] * 100}%`, top: `${keep[1] * 100}%`, width: `${keep[2] * 100}%`, height: `${keep[3] * 100}%` }}><span>{who} keeps this part</span></div>}
              {orig && <span className="ed-orig">Original</span>}
              {m.kind === "video" && <button className="ed-play icon-btn glass" type="button" onClick={play} aria-label={playing ? "Pause" : "Play"}><I n={playing ? "pause" : "play"} /></button>}
            </div>
          </div>
        ) : m.kind === "audio" ? (
          <div className="ed-wave">
            <audio ref={audio} src={m.url} preload="auto" onTimeUpdate={tick} onEnded={() => setPlaying(false)} />
            <button className="ed-play icon-btn glass" type="button" onClick={play} aria-label={playing ? "Pause" : "Play"}><I n={playing ? "pause" : "play"} /></button>
            {dur > 0 && <Trimmer src={m.url} audio duration={dur} trim={trim} onChange={(t) => set({ trim: t })} model={model}
              window={fit?.seconds ? [fit.seconds[0] ?? 0, fit.seconds[1] ?? dur] : null} />}
          </div>
        ) : (
          <p className="ed-hint">This file's size isn't known, so it can't be cropped here.</p>
        )}
      </div>

      {m.kind === "video" && dur > 0 && (
        <div className="ed-tl">
          <Trimmer src={m.url} duration={dur} trim={trim} onChange={(t) => { set({ trim: t }); setTool("cut"); }} model={model}
            window={fit?.seconds ? [fit.seconds[0] ?? 0, fit.seconds[1] ?? dur] : null} />
        </div>
      )}

      <aside className="ed-ctx">{panel(tools.some((x) => x.t === tool) ? tool : tools[0]?.t ?? "cut")}</aside>

      <footer className="ed-out">
        <div className="ed-delta">
          {deltas.map((d) => (
            <span key={d.label} className={cx(d.from === d.to && "same")}>{d.label}{d.from === d.to ? <b className="mono">{d.to}</b> : <><s className="mono">{d.from}</s><i>→</i><b className="mono">{d.to}</b></>}</span>
          ))}
        </div>
        {note && <span className="ed-note">{note}</span>}
        {actions}
      </footer>
    </div>
  );
}

/** The editor as a sheet over the page: Done makes the new file and hands it back. The original stays. */
export function MediaSheet({ m, fit, model, role, title, onClose, onApply, start }: {
  m: Media; fit?: Fit; model?: string; role?: string; title: string; onClose: () => void; onApply: (a: Asset) => void; start?: Edits;
}) {
  const toast = useApp((s) => s.toast);
  const [e, setE] = useState<Edits>(start ?? NO_EDITS);
  const [busy, setBusy] = useState(false);
  const changed = isEdited(e, m);
  const done = async () => {
    if (!changed) return onClose();
    setBusy(true);
    try {
      const a = await api.mediaEdit(m.asset, toOps(e, m), m.name);
      onApply(a);
      toast({ text: `Saved as ${a.name}. The original is kept.`, tone: "ok" });
      onClose();
    } catch (err) {
      toast({ text: errMsg(err), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog.Root open onOpenChange={(open) => !open && !busy && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-bg" />
        <Dialog.Content className="ed-sheet" aria-describedby={undefined} onInteractOutside={(ev) => busy && ev.preventDefault()}>
          <Editor m={m} fit={fit} model={model} role={role} edits={e} onEdits={setE} title={title} sheet onClose={busy ? undefined : onClose}
            note={changed ? "Saved as a new file · the original stays" : undefined}
            actions={<>
              <button type="button" className="btn ghost" disabled={busy || !changed} onClick={() => setE(NO_EDITS)}>Undo edits</button>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void done()}>{busy ? <Spinner size={12} /> : <I n="check" />}{changed ? "Save" : "Done"}</button>
            </>} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

