import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, type EngineInfo } from "../lib/api";
import { errMsg } from "../lib/format";
import { useApp } from "../lib/store";
import { clampAspect } from "./Masonry";
import { cx, I, Media } from "./oi";

/** "New hair · Qwen Image 2.1" → the task; the model goes on the second line. */
export const tplName = (e: Pick<EngineInfo, "label">) => e.label.split(" · ")[0];
export const tplModel = (e: Pick<EngineInfo, "label" | "provider">) => e.label.split(" · ")[1] ?? e.provider;

const BROAD = ["portrait", "product", "fashion", "scene", "style", "photo"];
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

/** The one word a template is filed under on the wall. */
export function tplCategory(e: Pick<EngineInfo, "tags" | "mode">) {
  const tags = e.tags ?? [];
  const t = tags.find((x) => BROAD.includes(x)) ?? tags[0];
  return t ? cap(t) : e.mode === "motion" ? "Video" : "Image";
}

/** Chips for the wall: tags at least two templates share, most used first. */
export function tplChips(list: EngineInfo[]) {
  const n = new Map<string, number>();
  for (const e of list) for (const t of e.tags ?? []) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => ({ tag: t, label: cap(t) }));
}

/** A template on the Explore wall. Click opens it in Create; the (i) button opens its details. */
export function TemplateCard({ e, selected, locked, onUse, onInspect }: { e: EngineInfo; selected?: boolean; locked?: string | null; onUse: () => void; onInspect: () => void }) {
  const n = e.inputs?.length ?? 0;
  const local = e.kind === "local";
  return (
    <article className={cx("card tcard", selected && "sel")} tabIndex={0} role="button" aria-label={`Open ${tplName(e)}`}
      onClick={onUse} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onUse(); } }}>
      <Media src={e.cover} video={e.cover_video} poster={e.cover} ar={clampAspect(e.cover ? e.cover_aspect : 4 / 5)}>
        {!e.cover && !e.cover_video && <span aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 90% at 100% 0%,rgba(242,255,89,.16),transparent 60%),linear-gradient(160deg,#30233a,#1c1622)" }} />}
      </Media>
      <div className="ctop">
        <span className="pill"><i className={cx("dot", !local && "violet")} />{local ? "Local" : "Cloud"}</span>
        {n > 1 && <span className="pill">{n} photos</span>}
        {locked && <span className="pill" title={locked} style={{ color: "#FFC48F" }}>Needs setup</span>}
        <span className="fspacer" />
        <button className="icon-btn sm glass reveal" type="button" aria-label={`Details for ${tplName(e)}`} onClick={(ev) => { ev.stopPropagation(); onInspect(); }}><I n="info" /></button>
      </div>
      <div className="cap"><div className="cap-t"><h3>{tplName(e)}</h3><p>{tplModel(e)} · {tplCategory(e)}</p></div><span className="go"><I n="arrow" /></span></div>
    </article>
  );
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
