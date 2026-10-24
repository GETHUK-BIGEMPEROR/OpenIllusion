// One vocabulary for failures: a short title, a sentence that says what to do,
// and the raw text kept for "Show details". Used by the stage, queue and detail page.

export interface Failure {
  title: string;
  body: string;
  raw: string | null;
  kind: "memory" | "requirements" | "connection" | "input" | "size" | "moderated" | "cancelled" | "auth" | "unknown";
}

type Err = { error_type?: unknown; message?: unknown; status?: unknown } | null | undefined;

export function describeFailure(state: string, error: Err, detail?: string | null): Failure {
  const type = String(error?.error_type ?? "");
  const raw = String(error?.message ?? detail ?? "").trim() || null;
  const text = `${type} ${raw ?? ""} ${detail ?? ""}`.toLowerCase();

  if (state === "cancelled") return { kind: "cancelled", title: "Cancelled", body: "The run was stopped before it finished. Nothing else changed.", raw: null };
  if (state === "moderated" || type === "moderated" || text.includes("moderat"))
    return { kind: "moderated", title: "Blocked by the provider's safety filter", body: "Rephrase the prompt or swap the reference that tripped it, then run again.", raw };
  if (type === "out_of_memory" || text.includes("out of memory") || text.includes("would exceed allowed memory"))
    return { kind: "memory", title: "Your GPU ran out of memory", body: "Lower the resolution, run one variant at a time, or close other apps using the GPU.", raw };
  if (type === "missing_requirements" || text.includes("missing node") || text.includes("missing model"))
    return { kind: "requirements", title: "Your ComfyUI is missing something", body: "Install the nodes and models listed in the run panel, then run again.", raw };
  if (type === "unreachable" || text.includes("couldn't reach") || text.includes("connection refused"))
    return { kind: "connection", title: "Couldn't connect", body: detail && !detail.startsWith("Couldn't") ? detail : "The engine didn't answer. Check that it's running, then try again.", raw };
  if (type === "unauthorized" || type === "invalid_api_key" || String(error?.status) === "401")
    return { kind: "auth", title: "Your API key was refused", body: "Check or replace the key in Settings → Cloud.", raw };
  if (type === "request_too_large" || text.includes("too large") || text.includes("upload limit"))
    return { kind: "size", title: "An input is too large", body: "Trim the clip or downscale it, then run again.", raw };
  if (type === "invalid_request" || type === "validation_error" || text.startsWith("invalid input"))
    return { kind: "input", title: "The engine rejected an input", body: clean(detail) ?? "Fix the highlighted field and run again.", raw };
  return { kind: "unknown", title: "The run failed", body: clean(detail) ?? "Try again. If it keeps failing, open the details and check the engine's log.", raw };
}

/** First sentence of a long engine message, without stack-ish noise. */
function clean(s?: string | null): string | null {
  if (!s) return null;
  const one = s.replace(/^ComfyUI failed · /, "").split("\n")[0].trim();
  return one.length > 180 ? `${one.slice(0, 177)}…` : one || null;
}
