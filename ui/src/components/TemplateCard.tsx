import * as Popover from "@radix-ui/react-popover";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, type EngineInfo, type Mode } from "../lib/api";
import { errMsg } from "../lib/format";
import { useApp } from "../lib/store";
import { ArrowRight, Brush, ImageIcon, More, Motion, Refresh } from "./Icons";
import { clampAspect } from "./Masonry";
import { MenuItem, Spinner, cx } from "./ui";

const KIND_DOT = { local: "#F2FF59", cloud: "#9A86F0" } as const;
const reducedMotion = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** A template on the Library wall. Click opens it in the inspector; "Use" goes straight to its studio. */
export function TemplateTile({ e, locked, selected, onOpen, onUse }: { e: EngineInfo; locked?: string | null; selected?: boolean; onOpen: () => void; onUse: () => void }) {
  return (
    <TileFrame
      title={e.label} mode={e.mode} kind={e.kind} aspect={e.cover ? e.cover_aspect : undefined}
      poster={e.cover} video={e.cover_video} onClick={onOpen} selected={selected}
      label={`${e.label}, ${e.kind} ${e.mode} template. ${locked ?? e.blurb} Opens details.`}
      status={locked ? <span className="inline-flex items-center gap-1.5 text-orange-text" title={locked}><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-orange" />Needs setup</span> : undefined}
      cta={
        <button type="button" onClick={onUse} aria-label={`Use ${e.label}`}
          className="mk-btn pointer-events-auto h-8 px-3 rounded-lg border-0 bg-yellow text-ink text-sm font-semibold inline-flex items-center gap-1.5 shadow-[0_6px_18px_rgba(242,255,89,0.25)] hover:brightness-105">
          Use<ArrowRight size={13} />
        </button>
      }
      corner={<CoverMenu e={e} />}
    />
  );
}

function TileFrame({ title, mode, kind, aspect, poster, video, onClick, label, status, cta, corner, selected }: {
  title: string; mode: Mode; kind: "cloud" | "local"; aspect?: number | null; poster?: string | null; video?: string | null;
  onClick: () => void; label: string; status?: ReactNode; cta: ReactNode; corner?: ReactNode; selected?: boolean;
}) {
  const ModeIcon = mode === "motion" ? Motion : Brush;
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const near = useNear(box);
  const [loaded, setLoaded] = useState(false);
  const hasMedia = !!(poster || video);
  useEffect(() => setLoaded(false), [poster, video]);

  // Loops play while on screen, and only on hover for people who asked for less motion.
  useEffect(() => {
    const v = vid.current;
    if (!v || reducedMotion()) return;
    const io = new IntersectionObserver(([en]) => (en.isIntersecting ? v.play().catch(() => {}) : v.pause()), { threshold: 0.35 });
    io.observe(v);
    return () => io.disconnect();
  }, [video, near]);
  const hover = (on: boolean) => {
    const v = vid.current;
    if (v && reducedMotion()) void (on ? v.play().catch(() => {}) : v.pause());
  };

  return (
    <div ref={box} className="group relative rounded-xl overflow-hidden bg-surface"
      style={{ aspectRatio: clampAspect(aspect) }} onMouseEnter={() => hover(true)} onMouseLeave={() => hover(false)}>
      <button type="button" onClick={onClick} aria-label={label} aria-pressed={selected}
        className="mk-btn absolute inset-0 w-full h-full p-0 border-0 bg-transparent text-left cursor-pointer">
        {hasMedia ? (
          <>
            {!loaded && <span aria-hidden className="absolute inset-0 skeleton" />}
            {!near ? null : video ? (
              <video ref={vid} src={video} poster={poster ?? undefined} muted loop playsInline preload="metadata" disablePictureInPicture aria-hidden
                onLoadedData={() => setLoaded(true)} onError={() => setLoaded(true)}
                className={cx("absolute inset-0 w-full h-full object-cover transition-[opacity,transform] duration-500 ease-out group-hover:scale-[1.03]", loaded ? "opacity-100" : "opacity-0")} />
            ) : (
              <img src={poster!} alt="" decoding="async" draggable={false} onLoad={() => setLoaded(true)} onError={() => setLoaded(true)}
                className={cx("absolute inset-0 w-full h-full object-cover transition-[opacity,transform] duration-500 ease-out group-hover:scale-[1.03]", loaded ? "opacity-100" : "opacity-0")} />
            )}
          </>
        ) : (
          <span aria-hidden className={cx("absolute inset-0",
            kind === "local" ? "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(242,255,89,0.18),transparent_60%),linear-gradient(160deg,#30233a,#1c1622)]"
                             : "bg-[radial-gradient(120%_90%_at_100%_0%,rgba(154,134,240,0.28),transparent_60%),linear-gradient(160deg,#30233a,#1c1622)]")}>
            <ModeIcon size={56} className={cx("absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 opacity-25", kind === "local" ? "text-yellow" : "text-violet-light")} />
          </span>
        )}
        {/* Scrims keep the labels readable on any image. */}
        <span aria-hidden className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/50 to-transparent pointer-events-none" />
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/70 to-transparent opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity pointer-events-none" />

        <span className="absolute left-2.5 top-2.5 right-12 flex">
          <span className="glass h-7 max-w-full pl-2 pr-2.5 rounded-lg inline-flex items-center gap-1.5 text-sm font-medium text-white">
            <ModeIcon size={13} className="shrink-0 opacity-80" />
            {/* "New hair · Qwen Image 2.1": the wall shows the task; the full name is in the inspector. */}
            <span className="truncate">{title.split(" · ")[0]}</span>
          </span>
        </span>

      </button>
      {/* Drawn over the media: an inset ring on the frame itself would sit under the image. */}
      <span aria-hidden className={cx("pointer-events-none absolute inset-0 rounded-xl ring-inset transition-shadow",
        selected ? "ring-2 ring-yellow" : "ring-1 ring-white/[0.06] group-hover:ring-white/[0.14]")} />
      <div className="pointer-events-none absolute inset-x-2.5 bottom-2.5 flex items-end justify-between gap-2 opacity-0 translate-y-1 group-hover:opacity-100 group-hover:translate-y-0 group-focus-within:opacity-100 group-focus-within:translate-y-0 [@media(hover:none)]:opacity-100 [@media(hover:none)]:translate-y-0 transition-[opacity,transform] duration-200">
        <span className="flex flex-col gap-1 text-xs font-medium min-w-0">
          {status}
          <span className="inline-flex items-center gap-1.5 text-white/80 uppercase tracking-wide text-xs2">
            <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: KIND_DOT[kind] }} />{kind} · {mode}
          </span>
        </span>
        {cta}
      </div>
      {corner && <div className="absolute right-2.5 top-2.5">{corner}</div>}
    </div>
  );
}

