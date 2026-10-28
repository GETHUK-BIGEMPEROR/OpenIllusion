// Step 2, beside the steps: what Create will show for this template, what's left before the first run, and Run.
import { I } from "../../components/oi";
import { cx, Spinner } from "../../components/ui";
import { KIND_ICON, type MediaRow, type PromptState, type Source } from "./model";
import { slotNames } from "./Sections";

/** One thing the first run needs, met or not. */
export type Check = { ok: boolean; text: string };

/** A setting as Create shows it: asked there, or locked at the value a run uses. */
export type RailSetting = { label: string; value: string; asked: boolean };

/** A setting's value in words: "16:9 · 2 MP", "On", "720p", "5 s". */
export function shownValue(v: unknown, s: { labels?: Record<string, string>; unit?: string } = {}): string {
  if (v && typeof v === "object" && "aspect" in v) {
    const x = v as { aspect?: string; size?: string };
    return [x.aspect, x.size].filter(Boolean).join(" · ");
  }
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (v === "" || v == null) return "Auto";
  return (s.labels?.[String(v)] ?? String(v)) + (s.unit ? ` ${s.unit}` : "");
}

export function Rail({ src, name, model, media, prompt, settings, checks, why, tried, saving, saveErr, onRun }: {
  src: Source; name: string; model: string; media: MediaRow[]; prompt: PromptState; settings: RailSetting[];
  checks: Check[]; why: string; tried: boolean; saving: boolean; saveErr: string | null; onRun: () => void;
}) {
  // Create asks for the inputs a run sends: a Router template only the filled ones.
  const files = media.filter((m) => m.on && (src.kind === "local" || m.sample));
  const names = slotNames(files);
  const asked = settings.filter((s) => s.asked);
  const locked = settings.filter((s) => !s.asked);
  const video = (src.kind === "cloud" ? src.a.mode : src.a.results.find((r) => r.kind === "video") ? "motion" : "edit") === "motion";
  return (
    <aside className="brail" aria-label="What Create shows, and the first run">
      <div className="brail-card show">
        <div className="brail-h">
          <b>On Create, people see</b>
          <span><I n={src.kind === "cloud" ? "cloud" : "cpu"} />{video ? "Video" : "Photo"}</span>
        </div>
        <div className="brail-name">
          <b>{name || "Untitled"}</b>
          <span>{model}</span>
        </div>
        {files.length > 0 && (
          <div className="brail-files">
            {files.map((m, i) => {
              const thumb = m.sample ? m.sample.poster ?? (m.kind === "image" ? m.sample.url : null) : null;
              return (
                <figure key={m.key}>
                  <span className={cx("bt", m.kind, !m.sample && "empty")}>{thumb ? <img src={thumb} alt="" /> : <I n={m.sample ? KIND_ICON[m.kind] : "plus"} />}</span>
                  <figcaption>{names[i]}</figcaption>
                </figure>
              );
            })}
          </div>
        )}
        {prompt.pick && <p className="brail-prompt"><span>{prompt.def.trim() || "No prompt yet"}</span></p>}
        {asked.map((s) => (
          <div key={s.label} className="brail-set"><span>{s.label}</span><b>{s.value}</b></div>
        ))}
        {locked.length > 0 && (
          <p className="brail-locked"><I n="lock" />Not asked: {locked.map((s) => `${s.label} ${s.value}`).join(", ")}</p>
        )}
      </div>
      <div className="brail-card">
        <b className="brail-t">Before the first run</b>
        <ul className="brail-checks">
          {checks.map((c) => (
            <li key={c.text} className={cx(!c.ok && "bad")}><span className="ck"><I n={c.ok ? "check" : "alert"} /></span>{c.text}</li>
          ))}
        </ul>
      </div>
      {saveErr && <div className="errbox" role="alert"><b>Couldn't save</b><p>{saveErr}</p></div>}
      <button className="btn primary brail-run" type="button" disabled={saving || !!why} onClick={onRun} title={why || undefined}>
        {saving ? <Spinner size={15} /> : <I n="zap" />}Run
      </button>
      <p className={cx("brail-why", why && "bad")} role={tried && why ? "alert" : undefined}>
        {why ? `${why}.` : "Runs once with these samples. The result you like becomes its cover on Explore."}
      </p>
    </aside>
  );
}
