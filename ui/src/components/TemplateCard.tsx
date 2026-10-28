import { useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties, type PointerEvent, type SyntheticEvent } from "react";
import { api, templateExportUrl, templateWorkflowUrl, type EngineInfo } from "../lib/api";
import { confirm } from "../lib/confirm";
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
  const del = useRemoveTemplate(e, () => {});
  const local = e.kind === "local";
  const video = e.mode === "motion";
  // The cover's input under the cursor, photo or clip: left of it is what goes in, right is what comes out.
  const before = e.cover ? e.cover_before : null;
  // A clip only plays while the cursor is on the card.
  const [over, setOver] = useState(false);
  const scrub = (ev: PointerEvent<HTMLElement>) => {
    if (!before || ev.pointerType === "touch") return;
    const el = ev.currentTarget, r = el.getBoundingClientRect();
    el.style.setProperty("--x", `${Math.max(0, Math.min(100, ((ev.clientX - r.left) / r.width) * 100))}%`);
    if (!el.classList.contains("scrubbing")) { el.classList.add("scrubbing"); setOver(true); }
  };
  const unscrub = (ev: PointerEvent<HTMLElement>) => { ev.currentTarget.classList.remove("scrubbing"); ev.currentTarget.style.setProperty("--x", "0%"); setOver(false); };
  // The input's clip starts where the cover's loop is, so the two move together.
  const follow = (ev: SyntheticEvent<HTMLVideoElement>) => {
    const v = ev.currentTarget, loop = v.closest(".media")?.querySelector<HTMLVideoElement>(":scope > video");
    if (loop && v.duration) v.currentTime = loop.currentTime % v.duration;
  };
  // Drop a photo or clip on a card: the template opens in Create with it in place of the sample.
  const drop = useFileDrop((files) => void openWithFiles(e, files), { accept: isMediaFile, disabled: !n });
  return (
    <article className={cx("card tcard", selected && "sel", drop.over && "drop", before && "scrub")} {...drop.props} data-drop="Drop to run it on your file"
      onPointerMove={scrub} onPointerLeave={unscrub}
      tabIndex={0} role="button" aria-label={`Open ${tplName(e)}`}
      onClick={onUse} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onUse(); } }}>
      <Media src={e.cover} video={e.cover_video} poster={e.cover} ar={clampAspect(e.cover ? e.cover_aspect : 1)}>
        {!e.cover && !e.cover_video && <NoCover e={e} />}
        {before && (
          <>
            <div className="before" aria-hidden>
              {before.kind === "image" ? <img src={before.url} alt="" loading="lazy" draggable={false} />
                : over && <video src={before.url} muted loop playsInline autoPlay onLoadedMetadata={follow} />}
            </div>
            <span className="seam" aria-hidden /><span className="pill tagb">Before</span><span className="pill taga">After</span>
          </>
        )}
      </Media>
      <div className="ctop">
        <div className="ctags">
          {!local && <span className="pill" title={locked ?? "Runs on Comfy Router"} style={locked ? { color: "#FFC48F" } : undefined}><i className="dot violet" />Cloud</span>}
          {n > 1 ? <span className="pill minor">{n} inputs</span> : n === 0 ? <span className="pill minor">Words only</span> : null}
          {locked && local && <span className="pill" title={locked} style={{ color: "#FFC48F" }}>Needs setup</span>}
        </div>
        <span className="pill kindb" title={video ? "Makes a video" : "Makes a photo"}><I n={video ? "film" : "image"} />{video ? "Video" : "Photo"}</span>
      </div>
      {/* Shown on hover, under the kind badge, so they never take room from the tags. */}
      <div className="cacts">
        {local && (
          <a className="icon-btn sm glass reveal" href={templateWorkflowUrl(e.id)} download={`${e.id.split("/").pop()}.json`} aria-label={`Download the ComfyUI workflow of ${tplName(e)}`} title="Download ComfyUI workflow"
            onClick={(ev) => ev.stopPropagation()}><I n="download" /></a>
        )}
        <button className="icon-btn sm glass reveal" type="button" aria-label={`Build a template from ${tplName(e)}`} title="Build from this"
          onClick={(ev) => { ev.stopPropagation(); go({ name: "build", from: e.id }); }}><I n="graph" /></button>
        <button className="icon-btn sm glass reveal" type="button" aria-label={`Details for ${tplName(e)}`} title="Details" onClick={(ev) => { ev.stopPropagation(); onInspect(); }}><I n="info" /></button>
        {del && (
          <button className="icon-btn sm glass reveal del" type="button" aria-label={`${del.label}: ${tplName(e)}`} title={del.label} disabled={del.busy}
            onClick={(ev) => { ev.stopPropagation(); void del.run(); }}><I n="trash" /></button>
        )}
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

