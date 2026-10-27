// Small shared pieces: cost line, outcome toggle, mode badge, validation row.
import type { Estimate, Outcome } from "../lib/api";
import { money, OUTCOME } from "../lib/format";
import { AlertTriangle, Check, CheckCircle, Close, Dash, Info } from "./Icons";
import { Badge, cx } from "./ui";

/** Cost for the run footer: one line, with a reason underneath when there's no price. */
export function CostPill({ estimate, times = 1, compact = false }: { estimate?: Estimate | null; times?: number; compact?: boolean }) {
  const m = money(estimate, times);
  const color = { exact: "text-text", estimated: "text-text", unknown: "text-orange-text", invalid: "text-rose-text", local: "text-text" }[m.tone];
  if (compact) return <span className={cx("font-mono text-xs tabular", color)}>{m.label}</span>;
  const label = m.tone === "local" ? "Runs on" : m.tone === "exact" ? "Cost" : m.tone === "estimated" ? "Est. cost" : "Cost";
  const value = m.tone === "local" ? "Your GPU · no credits" : estimate ? m.label : "Estimating…";
  const why =
    m.tone === "unknown" && estimate ? (estimate.reason === "incomplete" ? "Priced once the required inputs are in." : "Router can't price this model before the run.")
    : m.tone === "invalid" ? (() => { const v = estimate?.router?.validation?.[0]; return v ? `Router: ${v.loc.slice(1).join(".")} — ${v.msg}` : estimate?.router?.message ?? "Router rejected the request."; })()
    : null;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="text-muted">{label}</span>
        <span className={cx("font-mono tabular", color)}>{value}{times > 1 && m.tone !== "unknown" && m.tone !== "invalid" ? <span className="text-muted"> · ×{times}</span> : null}</span>
      </div>
      {why && <span className={cx("text-xs", m.tone === "invalid" ? "text-rose-text" : "text-muted")}>{why}</span>}
    </div>
  );
}

export function OutcomeToggle({ value, onChange, size = "md" }: { value: Outcome | null; onChange: (o: Outcome | null) => void; size?: "sm" | "md" }) {
  return (
    <div role="group" aria-label="Outcome" className="inline-flex p-0.5 gap-0.5 rounded-lg bg-bg border border-line">
      {(["worked", "partly", "didnt"] as Outcome[]).map((o) => {
        const on = value === o;
        const s = OUTCOME[o];
        const Icon = o === "worked" ? Check : o === "partly" ? Dash : Close;
        return (
          <button
            key={o}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? null : o)}
            className={cx("mk-btn inline-flex items-center gap-1.5 rounded-md border-0 text-sm", size === "sm" ? "h-6 px-2" : "h-[26px] px-2.5", on ? "font-medium" : "bg-transparent text-muted hover:text-text")}
            style={on ? { background: s.soft, color: s.text } : undefined}
          >
            <Icon size={12} style={{ color: s.color }} />
            {s.word}
          </button>
        );
      })}
    </div>
  );
}

export function ModeBadge({ mode, className, glass }: { mode: "motion" | "edit"; className?: string; glass?: boolean }) {
  return <Badge tone={glass ? "glass" : "neutral"} className={cx("uppercase", className)}>{mode}</Badge>;
}

export function ValidationRow({ level, text, detail }: { level: "pass" | "warn" | "info"; text: string; detail?: string }) {
  const K = {
    pass: { Icon: CheckCircle, cls: "text-mint" },
    warn: { Icon: AlertTriangle, cls: "text-orange" },
    info: { Icon: Info, cls: "text-violet-light" },
  }[level];
  return (
    <li className="flex items-start gap-2.5 px-3 py-2 border-b border-line last:border-b-0">
      <K.Icon size={15} className={cx("shrink-0 mt-px", K.cls)} />
      <span className="flex-1 min-w-0 text-sm">
        <span className="block text-text">{text}</span>
        {detail && <span className="block text-xs text-muted">{detail}</span>}
      </span>
    </li>
  );
}
