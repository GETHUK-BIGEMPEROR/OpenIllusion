import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CSSProperties } from "react";
import { appRoot, cx, EmptyBox, I, jobProgress, QUEUED } from "../components/oi";
import { api, type Job } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { clock, elapsed, errMsg, money, shortModel } from "../lib/format";
import { isActive, useElapsed, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { useRunName } from "../lib/runs";
import { useApp } from "../lib/store";

const FAILED = new Set(["failed", "moderated"]);

/** Every run from both studios, grouped by what it needs from you. Slides out from the rail; a bottom sheet on phones. */
export function QueueDrawer() {
  const open = useApp((s) => s.queueOpen);
  const setOpen = useApp((s) => s.setQueue);
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const { data: jobs = [] } = useJobs();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const running = jobs.filter((j) => isActive(j) && !QUEUED.has(j.state));
  const waiting = jobs.filter((j) => QUEUED.has(j.state));
  const attention = jobs.filter((j) => FAILED.has(j.state));
  const finished = jobs.filter((j) => !isActive(j) && !FAILED.has(j.state));
  const done = jobs.filter((j) => !isActive(j)).length;
  const openJob = (j: Job) => { setOpen(false); go({ name: "generation", id: j.id }); };
  const sections: [string, Job[], string?][] = [
    ["Running", running, `${running.length} of ${settings.data?.max_parallel ?? 2} slots`],
    ["Up next", waiting],
    ["Needs attention", attention],
    ["Finished", finished],
  ];
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal container={appRoot()}>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content aria-describedby={undefined} className="qpanel" style={{ outline: "none" }}>
          <div className="qhead">
            <Dialog.Title asChild><h2>Queue</h2></Dialog.Title>
            {running.length + waiting.length > 0 && <span className="pill"><i className="dot" style={{ background: "var(--yellow)" }} />{running.length + waiting.length} active</span>}
            <Dialog.Close asChild><button className="icon-btn" type="button" aria-label="Close queue"><I n="x" /></button></Dialog.Close>
          </div>
          <div className="qbody">
            {jobs.length === 0 ? (
              <EmptyBox icon="layers" title="Nothing in the queue" style={{ marginTop: 40 }}>Runs show up here while they work. Finished ones stay in your Library.</EmptyBox>
            ) : sections.map(([title, list, note]) => list.length > 0 && (
              <section className="qsec" key={title}>
                <h5>{title}<span>{note ?? list.length}</span></h5>
                {list.map((j) => <JobRow key={j.id} j={j} onOpen={() => openJob(j)} />)}
              </section>
            ))}
          </div>
          <div className="qfoot">
            <I n="check" style={{ color: "var(--mint)" }} />
            <span style={{ flex: 1 }}>Results save the moment they finish.</span>
            <button className="btn sm ghost" type="button" disabled={!done}
              onClick={async () => { try { qc.setQueryData(["jobs"], await api.clearJobs()); } catch (e) { toast({ text: errMsg(e), tone: "error" }); } }}>Clear finished</button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
    : j.state === "done" ? `${elapsed(t)} · ${j.kind === "local" ? "your GPU" : j.estimate && j.estimate.source !== "unknown" ? `est. ${money(j.estimate).label}` : "cost not reported"}`
    : failed || j.state === "cancelled" ? describeFailure(j.state, j.error, j.detail).title
    : j.detail;

  const remixFix = async (fix: string) => {
    try {
      const m = await api.generation(j.id);
      const mode = loadGeneration(m);
      const sized = fix === "smaller" || fix === "downscale" ? (await api.engines()).find((e) => e.id === m.engine.model)?.size : undefined;
      const small = sized?.options[0]?.label;
      setStudio(mode, (s) => {
        if (fix === "trim" && s.video) return { video: { ...s.video, trim: [0, Math.min(10, s.video.duration ?? 10)] } };
        if (fix === "downscale" && s.video) return small ? { video: { ...s.video, size: small } } : { video: { ...s.video, maxHeight: 720 } };
        // The input the output follows goes to the smallest size.
        if (small && sized) return sized.follows.startsWith("video:")
          ? { video: s.video ? { ...s.video, size: small } : null }
          : { refs: s.refs.map((r, i) => (`image:${r.slot ?? i + 1}` === sized.follows ? { ...r, size: small } : r)) };
        return {};
      });
      toast({ text: fix === "trim" ? "Loaded with the clip trimmed to 10 s. Press Run." : fix === "downscale" ? (small ? `Loaded; the clip goes at ${small}. Press Run.` : "Loaded; the clip goes at 720p. Press Run.")
        : small ? `Loaded at ${small}. Press Run.` : fix === "smaller" ? "Loaded. Pick a smaller size, then Run." : "Loaded into Create. Fix what's highlighted, then Run.", tone: "ok" });
      useApp.getState().setQueue(false);
      go({ name: mode });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const retry = async () => {
    try { await api.rerun(j.id); } catch (e) { toast({ text: errMsg(e), tone: "error" }); }
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
      ) : j.state === "done" ? <I n="check" style={{ color: "var(--mint)", marginRight: 8 }} />
        : <button className="icon-btn" type="button" aria-label={`Dismiss ${name}`} title="Dismiss; the run stays in your Library" onClick={dismiss}><I n="x" /></button>}
    </div>
  );
}