/** Built by you, in your templates folder: deleted for real. A shipped template made in the Builder is still shipped. */
export const mine = (e: EngineInfo) => !!e.built && e.origin === "user" && !e.edited;

/** Deleting a template: yours goes for good; a shipped one only comes off Explore (an update would bring its file back),
 *  and Settings → Templates puts it back. Null for a template that can't go. */
export function useRemoveTemplate(e: EngineInfo, onDone: () => void) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  if (!e.origin) return null;
  const own = mine(e);
  const run = async () => {
    const res = await confirm(own
      ? { hold: true, view: () => ({ title: `Delete ${tplName(e)}?`, previews: e.cover ? [e.cover] : [], body: "Its samples and cover go too. This can't be undone.", facts: ["Generations made with it stay"], action: "Hold to delete" }) }
      : { tone: "neutral", icon: "trash", view: () => ({ title: `Remove ${tplName(e)} from Explore?`, previews: e.cover ? [e.cover] : [], body: "It ships with OpenIllusion, so its file stays. Settings → Templates puts it back.", facts: ["Generations made with it stay"], action: "Remove" }) });
    if (!res.ok) return;
    setBusy(true);
    try {
      if (own) {
        await api.deleteTemplate(e.id);
        qc.setQueryData<EngineInfo[]>(["engines"], (list) => list?.filter((x) => x.id !== e.id));
      } else {
        await api.hideTemplate(e.id, true);
        qc.setQueryData<EngineInfo[]>(["engines"], (list) => list?.map((x) => (x.id === e.id ? { ...x, hidden: true } : x)));
      }
      onDone();
      toast({ text: own ? `${tplName(e)} deleted.` : `${tplName(e)} is off Explore. Settings → Templates puts it back.`, tone: "ok" });
    } catch (x) {
      toast({ text: `Couldn't ${own ? "delete" : "remove"}: ${errMsg(x)}`, tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return { run, busy, label: own ? "Delete template" : "Remove from Explore" };
}

/** Under a template's header in Create: start a new template from it, export it to share, (local) take its workflow
 *  to ComfyUI, or delete it. */
export function TemplateTools({ e }: { e: EngineInfo }) {
  const del = useRemoveTemplate(e, () => go({ name: "explore" }));
  return (
    <div className="ttools">
      <button className="ttool" type="button" onClick={() => go({ name: "build", from: e.id })}
        title={e.kind === "local" ? "A new template from this one's workflow, inputs and prompt" : "A new template on the same model, with this one's inputs, prompt and settings"}>
        <I n="graph" />Build from this
      </button>
      <a className="ttool" href={templateExportUrl(e.id)} download title="One .illusion file with this template, its samples and cover. Anyone drops it on Explore to add it.">
        <I n="share" />Export .illusion
      </a>
      {e.kind === "local" && (
        <a className="ttool" href={templateWorkflowUrl(e.id)} download={`${e.id.split("/").pop()}.json`} title="The ComfyUI workflow with this template's prompt, settings and samples. Drop it into ComfyUI.">
          <I n="download" />ComfyUI workflow
        </a>
      )}
      {del && (
        <button className="ttool del" type="button" onClick={() => void del.run()} disabled={del.busy} aria-label={del.label} title={del.label}>
          <I n="trash" />
        </button>
      )}
    </div>
  );
}

/** Covers come from results: a finished run of the template becomes its cover. The engines list updates in place. */
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
    toast({ text: "Template cover updated.", tone: "ok", action: { label: "View", run: () => go({ name: "explore", t: e.id }) } }));
  const reset = () => apply(() => api.resetCover(e.id), () => toast({ text: "Cover reset.", tone: "ok" }));
  return { busy, fromRun, reset };
}
