import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, templateWorkflowUrl, type EngineInfo } from "../lib/api";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";
import { isMediaFile, openWithFiles, useFileDrop } from "./Drop";
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
  const video = e.mode === "motion";
  // Drop a photo or clip on a card: the template opens in Create with it in place of the sample.
  const drop = useFileDrop((files) => void openWithFiles(e, files), { accept: isMediaFile, disabled: !n });
  return (
    <article className={cx("card tcard", selected && "sel", drop.over && "drop")} {...drop.props} data-drop="Drop to run it on your file"
      tabIndex={0} role="button" aria-label={`Open ${tplName(e)}`}
      onClick={onUse} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onUse(); } }}>
      <Media src={e.cover} video={e.cover_video} poster={e.cover} ar={clampAspect(e.cover ? e.cover_aspect : 4 / 5)}>
        {!e.cover && !e.cover_video && <span aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(120% 90% at 100% 0%,rgba(242,255,89,.16),transparent 60%),linear-gradient(160deg,#30233a,#1c1622)" }} />}
      </Media>
      <div className="ctop">
        <span className="pill"><i className={cx("dot", !local && "violet")} />{local ? "Local" : "Cloud"}</span>
        {n > 1 && <span className="pill">{n} inputs</span>}
        {locked && <span className="pill" title={locked} style={{ color: "#FFC48F" }}>Needs setup</span>}
        <span className="fspacer" />
        {local && (
          <>
            <a className="icon-btn sm glass reveal" href={templateWorkflowUrl(e.id)} download={`${e.id.split("/").pop()}.json`} aria-label={`Download the ComfyUI workflow of ${tplName(e)}`} title="Download ComfyUI workflow"
              onClick={(ev) => ev.stopPropagation()}><I n="download" /></a>
            <button className="icon-btn sm glass reveal" type="button" aria-label={`Build a template from ${tplName(e)}`} title="Build from this"
              onClick={(ev) => { ev.stopPropagation(); go({ name: "build", from: e.id }); }}><I n="graph" /></button>
          </>
        )}
        <button className="icon-btn sm glass reveal" type="button" aria-label={`Details for ${tplName(e)}`} onClick={(ev) => { ev.stopPropagation(); onInspect(); }}><I n="info" /></button>
        <span className="pill" title={video ? "Makes a video" : "Makes a photo"}><I n={video ? "film" : "image"} />{video ? "Video" : "Photo"}</span>
      </div>
      <div className="cap"><div className="cap-t"><h3>{tplName(e)}</h3><p>{tplModel(e)} · {tplCategory(e)}</p></div><span className="go"><I n="arrow" /></span></div>
    </article>
  );
}

/** Under a template's header in Create: take its workflow to ComfyUI, or start a new template from it. Local templates only. */
export function TemplateTools({ e }: { e: EngineInfo }) {
  if (e.kind !== "local") return null;
  return (
    <div className="ttools">
      <a className="ttool" href={templateWorkflowUrl(e.id)} download={`${e.id.split("/").pop()}.json`} title="The ComfyUI workflow with this template's prompt, settings and samples. Drop it into ComfyUI.">
        <span className="ttool-ic dl"><I n="download" /></span><span className="ttool-t"><b>Workflow</b><small>Open in ComfyUI</small></span>
      </a>
      <button className="ttool" type="button" onClick={() => go({ name: "build", from: e.id })} title="Start a new template from this one's workflow, inputs and prompt">
        <span className="ttool-ic bd"><I n="graph" /></span><span className="ttool-t"><b>Build from this</b><small>Your own version</small></span>
      </button>
    </div>
  );
}

/** Covers come from results: a finished run of the template becomes its cover, and a
 *  draft's first one publishes it to the wall. The engines list updates in place. */
export function useCoverActions(e: EngineInfo) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);

  const apply = async (run: () => Promise<EngineInfo>, done: (next: EngineInfo) => void) => {
    setBusy(true);
    try {
      const next = await run();
      qc.setQueryData<EngineInfo[]>(["engines"], (list) => list?.map((x) => (x.id === next.id ? next : x)));
      done(next);
      return true;
    } catch (err) {
      toast({ text: `Couldn't change the cover: ${errMsg(err)}`, tone: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const fromRun = (generation: string) => apply(() => api.setCover(e.id, generation), () =>
    toast(e.draft
      ? { text: `${tplName(e)} is on Explore now.`, tone: "ok", action: { label: "View", run: () => go({ name: "explore", t: e.id }) } }
      : { text: "Template cover updated.", tone: "ok", action: { label: "View", run: () => go({ name: "explore", t: e.id }) } }));
  const reset = () => apply(() => api.resetCover(e.id), () => toast({ text: "Cover reset.", tone: "ok" }));
  return { busy, fromRun, reset };
}
