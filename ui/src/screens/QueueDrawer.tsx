import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { StateBadge } from "../components/bits";
import { Close, Frame, Queue } from "../components/Icons";
import { Button, Empty, IconButton, Kbd, cx } from "../components/ui";
import { api, type Job } from "../lib/api";
import { describeFailure } from "../lib/errors";
import { clock, elapsed, errMsg, money, shortModel } from "../lib/format";
import { isActive, useElapsed, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

export function QueueDrawer() {
  const open = useApp((s) => s.queueOpen);
  const setOpen = useApp((s) => s.setQueue);
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const { data: jobs = [] } = useJobs();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const active = jobs.filter((j) => j.state === "running" || j.state === "queued" || j.state === "downloading").length;
  const finished = jobs.filter((j) => !isActive(j)).length;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 animate-fade" />
        <Dialog.Content aria-describedby={undefined} className="fixed z-50 right-0 top-0 bottom-0 w-[min(400px,100vw)] bg-panel border-l border-line shadow-float flex flex-col outline-none animate-slide">
          <div className="shrink-0 h-12 flex items-center gap-2 pl-4 pr-2 border-b border-line">
            <Dialog.Title className="m-0 text-md font-semibold">Queue</Dialog.Title>
            <span className="text-xs text-muted tabular">{active} of {settings.data?.max_parallel ?? 2} slots in use</span>
            <span className="flex-1" />
            <Dialog.Close asChild><IconButton label="Close queue"><Close size={11} /></IconButton></Dialog.Close>
          </div>
          {jobs.length === 0 ? (
            <Empty icon={<Queue size={18} />} title="Nothing in the queue" className="flex-1">Runs from both studios show up here. Press <Kbd>R</Kbd> in a studio to run.</Empty>
          ) : (
            <ol className="flex-1 m-0 p-0 list-none overflow-y-auto scroll-y">
              {jobs.map((j) => <JobRow key={j.id} j={j} onOpen={() => { setOpen(false); go({ name: "generation", id: j.id }); }} />)}
            </ol>
          )}
          <div className="shrink-0 h-12 px-4 flex items-center justify-between gap-3 border-t border-line text-xs text-muted">
            <span>Results save the moment they finish.</span>
            <Button size="sm" tone="ghost" disabled={!finished} onClick={async () => { try { qc.setQueryData(["jobs"], await api.clearJobs()); } catch (e) { toast({ text: errMsg(e), tone: "error" }); } }}>Clear finished</Button>
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
  const active = isActive(j);
  const failed = j.state === "failed" || j.state === "moderated";
  const pct = j.kind === "local" && j.progress?.value != null ? Math.round(j.progress.value * 100) : null;

  const sub =
    j.state === "running" ? `${clock(t, false)} · ${pct != null ? `${pct}%${j.progress?.nodes_total ? ` · node ${j.progress.nodes_done}/${j.progress.nodes_total}` : ""}` : j.kind === "local" ? "starting" : "no progress reported"}`
    : j.state === "done" ? `${elapsed(t)} · ${j.kind === "local" ? "your GPU" : j.estimate && j.estimate.source !== "unknown" ? `est. ${money(j.estimate).label}` : "cost not reported"}`
    : failed || j.state === "cancelled" ? describeFailure(j.state, j.error, j.detail).title
    : j.detail;

  const remixFix = async (fix: string) => {
    try {
      const m = await api.generation(j.id);
      const mode = loadGeneration(m);
      setStudio(mode, (s) => {
        if (fix === "trim" && s.video) return { video: { ...s.video, trim: [0, Math.min(10, s.video.duration ?? 10)] } };
        if (fix === "downscale" && s.video) return { video: { ...s.video, maxHeight: 720 } };
        return {};
      });
      toast({ text: fix === "trim" ? "Loaded with the clip trimmed to 10 s. Press Run." : fix === "downscale" ? "Loaded; the clip goes at 720p. Press Run." : "Loaded into the studio. Fix the highlighted field.", tone: "ok" });
      useApp.getState().setQueue(false);
      go({ name: mode });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const retry = async () => {
    try { await api.rerun(j.id); } catch (e) { toast({ text: errMsg(e), tone: "error" }); }
  };

  return (
    <li className={cx("relative px-4 py-2.5 border-b border-line flex flex-col gap-2", j.state === "running" && "bg-white/[0.02]")}>
      <div className="flex items-center gap-2.5">
        <button type="button" onClick={onOpen} className="mk-btn shrink-0 w-10 h-10 rounded-md overflow-hidden border-0 p-0 bg-raised flex items-center justify-center text-faint" aria-label={`Open ${j.title}`}>
          {j.poster ? <img src={j.poster} alt="" className="w-full h-full object-cover" /> : <Frame size={15} />}
        </button>
        <button type="button" onClick={onOpen} className="flex-1 min-w-0 flex flex-col text-left bg-transparent border-0 p-0 group">
          <span className="text-sm font-medium truncate group-hover:underline underline-offset-2">{j.title}</span>
          <span className={cx("text-xs truncate", failed ? "text-rose-text" : "text-muted")}>
            {j.state === "running" ? <span className="font-mono tabular">{sub}</span> : sub}
          </span>
        </button>
        <span className="shrink-0 flex flex-col items-end gap-1">
          <StateBadge job={j} />
          <span className="font-mono text-[10px] text-faint truncate max-w-[110px]">{shortModel(j.model)}</span>
        </span>
      </div>
      {j.state === "running" && (
        <div className="h-[3px] rounded-full bg-white/10 overflow-hidden" aria-hidden>
          {pct != null ? <div className="h-full bg-yellow rounded-full transition-[width] duration-500" style={{ width: `${pct}%` }} /> : <div className="mk-shimmer h-full" />}
        </div>
      )}
      {(active && (j.state === "running" || !j.request_id || j.kind === "local")) || (failed && j.fixes.length > 0) ? (
        <div className="flex gap-1.5 pl-[50px] flex-wrap">
          {failed && j.fixes.includes("trim") && <Button size="xs" onClick={() => remixFix("trim")}>Trim to 10 s</Button>}
          {failed && j.fixes.includes("downscale") && <Button size="xs" onClick={() => remixFix("downscale")}>Downscale</Button>}
          {failed && j.fixes.includes("edit") && <Button size="xs" onClick={() => remixFix("edit")}>Fix the input</Button>}
          {failed && j.fixes.includes("rerun") && <Button size="xs" onClick={retry}>Try again</Button>}
          {active && <Button size="xs" tone="ghost" className="text-rose-text" onClick={() => api.cancel(j.id).catch((e) => toast({ text: errMsg(e), tone: "error" }))}>Cancel</Button>}
        </div>
      ) : null}
    </li>
  );
}
