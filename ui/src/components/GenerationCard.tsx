import { useRef, useState } from "react";
import { API, type GenerationRow } from "../lib/api";
import { day } from "../lib/format";
import { href } from "../lib/route";
import { KindBadge, ModeBadge, ModelChip, OutcomeMark } from "./bits";
import { Frame } from "./Icons";
import { Badge } from "./ui";

const file = (id: string, rel: string | null) => (rel ? `${API}/generations/${id}/file/${rel}` : null);

/** Poster with hover-scrub: moving across the card scrubs source → result. */
export function GenerationCard({ s }: { s: GenerationRow }) {
  const vid = useRef<HTMLVideoElement>(null);
  const [hover, setHover] = useState(false);
  const [pos, setPos] = useState(0);
  const poster = file(s.id, s.poster) ?? (s.has_driving ? file(s.id, "driving/poster.webp") : null);
  const preview = s.result_kind === "video" ? file(s.id, s.preview) : null;
  const source = s.has_driving ? file(s.id, "driving/poster.webp") : null;

  const onMove = (e: React.MouseEvent<HTMLAnchorElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setPos(f);
    const v = vid.current;
    if (v && v.duration) v.currentTime = f * v.duration;
  };

  const running = s.status === "running";
  return (
    <a
      href={href({ name: "generation", id: s.id })}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onMouseMove={onMove}
      className="group flex flex-col text-text rounded-xl bg-surface border border-line hover:border-line2 hover:bg-surface2 overflow-hidden transition-colors"
    >
      <div className="relative aspect-[16/10] overflow-hidden bg-raised">
        {poster ? (
          <img src={poster} alt="" loading="lazy" className="w-full h-full object-cover block" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-faint"><Frame size={20} /></div>
        )}
        {hover && preview && (
          <video ref={vid} src={preview} muted playsInline preload="auto" className="absolute inset-0 w-full h-full object-cover" />
        )}
        {hover && !preview && source && poster && source !== poster && (
          // Image result with a source: wipe between them as you move.
          <img src={source} alt="" className="absolute inset-0 w-full h-full object-cover" style={{ clipPath: `inset(0 ${100 - pos * 100}% 0 0)` }} />
        )}
        {hover && (preview || (source && source !== poster)) && (
          <span aria-hidden className="absolute bottom-0 left-0 h-[3px] bg-text/80" style={{ width: `${pos * 100}%` }} />
        )}
        <span className="absolute left-2 top-2 flex gap-1"><ModeBadge mode={s.mode} glass /><KindBadge model={s.model} glass /></span>
        {s.variant && <span className="absolute right-2 top-2"><Badge tone="glass" title={`Imported from a ${s.variant} .illusion package`}>Imported</Badge></span>}
        {running && <span className="absolute inset-x-0 bottom-0 h-[2px] mk-shimmer" />}
        {(s.status === "failed" || s.status === "moderated") && (
          <span className="absolute right-2 bottom-2 glass h-[18px] px-1.5 rounded-md text-xs2 font-semibold inline-flex items-center gap-1 text-rose-text"><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-rose" />{s.status === "failed" ? "Failed" : "Moderated"}</span>
        )}
        {running && <span className="absolute right-2 bottom-2 glass h-[18px] px-1.5 rounded-md text-xs2 font-semibold inline-flex items-center gap-1 text-orange-text"><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-orange animate-pulse" />Running</span>}
      </div>
      <div className="px-3 pt-2 pb-2.5 flex flex-col gap-1">
        <span className="text-sm font-semibold leading-[18px] truncate">{s.title}</span>
        <span className="flex items-center gap-2 min-w-0">
          <ModelChip model={s.model} className="min-w-0" />
          <OutcomeMark outcome={s.outcome} className="shrink-0" />
          <span className="ml-auto text-xs text-faint whitespace-nowrap tabular">{s.ref_count ? `${s.ref_count} ref${s.ref_count > 1 ? "s" : ""} · ` : ""}{day(s.created)}</span>
        </span>
      </div>
    </a>
  );
}
