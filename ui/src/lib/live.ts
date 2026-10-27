import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type Job } from "./api";

const TERMINAL = new Set(["done", "failed", "moderated", "cancelled"]);
export const isActive = (j: Job) => !TERMINAL.has(j.state);

function upsert(qc: QueryClient, job: Job) {
  qc.setQueryData<Job[]>(["jobs"], (old = []) => {
    const rest = old.filter((j) => j.id !== job.id);
    return [job, ...rest].sort((a, b) => b.created - a.created);
  });
  if (TERMINAL.has(job.state)) {
    qc.invalidateQueries({ queryKey: ["generations"] });
    qc.invalidateQueries({ queryKey: ["generation", job.id] });
    qc.invalidateQueries({ queryKey: ["facets"] });
  }
}

/** Job updates arrive on the server's websocket, /api/ws. */
export function useJobFeed() {
  const qc = useQueryClient();
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry = 1000;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/api/ws`);
      ws.onopen = () => {
        retry = 1000;
        qc.invalidateQueries({ queryKey: ["jobs"] });
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") return;
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === "job") upsert(qc, msg.data as Job);
          if (msg.type === "backup" || msg.type === "restore") qc.setQueryData(["progress", msg.type], msg.data);
          if (msg.type === "library") {
            // Deleted, restored, imported or edited elsewhere (another tab, the API).
            for (const key of ["generations", "facets", "trash"]) qc.invalidateQueries({ queryKey: [key] });
            for (const id of (msg.data?.ids ?? []) as string[]) qc.invalidateQueries({ queryKey: ["generation", id] });
          }
        } catch {
          /* not ours */
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, retry);
        retry = Math.min(retry * 2, 15000);
      };
    };
    connect();
    return () => {
      closed = true;
      ws?.close();
    };
  }, [qc]);
}

/** How far a backup or restore has got, from the socket: `{done, total}` in bytes. */
export function useProgress(kind: "backup" | "restore") {
  return useQuery<{ done: number; total: number } | null>({ queryKey: ["progress", kind], queryFn: () => null, enabled: false, initialData: null });
}

export function useJobs() {
  return useQuery({
    queryKey: ["jobs"],
    queryFn: api.jobs,
    // The websocket is primary; this is a slow safety net while anything runs.
    refetchInterval: (q) => ((q.state.data ?? []).some(isActive) ? 8000 : false),
  });
}

/** Seconds since `from`, ticking once a second. */
export function useElapsed(from: number | null | undefined, until?: number | null) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (!from || until) return;
    const t = setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => clearInterval(t);
  }, [from, until]);
  if (!from) return 0;
  return (until ?? now) - from;
}
