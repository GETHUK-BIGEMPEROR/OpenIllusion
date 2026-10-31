import { useEffect, useState, type CSSProperties } from "react";
import type { Job } from "../lib/api";
import { cx, jobProgress, QUEUED, Ring } from "./oi";

/** Seconds as m:ss. */
export function clock(s: number) {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
}

/** The time in seconds, ticking once a second while `on`. */
export function useNow(on = true) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

type Stage = { label: string; state: "done" | "on" | "todo"; sub?: string };

/** What a live run is doing, in words. A local run reports steps and nodes, so its time left comes from the pace so far.
 *  Comfy Router reports only queued and running, so a cloud run counts time against how long this template usually takes,
 *  and never shows a made-up percent. */
export function runInfo(job: Job, now: number) {
  const cloud = job.kind === "cloud";
  const p = job.progress;
  const at = job.state === "downloading" ? 3 : job.state === "running" ? 2 : job.state === "queued" ? 1 : 0;
  const value = jobProgress(job);
  const spent = at >= 2 && job.started ? Math.max(0, now - job.started) : Math.max(0, now - job.created);
  const steps = p?.step && p.steps ? `${p.step} of ${p.steps}` : null;
  const nodes = p?.nodes_total ? `node ${p.nodes_done ?? 0} of ${p.nodes_total}` : null;
  let left: number | null = null;
  if (at === 2) {
    if (!cloud && value > 0.08 && spent > 2) left = (spent / value) * (1 - value);
    else if (job.typical) left = job.typical - spent;
  }
  const title = at === 3 ? "Saving the result"
    : job.state === "rate_limited" ? "Rate limited, retrying"
    : at === 1 ? (cloud ? "Queued at Router" : "Queued in your ComfyUI")
    : at === 0 ? "Getting ready"
    : steps ? `Sampling · step ${steps}`
    : cloud ? "Generating"
    : p?.current_node_class ? `Running ${p.current_node_class}` : "Starting";
  const line = at === 1 ? (job.queue_position ? `#${job.queue_position} in line` : "Starts after the run ahead of it")
    : at === 2 && cloud ? (job.typical ? `Usually takes about ${clock(job.typical)}` : "Comfy Router sends no progress, so this counts time")
    : at === 2 ? [steps && p?.current_node_class, nodes].filter(Boolean).join(" · ") || job.detail
    : job.detail;
  const stages: Stage[] = ["Getting ready", "In line", cloud ? "Generating" : "Sampling", "Saving"].map((label, i) => ({
    label,
    state: i < at ? "done" : i === at ? "on" : "todo",
    sub: i !== at ? undefined : i === 1 ? (job.queue_position ? `#${job.queue_position}` : undefined)
      : i === 2 ? (p?.step && p.steps ? `${p.step}/${p.steps}` : p?.nodes_total ? `${p.nodes_done ?? 0}/${p.nodes_total}` : clock(spent)) : undefined,
  }));
  return {
    title, line, spent, stages, value,
    left: left != null && left >= 1 ? left : null,
    late: left != null && left < 1,
    known: !cloud && at === 2 && value > 0,
    queued: QUEUED.has(job.state),
  };
}

/** Progress you can't measure: a spinning ring, not a percent. */
function Spin({ sm }: { sm?: boolean }) {
  return <span className={cx("rspin", sm && "sm")} aria-hidden />;
}

/** A live run over its frame: stages, what it's doing, time spent and left. `small` for cards: one line and a bar. */
export function RunHud({ job, small, onCancel }: { job: Job; small?: boolean; onCancel?: () => void }) {
  const r = runInfo(job, useNow());
  const time = r.left ? `about ${clock(r.left)} left` : r.late ? "longer than usual" : "";
  if (small) {
    return (
      <div className="runhud sm">
        <div className="rh-t"><b>{r.title}</b><span className="mono">{clock(r.spent)}{time && ` · ${time}`}</span></div>
        <div className={cx("rbar", !r.known && "indet")}><i style={r.known ? { "--p": r.value } as CSSProperties : undefined} /></div>
      </div>
    );
  }
  return (
    <div className="runhud" role="status">
      <ol className="rstages" aria-label="Stages">
        {r.stages.map((s) => (
          <li key={s.label} className={s.state}><i /><span>{s.label}{s.sub && <small className="mono">{s.sub}</small>}</span></li>
        ))}
      </ol>
      <div className="rh-row">
        {r.known ? <Ring p={r.value} sm /> : <Spin />}
        <div className="rh-t"><b>{r.title}</b>{r.line && <span>{r.line}</span>}</div>
        <div className="rh-time mono"><b>{clock(r.spent)}</b>{time && <span>{time}</span>}</div>
        {onCancel && <button className="btn sm ghost" type="button" onClick={(e) => { e.stopPropagation(); onCancel(); }}>Cancel</button>}
      </div>
    </div>
  );
}

/** Under a live frame's image: grain while a local sampler works, a slow shimmer while a cloud model does, and a label
 *  when the image is the sampler's own preview. */
export function RunVeil({ job, preview }: { job?: Job; preview?: boolean }) {
  return (
    <>
      {job?.kind === "cloud" ? <div className="aurora" /> : <div className="noise" />}
      <div className="rscan" />
      {preview && <span className="pill lpv"><i className="dot" />Live preview from the sampler</span>}
    </>
  );
}