/**
 * True once the element comes within a screen of the visible area of its
 * scroller, and stays true. Media below the fold isn't fetched until then;
 * the scroller is the root so the look-ahead margin actually applies.
 */
function useNear(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    const io = new IntersectionObserver(([en]) => { if (en.isIntersecting) { setNear(true); io.disconnect(); } },
      { root: el.closest(".scroll-y"), rootMargin: "100% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, near]);
  return near;
}

export const COVER_ACCEPT = "image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm";

/** Change or reset a template's cover; the engines list updates in place. */
export function useCoverActions(e: EngineInfo) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);

  const apply = async (run: () => Promise<EngineInfo>, done: string) => {
    setBusy(true);
    try {
      const next = await run();
      qc.setQueryData<EngineInfo[]>(["engines"], (list) => list?.map((x) => (x.id === next.id ? next : x)));
      toast({ text: done, tone: "ok" });
    } catch (err) {
      toast({ text: `Couldn't change the cover: ${errMsg(err)}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const upload = (f?: File) => {
    if (f) apply(async () => api.setCover(e.id, { asset: (await api.upload(f)).asset }), "Cover updated.");
  };
  const reset = () => apply(() => api.resetCover(e.id), "Cover reset.");
  return { busy, upload, reset };
}

/** The tile's ⋯ menu: pick a cover (image or short video), or go back to the template's own. */
function CoverMenu({ e }: { e: EngineInfo }) {
  const file = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const { busy, upload, reset } = useCoverActions(e);

  return (
    <>
      <input ref={file} type="file" accept={COVER_ACCEPT} hidden
        onChange={(ev) => { upload(ev.target.files?.[0]); ev.target.value = ""; }} />
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button type="button" aria-label={`${e.label}: cover options`} disabled={busy}
            className={cx("mk-btn w-7 h-7 rounded-lg glass border-0 text-white/90 hover:text-white flex items-center justify-center transition-opacity",
              "opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100", busy && "opacity-100")}>
            {busy ? <Spinner size={13} /> : <More size={15} />}
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={6} className="z-50 w-[248px] p-1 rounded-lg bg-surface shadow-pop animate-pop flex flex-col">
            <MenuItem icon={<ImageIcon size={14} />} onClick={() => { setOpen(false); file.current?.click(); }}>{e.cover ? "Change cover…" : "Set cover…"}</MenuItem>
            {e.cover_custom && (
              <MenuItem icon={<Refresh size={14} />} onClick={() => { setOpen(false); reset(); }}>
                Reset to default
              </MenuItem>
            )}
            <p className="m-0 px-2 pt-1.5 pb-1 mt-1 border-t border-line text-xs text-faint leading-[1.45]">
              Image or video. Videos play as a muted 8 s loop. Or open a finished result and pick <span className="text-muted">Use as template cover</span>.
            </p>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
