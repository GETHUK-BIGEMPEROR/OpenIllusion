import { useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties, type PointerEvent } from "react";
import { api, templateWorkflowUrl, type EngineInfo } from "../lib/api";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";
import { isMediaFile, openWithFiles, useFileDrop } from "./Drop";
import { clampAspect } from "./Masonry";
import { cx, I, Media } from "./oi";
import type { IconName } from "./sprite";

/** "New hair · Qwen Image 2.1" → the task; the model goes on the second line. */
export const tplName = (e: Pick<EngineInfo, "label">) => e.label.split(" · ")[0];
export const tplModel = (e: Pick<EngineInfo, "label" | "provider">) => e.label.split(" · ")[1] ?? e.provider;

/** Tags two or more templates share: the filters on Explore, most used first. */
export function sharedTags(list: Pick<EngineInfo, "tags">[]): string[] {
  const n = new Map<string, number>();
  for (const e of list) for (const t of new Set(e.tags ?? [])) n.set(t, (n.get(t) ?? 0) + 1);
  return [...n].filter(([, c]) => c > 1).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
}

/** A template on the Explore wall. Click opens it in Create; the (i) button opens its details. */
export function TemplateCard({ e, selected, locked, onUse, onInspect }: { e: EngineInfo; selected?: boolean; locked?: string | null; onUse: () => void; onInspect: () => void }) {
  const n = e.inputs?.length ?? 0;
  const local = e.kind === "local";
  const video = e.mode === "motion";
  // Photo templates show their sample under the cursor: left of it is what goes in, right is what comes out.
  const sample = !video && e.cover ? e.defaults?.inputs.find((i) => i.kind === "image") : undefined;
  const scrub = (ev: PointerEvent<HTMLElement>) => {
    if (!sample || ev.pointerType === "touch") return;
    const el = ev.currentTarget, r = el.getBoundingClientRect();
    el.style.setProperty("--x", `${Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100))}%`);
    if (!el.classList.contains("live")) el.classList.add("live");
  };
  const unscrub = (ev: PointerEvent<HTMLElement>) => { ev.currentTarget.classList.remove("live"); ev.currentTarget.style.setProperty("--x", "0%"); };
  // Drop a photo or clip on a card: the template opens in Create with it in place of the sample.
  const drop = useFileDrop((files) => void openWithFiles(e, files), { accept: isMediaFile, disabled: !n });
  return (
    <article className={cx("card tcard", selected && "sel", drop.over && "drop", sample && "scrub")} {...drop.props} data-drop="Drop to run it on your file"
      onPointerMove={scrub} onPointerLeave={unscrub}
      tabIndex={0} role="button" aria-label={`Open ${tplName(e)}`}
      onClick={onUse} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onUse(); } }}>
      <Media src={e.cover} video={e.cover_video} poster={e.cover} ar={clampAspect(e.cover ? e.cover_aspect : 1)}>
        {!e.cover && !e.cover_video && <NoCover e={e} />}
        {sample && (
          <>
            <div className="before" aria-hidden><img src={sample.poster ?? sample.url} alt="" loading="lazy" draggable={false} /></div>
            <span className="seam" aria-hidden /><span className="pill tagb">Before</span><span className="pill taga">After</span>
          </>
        )}
      </Media>
      <div className="ctop">
        {!local && <span className="pill" title={locked ?? "Runs on Comfy Router"} style={locked ? { color: "#FFC48F" } : undefined}><i className="dot violet" />Cloud</span>}
        {n > 1 ? <span className="pill">{n} inputs</span> : n === 0 ? <span className="pill">Words only</span> : null}
        {locked && local && <span className="pill" title={locked} style={{ color: "#FFC48F" }}>Needs setup</span>}
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
        <span className="pill kindb" title={video ? "Makes a video" : "Makes a photo"}><I n={video ? "film" : "image"} />{video ? "Video" : "Photo"}</span>
      </div>
      <div className="cap"><div className="cap-t"><h3>{tplName(e)}</h3><p>{tplModel(e)}</p></div><span className="go"><I n="arrow" /></span></div>
    </article>
  );
}

/** A template with no cover yet (most cloud ones until their first run): what goes in and what comes out, tinted per provider. */
function NoCover({ e }: { e: EngineInfo }) {
  let h = 0;
  for (const c of e.provider ?? e.id) h = (h * 31 + c.charCodeAt(0)) % 360;
  const ins: IconName[] = [...(e.inputs ?? []).map((i): IconName => (i.slot.startsWith("video") ? "film" : "image")), ...(e.prompt ? ["pencil" as const] : [])];
  return (
    <span className="nocover" aria-hidden style={{ "--h": h } as CSSProperties}>
      <span className="nc-flow">
        {ins.map((n, i) => <span key={i} className="nc-in"><I n={n} /></span>)}
        <I n="arrow" className="nc-to" />
        <span className="nc-out"><I n={e.mode === "motion" ? "film" : "image"} /></span>
      </span>
      <small>No preview yet</small>
    </span>
  );
}

/** Under a template's header in Create: take its workflow to ComfyUI, or start a new template from it. Local templates only. */
export function TemplateTools({ e }: { e: EngineInfo }) {
  if (e.kind !== "local") return null;
  return (
    <div className="ttools">
      <a className="ttool" href={templateWorkflowUrl(e.id)} download={`${e.id.split("/").pop()}.json`} title="The ComfyUI workflow with this template's prompt, settings and samples. Drop it into ComfyUI.">
        <span className="ttool-ic dl"><I n="download" /></span><span className="ttool-t"><b>Workflow</b><small>For ComfyUI</small></span>
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
