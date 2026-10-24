import type { EngineInfo } from "../lib/api";
import { KindBadge, ModeBadge } from "./bits";
import { ArrowRight, Brush, Motion } from "./Icons";
import { cx } from "./ui";

/** A template in the Library: a cloud Router model or a local ComfyUI workflow. Click opens its studio. */
export function TemplateCard({ e, locked, onUse }: { e: EngineInfo; locked?: string | null; onUse: () => void }) {
  const local = e.kind === "local";
  const Icon = e.mode === "motion" ? Motion : Brush;
  return (
    <button type="button" onClick={onUse} aria-label={`${e.label}, ${local ? "local" : "cloud"} ${e.mode} template${locked ? `. ${locked}` : ""}`}
      className="group mk-btn text-left flex flex-col rounded-xl bg-surface border border-line hover:border-line2 hover:bg-surface2 overflow-hidden p-0 transition-colors">
      <div className={cx("relative aspect-[16/10] overflow-hidden",
        local ? "bg-[radial-gradient(110%_100%_at_100%_0%,rgba(242,255,89,0.20),transparent_55%),linear-gradient(160deg,#30233a,#1c1622)]"
              : "bg-[radial-gradient(110%_100%_at_100%_0%,rgba(154,134,240,0.30),transparent_55%),linear-gradient(160deg,#30233a,#1c1622)]")}>
        <Icon size={44} aria-hidden className={cx("absolute right-4 bottom-3 opacity-30 transition-transform duration-300 group-hover:scale-110 group-hover:-rotate-3", local ? "text-yellow" : "text-violet-light")} />
        <span className="absolute left-2 top-2 flex gap-1"><ModeBadge mode={e.mode} glass /><KindBadge model={e.id} glass /></span>
        {e.curated && <span className="absolute right-2 top-2 glass h-[18px] px-1.5 rounded-md text-xs2 font-semibold text-soft inline-flex items-center">Tuned</span>}
      </div>
      <div className="flex-1 px-3 pt-2.5 pb-3 flex flex-col gap-1">
        <span className="text-md font-semibold leading-5 truncate">{e.label}</span>
        <span className="text-sm text-muted line-clamp-2 min-h-[34px]">{e.blurb}</span>
        <span className="mt-1.5 flex items-center gap-2 text-xs">
          <span className="font-mono text-faint truncate">{e.provider}</span>
          {locked ? (
            <span className="ml-auto inline-flex items-center gap-1.5 text-orange-text shrink-0" title={locked}><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-orange" />Needs setup</span>
          ) : (
            <span className="ml-auto inline-flex items-center gap-1 text-muted group-hover:text-text shrink-0 transition-colors">Open<ArrowRight size={12} className="transition-transform group-hover:translate-x-0.5" /></span>
          )}
        </span>
      </div>
    </button>
  );
}
