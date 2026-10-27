// Small shared pieces: cost line, outcome toggle, validation row.
import type { Estimate, Outcome } from "../lib/api";
import { money, OUTCOME } from "../lib/format";
import { cx } from "./ui";
import { I } from "./oi";

/** Cost for the run footer: one line, with a reason underneath when there's no price. */
export function CostPill({ estimate, times = 1 }: { estimate?: Estimate | null; times?: number }) {
  const m = money(estimate, times);
  const tone = m.tone === "unknown" ? "warn" : m.tone === "invalid" ? "bad" : "";
  const label = m.tone === "local" ? "Runs on" : m.tone === "estimated" ? "Est. cost" : "Cost";
  const value = m.tone === "local" ? "Your GPU · no credits" : estimate ? m.label : "Estimating…";
  const why =
    m.tone === "unknown" && estimate ? (estimate.reason === "incomplete" ? "Priced once the required inputs are in." : "Router can't price this model before the run.")
    : m.tone === "invalid" ? (() => { const v = estimate?.router?.validation?.[0]; return v ? `Router: ${v.loc.slice(1).join(".")} — ${v.msg}` : estimate?.router?.message ?? "Router rejected the request."; })()
    : null;
  return (
    <div className="cost">
      <div className="cost-r">
        <span>{label}</span>
        <span className={cx("mono", tone)}>{value}{times > 1 && m.tone !== "unknown" && m.tone !== "invalid" ? <em> · ×{times}</em> : null}</span>
      </div>
      {why && <span className={cx("cost-why", m.tone === "invalid" && "bad")}>{why}</span>}
    </div>
  );
}

export function OutcomeToggle({ value, onChange }: { value: Outcome | null; onChange: (o: Outcome | null) => void }) {
  return (
    <div role="group" aria-label="Outcome" className="seg">
      {(["worked", "partly", "didnt"] as Outcome[]).map((o) => {
        const on = value === o;
        const s = OUTCOME[o];
        return (
          <button key={o} type="button" aria-pressed={on} onClick={() => onChange(on ? null : o)} style={on ? { background: s.soft, color: s.text, boxShadow: "none" } : undefined}>
            <I n={o === "worked" ? "check" : o === "partly" ? "dash" : "x"} size={12} style={{ color: s.color }} />
            {s.word}
          </button>
        );
      })}
    </div>
  );
}

export function ValidationRow({ level, text, detail }: { level: "pass" | "warn" | "info"; text: string; detail?: string }) {
  return (
    <li className={cx("vrow", level)}>
      <I n={level === "pass" ? "ok" : level === "warn" ? "alert" : "info"} size={15} />
      <span><b>{text}</b>{detail && <small>{detail}</small>}</span>
    </li>
  );
}
