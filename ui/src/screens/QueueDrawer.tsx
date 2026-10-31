import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { appRoot, cx, EmptyBox, I, jobProgress, QUEUED } from "../components/oi";
import { useRemoveTemplate } from "../components/TemplateCard";
import { api, type EngineInfo, type Job } from "../lib/api";
import { confirm } from "../lib/confirm";
import { describeFailure } from "../lib/errors";
import { clock, elapsed, errMsg, shortModel } from "../lib/format";
import { isActive, useElapsed, useJobs } from "../lib/live";
import { clipWindow, leadSlot } from "../lib/fields";
import { cachedEngine } from "../lib/query";
import { go } from "../lib/route";
import { useRunName } from "../lib/runs";
import { useApp, type StudioState } from "../lib/store";

const FAILED = new Set(["failed", "moderated"]);

/** Every run from both studios, grouped by what it needs from you. Slides out from the rail; a bottom sheet on phones. */
export function QueueDrawer() {
  const open = useApp((s) => s.queueOpen);
  const setOpen = useApp((s) => s.setQueue);
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const { data: jobs = [] } = useJobs();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  // Templates saved in Build and not published: they wait here, not on Explore, until a tested run publishes them.
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const drafts = (engines.data ?? []).filter((e) => e.draft);
  const runs = useQuery({ queryKey: ["generations", "explore-use"], queryFn: () => api.generations({ shelf: "mine", limit: 5000 }), staleTime: 60_000, enabled: open && drafts.length > 0 });
  const tested = new Set((runs.data ?? []).filter((r) => r.status === "done").map((r) => r.model));
  const running = jobs.filter((j) => isActive(j) && !QUEUED.has(j.state));
  const waiting = jobs.filter((j) => QUEUED.has(j.state));
  const attention = jobs.filter((j) => FAILED.has(j.state));
  const finished = jobs.filter((j) => !isActive(j) && !FAILED.has(j.state));
  const done = jobs.filter((j) => !isActive(j)).length;
  const openJob = (j: Job) => { setOpen(false); go({ name: "generation", id: j.id }); };
  // Drafts come after what needs you now, before what's done.
  const sections: [string, (Job | EngineInfo)[], string?][] = [
    ["Running", running, `${running.length} of ${settings.data?.max_parallel ?? 2} slots`],
    ["Up next", waiting],
    ["Needs attention", attention],
    ["Drafts", drafts],
    ["Finished", finished],
  ];
  const cancelAll = async () => {
    const n = running.length + waiting.length;
    const res = await confirm({
      icon: "x",
      view: () => ({
        title: `Cancel ${n} runs?`, body: "Waiting runs stop now. Running ones stop at ComfyUI's next node; a cloud run already at the provider may still finish.",
        facts: [`${running.length} running`, `${waiting.length} waiting`], action: "Cancel all",
      }),
    });
    if (!res.ok) return;
    try {
      qc.setQueryData(["jobs"], (await api.cancelAll()).jobs);
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal container={appRoot()}>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content aria-describedby={undefined} className="qpanel" style={{ outline: "none" }}>
          <div className="qhead">
            <Dialog.Title asChild><h2>Queue</h2></Dialog.Title>
            {running.length + waiting.length > 0 && <span className="pill"><i className="dot" style={{ background: "var(--accent)" }} />{running.length + waiting.length} active</span>}
            <Dialog.Close asChild><button className="icon-btn" type="button" aria-label="Close queue"><I n="x" /></button></Dialog.Close>
          </div>
          <div className="qbody">
            {jobs.length + drafts.length === 0 ? (
              <EmptyBox icon="layers" title="Nothing in the queue" style={{ marginTop: 40 }}>Runs show up here while they work. Finished ones stay in your Library.</EmptyBox>
            ) : sections.map(([title, list, note]) => list.length > 0 && (
              <section className="qsec" key={title}>
                <h5>{title}<span>{note ?? list.length}</span></h5>
                {title === "Drafts" ? drafts.map((e) => <DraftRow key={e.id} e={e} tested={tested.has(e.id)} onOpen={() => setOpen(false)} />)
                  : (list as Job[]).map((j) => <JobRow key={j.id} j={j} onOpen={() => openJob(j)} />)}
              </section>
            ))}
          </div>
          <div className="qfoot">
            <I n="check" style={{ color: "var(--mint)" }} />
            <span style={{ flex: 1 }}>Results save the moment they finish.</span>
            {running.length + waiting.length > 1 && <button className="btn sm ghost danger" type="button" onClick={() => void cancelAll()}>Cancel all</button>}
            <button className="btn sm ghost" type="button" disabled={!done}
              onClick={async () => { try { qc.setQueryData(["jobs"], await api.clearJobs()); } catch (e) { toast({ text: errMsg(e), tone: "error" }); } }}>Clear finished</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A draft: opens in Create, where a finished run of it lets you publish it to Explore. The trash deletes it. */
function DraftRow({ e, tested, onOpen }: { e: EngineInfo; tested: boolean; onOpen: () => void }) {
  const openTemplate = useApp((s) => s.openTemplate);
  const del = useRemoveTemplate(e, () => {});
  const open = () => { onOpen(); openTemplate(e.mode, e.id); go({ name: e.mode }); };
  return (
    <div className={cx("qitem qdraft", tested && "ok")}>
      <button type="button" className="th" onClick={open} aria-label={`Open ${e.label} in Create`} style={{ padding: 0, border: 0, background: "var(--field)", display: "grid", placeItems: "center", color: "var(--text-3)" }}>
        {e.cover ? <img src={e.cover} alt="" /> : <I n={e.mode === "motion" ? "film" : "image"} />}
      </button>
      <button type="button" onClick={open} style={{ display: "block", width: "100%", minWidth: 0, textAlign: "left", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer" }}>
        <b>{e.label.trim() || "Untitled"}<span className="qprompt"> · {e.model_name || e.provider}</span></b>
        <div className="sub">{tested ? "Tested · publish it in Create" : "Not tested · run it once"}</div>
      </button>
      <span className="qend">
        <span className="pill draftp"><i className="dot" />{tested ? "Ready" : "Draft"}</span>
        {del && <button className="icon-btn" type="button" aria-label={`${del.label}: ${e.label}`} title={del.label} disabled={del.busy} onClick={() => void del.run()}><I n="trash" /></button>}
      </span>
    </div>
  );
}

function JobRow({ j, onOpen }: { j: Job; onOpen: () => void }) {
  const t = useElapsed(j.started ?? j.created, j.finished);
  const toast = useApp((s) => s.toast);
  const setStudio = useApp((s) => s.setStudio);
  const loadGeneration = useApp((s) => s.loadGeneration);
  const qc = useQueryClient();
  const nameOf = useRunName();
  const { name, sub: prompt } = nameOf(j);
  const active = isActive(j);
  const waiting = QUEUED.has(j.state);
  const failed = FAILED.has(j.state);
  const p = jobProgress(j);
  const pct = j.progress?.value != null ? Math.round(j.progress.value * 100) : null;

  const sub =
    active && !waiting ? `${clock(t, false)} · ${pct != null ? `${pct}%${j.progress?.nodes_total ? ` · node ${j.progress.nodes_done}/${j.progress.nodes_total}` : ""}` : j.kind === "local" ? j.detail || "starting" : "no progress reported"}`
    : waiting ? (j.queue_position ? `#${j.queue_position} in line · ${shortModel(j.model)}` : j.detail || shortModel(j.model))
    : j.state === "done" ? `${elapsed(t)} · ${j.kind === "local" ? "your GPU" : "Comfy Router"}`
    : failed || j.state === "cancelled" ? describeFailure(j.state, j.error, j.detail).title
    : j.detail;

  const remixFix = async (fix: string) => {
    try {
      const m = await api.generation(j.id);
      const mode = loadGeneration(m);
      const e = fix === "smaller" || fix === "downscale" ? (await api.engines()).find((x) => x.id === m.engine.model) : undefined;
      const small = e?.size?.options[0]?.label;
      const lead = leadSlot(e);
      setStudio(mode, (s): Partial<StudioState> => {
        if (fix === "trim") {
          const te = cachedEngine(s.engine);
          return { videos: s.videos.map((v) => ({ ...v, trim: [0, Math.min(clipWindow(te, v.slot)?.[1] ?? 10, v.duration ?? 10)] })) };
        }
        if (fix === "downscale") return small ? { videos: s.videos.map((v) => ({ ...v, size: small })) } : {};
        if (fix !== "smaller" || !small) return {};
        // The smallest step for a declared output size and for the main input; the workflow does the rest.
        const params = e?.size?.canvas ? { params: { ...s.params, out_size: small } } : {};
        return lead.startsWith("video:")
          ? { ...params, videos: s.videos.map((v) => (v.slot === lead ? { ...v, size: small } : v)) }
          : { ...params, refs: s.refs.map((r, i) => (`image:${r.slot ?? i + 1}` === lead ? { ...r, size: small } : r)) };
      });
      toast({ text: fix === "trim" ? "Loaded with the clips trimmed to fit. Press Run." : fix === "downscale" ? (small ? `Loaded; the clip goes at ${small}. Press Run.` : "Loaded into Create. Pick a smaller size, then Run.")
        : small ? `Loaded at ${small}. Press Run.` : fix === "smaller" ? "Loaded. Pick a smaller size, then Run." : "Loaded into Create. Fix what's highlighted, then Run.", tone: "ok" });
      useApp.getState().setQueue(false);
      go({ name: mode });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const retry = async () => {
    try {
      await api.rerun(j.id);
      await qc.invalidateQueries({ queryKey: ["jobs"] });
      await qc.refetchQueries({ queryKey: ["jobs"] });
    } catch (e) { toast({ text: errMsg(e), tone: "error" }); }
  };
  const cancel = () => api.cancel(j.id).catch((e) => toast({ text: errMsg(e), tone: "error" }));
  const dismiss = async () => { try { qc.setQueryData(["jobs"], await api.dismissJob(j.id)); } catch (e) { toast({ text: errMsg(e), tone: "error" }); } };
  const actions = failed && j.fixes.length > 0;

  return (
    <div className={cx("qitem", failed && "failed")} style={waiting ? { opacity: 0.75 } : undefined}>
      <button type="button" className="th" onClick={onOpen} aria-label={`Open ${name}`} style={{ padding: 0, border: 0, background: "var(--field)", display: "grid", placeItems: "center", color: "var(--text-3)" }}>
        {j.preview || j.poster ? <img src={j.preview ?? j.poster!} alt="" style={waiting ? { filter: "blur(3px) saturate(.4)" } : undefined} /> : <I n="image" />}
      </button>
      <div style={{ minWidth: 0 }}>
        <button type="button" onClick={onOpen} style={{ display: "block", width: "100%", minWidth: 0, textAlign: "left", background: "none", border: 0, padding: 0, color: "inherit", cursor: "pointer" }}>
          <b>{name}{prompt && <span className="qprompt"> · {prompt}</span>}</b>
          <div className="sub" title={failed ? j.detail : undefined}>{sub}</div>
        </button>
        {active && !waiting && <div className="bar" aria-hidden><i style={{ "--p": p } as CSSProperties} /></div>}
        {actions && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
            {j.fixes.includes("trim") && <button className="btn sm" type="button" onClick={() => remixFix("trim")}>Trim to 10 s</button>}
            {j.fixes.includes("downscale") && <button className="btn sm" type="button" onClick={() => remixFix("downscale")}>Downscale</button>}
            {j.fixes.includes("smaller") && <button className="btn sm" type="button" onClick={() => remixFix("smaller")}>Try a smaller size</button>}
            {(j.fixes.includes("edit") || j.fixes.includes("check")) && <button className="btn sm" type="button" onClick={() => remixFix("edit")}>Fix in Create</button>}
            {j.fixes.includes("rerun") && <button className="btn sm" type="button" onClick={retry}>Try again</button>}
          </div>
        )}
      </div>
      {active ? (
        <button className="icon-btn" type="button" aria-label={`Cancel ${name}`} title="Cancel" onClick={cancel}><I n="x" /></button>
      ) : j.state === "done" ? (
        // Done shows a check; pointed at, it's the button that takes the row off the queue.
        <button className="icon-btn qdone" type="button" aria-label={`Remove ${name} from the queue`} title="Remove from the queue; the result stays in your Library" onClick={dismiss}>
          <I n="check" className="ok" /><I n="x" className="rm" />
        </button>
      )
        : <button className="icon-btn" type="button" aria-label={`Dismiss ${name}`} title="Dismiss; the run stays in your Library" onClick={dismiss}><I n="x" /></button>}
    </div>
  );
}
