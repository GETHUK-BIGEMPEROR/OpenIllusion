// Small shared pieces: outcome toggle, validation row.
import type { Outcome } from "../lib/api";
import { OUTCOME } from "../lib/format";
import { cx } from "./ui";
import { I } from "./oi";

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
