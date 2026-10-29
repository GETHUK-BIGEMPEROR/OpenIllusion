// Create's history: this template's earlier runs, as a list or a strip.
import { useQuery } from "@tanstack/react-query";
import { useMemo, type CSSProperties } from "react";
import { cx, jobProgress, Ring } from "../../components/oi";
import { api, fileUrl, type GenerationRow, type Job } from "../../lib/api";
import { isActive } from "../../lib/live";
import { FAILED } from "./shared";

/** Your runs of this template, newest first. */
export function useRuns(engine: string) {
  return useQuery({
    queryKey: ["generations", "runs", engine],
    queryFn: () => api.generations({ model: engine, shelf: "mine" }),
    enabled: !!engine,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === "running") ? 5000 : false),
  });
}

function HThumb({ g, on, job, onPick }: { g: GenerationRow; on: boolean; job?: Job; onPick: () => void }) {
  const live = (!!job && isActive(job)) || g.status === "running";
  const failed = !live && FAILED.has(g.status);
  const img = (live && job?.preview) || (g.poster ? fileUrl(g.id, g.poster) : null);
  return (
    <button className={cx("hthumb", failed && "failed")} type="button" aria-current={on} onClick={onPick} style={{ "--p": jobProgress(job) } as CSSProperties}
      aria-label={`${g.prompt || g.title}, ${live ? "running" : failed ? `failed: ${g.error ?? "open it to see why"}` : "done"}`}
      title={failed ? `Failed · ${g.error ?? "open it to see why"}` : g.prompt || g.title}>
      {img ? <img src={img} alt="" style={live ? { filter: "blur(6px) saturate(.3)" } : undefined} /> : <span style={{ position: "absolute", inset: 0, background: "var(--raised)" }} />}
      {live && <Ring p={jobProgress(job)} sm />}
    </button>
  );
}

export function HistList({ engine, current, jobs, onPick }: { engine: string; current: string | null; jobs: Job[]; onPick: (id: string) => void }) {
  const runs = useRuns(engine);
  const list = runs.data ?? [];
  return (
    <>
      <h5>Runs{list.length ? <span className="mono"> {list.length}</span> : null}</h5>
      <div className="hist-list">
        {list.length ? list.slice(0, 60).map((g) => <HThumb key={g.id} g={g} on={g.id === current} job={jobs.find((j) => j.id === g.id)} onPick={() => onPick(g.id)} />)
          : runs.isLoading ? null : <><span className="hslot" aria-hidden /><p className="none">No runs yet</p></>}
      </div>
    </>
  );
}

export function HistStrip({ engine, current, jobs, onPick }: { engine: string; current: string | null; jobs: Job[]; onPick: (id: string) => void }) {
  const runs = useRuns(engine);
  const list = useMemo(() => (runs.data ?? []).slice(0, 30), [runs.data]);
  if (!list.length) return null;
  return (
    <div className="hist-strip" aria-label="Runs of this template">
      <span className="lab">Runs</span>
      {list.map((g) => <HThumb key={g.id} g={g} on={g.id === current} job={jobs.find((j) => j.id === g.id)} onPick={() => onPick(g.id)} />)}
    </div>
  );
}
