import { useQuery } from "@tanstack/react-query";
import { api, type EngineInfo, type LocalReadiness, type Status } from "./api";

export function useLocalReadiness(engines: EngineInfo[], status?: Status, enabled = true) {
  return useQuery({
    queryKey: ["local-readiness", status?.local.comfyui_url, engines.filter(e => e.kind === "local").map(e => e.id), engines],
    queryFn: () => api.localReadiness(),
    enabled: enabled && !!status?.local.comfyui && engines.some(e => e.kind === "local"),
    staleTime: 30_000,
    refetchInterval: 30_000,
    retry: false,
  });
}

export type Readiness = { state: "ready" | "setup" | "checking" | "unknown"; label: string; reason: string };

export function templateReadiness(e: EngineInfo, status?: Status, checks?: LocalReadiness, failed = false): Readiness {
  const setup = (reason: string): Readiness => ({ state: "setup", label: "Needs setup", reason });
  const checking: Readiness = { state: "checking", label: "Checking", reason: "Checking this template's connection and requirements" };
  if (!status) return checking;
  if (e.kind === "cloud") {
    if (!status.has_key) return setup("Add a Comfy API key to use cloud templates");
    if (status.router.ok == null) return checking;
    return status.router.ok
      ? { state: "ready", label: "Ready", reason: "Cloud connection checked. Review inputs in Create; cloud runs are billed by the provider." }
      : { state: "setup", label: "Cloud unavailable", reason: status.router.message || "Check your Comfy API key and connection in Settings" };
  }
  const l = status.local;
  if (!l.comfyui) return setup("Start ComfyUI or set its address in Settings");
  if (l.upstream_match === false) return setup("The proxy points to a different ComfyUI. Review its address in Settings");
  if (!l.v2 && !(l.proxy_installed && l.autostart)) return setup("Start Comfy API v2 or enable the installed proxy in Settings");
  if (failed || checks?.reachable === false) return { state: "unknown", label: "Not checked", reason: "Couldn't verify nodes and models. Check the connection and try again." };
  const check = checks?.templates[e.id];
  if (!check) return checks ? { state: "unknown", label: "Not checked", reason: "This template wasn't in the last check. Check again or open its details." } : checking;
  if (check.ok) return { state: "ready", label: "Ready", reason: "Connection, nodes and models checked. Review your inputs in Create." };
  const parts = [check.missing_nodes?.length && "missing nodes", check.missing_models?.length && "missing models", check.bad_values?.length && "settings to review"].filter(Boolean);
  return setup(check.message || (parts.length ? `${parts.join(", ")}. Open details for the checklist.` : "Open details to review this template"));
}
