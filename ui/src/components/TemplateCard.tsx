import { useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { api, templateExportUrl, templateWorkflowUrl, type EngineInfo } from "../lib/api";
import { confirm } from "../lib/confirm";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";
import { isMediaFile, openWithFiles, useFileDrop } from "./Drop";
import { clampAspect } from "./Masonry";
import { cx, I, Media } from "./oi";
import type { IconName } from "./sprite";

/** A template's name, and the model under it (a Router model's own name, a workflow's as its author gave it). */
export const tplName = (e: Pick<EngineInfo, "label">) => e.label;
export const tplModel = (e: Pick<EngineInfo, "provider" | "model_name">) => e.model_name || e.provider;

/** A template on the Explore wall. Click opens it in Create; the (i) button opens its details. */
export function TemplateCard({ e, hint, selected, locked, onUse, onInspect }: { e: EngineInfo; hint?: { text: string; off?: boolean }; selected?: boolean; locked?: string | null; onUse: () => void; onInspect: () => void }) {
  const n = e.inputs?.length ?? 0;
  const del = useRemoveTemplate(e, () => {});
  const local = e.kind === "local";
  const video = e.mode === "motion";
  // Drop a photo or clip on a card: the template opens in Create with it in place of the sample.
  const drop = useFileDrop((files) => void openWithFiles(e, files), { accept: isMediaFile, disabled: !n });
  return (
    <article className={cx("card tcard", selected && "sel", drop.over && "drop")} {...drop.props} data-drop="Drop to run it on your file"
      tabIndex={0} role="button" aria-label={`Open ${tplName(e)}`}
      onClick={onUse} onKeyDown={(ev) => { if (ev.target === ev.currentTarget && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); onUse(); } }}>
      <Media src={e.cover} video={e.cover_video} poster={e.cover} ar={clampAspect(e.cover ? e.cover_aspect : 1)}>
        {!e.cover && !e.cover_video && <NoCover e={e} />}
      </Media>
      <div className="ctop">
        <div className="ctags">
          {!local && <span className="pill" title={locked ?? "Runs on Comfy Router"} style={locked ? { color: "#FFC48F" } : undefined}><i className="dot violet" />Cloud</span>}
          {n > 1 ? <span className="pill minor">{n} inputs</span> : n === 0 ? <span className="pill minor">Words only</span> : null}
          {locked && local && <span className="pill" title={locked} style={{ color: "#FFC48F" }}>Needs setup</span>}
          {e.origin === "user" && <span className="pill mine" title="Yours: built or imported here, not shipped with OpenIllusion">Yours</span>}
        </div>
        <span className="pill kindb" title={video ? "Makes a video" : "Makes a photo"}><I n={video ? "film" : "image"} />{video ? "Video" : "Photo"}</span>
      </div>
      {/* Shown on hover, under the kind badge, so they never take room from the badges. */}
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
      <div className="cap"><div className="cap-t"><h3>{tplName(e)}</h3><p>{tplModel(e)}{hint && <span className={cx("when", hint.off && "off")}>{hint.text}</span>}</p></div><span className="go"><I n="arrow" /></span></div>
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
        Build from this
      </button>
      <a className="ttool" href={templateExportUrl(e.id)} download title="One .illusion file with this template, its samples and cover. Anyone drops it on Explore to add it.">
        Export .illusion
      </a>
      {e.kind === "local" && (
        <a className="ttool sq" href={templateWorkflowUrl(e.id)} download={`${e.id.split("/").pop()}.json`} aria-label="ComfyUI workflow"
          title="ComfyUI workflow: this template's prompt, settings and samples in one file. Drop it into ComfyUI.">
          <I n="download" />
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
  // A draft isn't on Explore yet: nothing there to view.
  const fromRun = (generation: string) => apply(() => api.setCover(e.id, generation), () =>
    toast(e.draft ? { text: "Cover set. Publish puts it on Explore with this cover.", tone: "ok" }
      : { text: "Template cover updated.", tone: "ok", action: { label: "View", run: () => go({ name: "explore", t: e.id }) } }));
  const reset = () => apply(() => api.resetCover(e.id), () => toast({ text: "Cover reset.", tone: "ok" }));
  return { busy, fromRun, reset };
}
