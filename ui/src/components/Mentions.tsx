// Under a cloud prompt: each filled photo, clip or sound by its card's name, and the name its model reads
// for it. A click puts the name in the prompt at the cursor; the run sends the model's form.
import type { RefObject } from "react";
import { sentAs, type Mention } from "../lib/fields";
import { I } from "./oi";

export function Mentions({ list, none, model, ta, value, onChange, preview }: {
  list: Mention[]; none?: string | null; model: string; ta: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (v: string) => void;
  /** Also show the whole prompt the way the model gets it. */
  preview?: boolean;
}) {
  if (!list.length) return none ? <p className="mn-none"><I n="info" />{none}</p> : null;
  const put = (token: string) => {
    const el = ta.current;
    const a = el?.selectionStart ?? value.length, b = el?.selectionEnd ?? value.length;
    const pre = value.slice(0, a), post = value.slice(b);
    const head = pre + (pre && !/\s$/.test(pre) ? " " : "") + token;
    onChange(head + (post && !/^[\s.,;:!?]/.test(post) ? " " : "") + post);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(head.length, head.length); });
  };
  const own = list.some((m) => m.token !== m.name);
  const parts = preview && own && value.trim() ? sentAs(value, list) : [];
  return (
    <div className="mn-wrap">
      <div className="mentions" role="group" aria-label="Name a file in the prompt">
        <span className="mn-l">Name in prompt</span>
        {list.map((m) => (
          <button key={m.key} className="mn" type="button" onClick={() => put(m.name)}
            title={m.token === m.name ? `Put ${m.name} in the prompt` : `Put ${m.name} in the prompt. ${model} gets it as ${m.token}.`}>
            {m.thumb ? <img src={m.thumb} alt="" /> : <I n={m.kind === "video" ? "film" : m.kind === "audio" ? "sound" : "image"} />}
            <span>{m.name}</span>
            {m.token !== m.name && <code className="mn-t"><I n="arrow" />{m.token}</code>}
          </button>
        ))}
      </div>
      {parts.length > 0 && (
        <div className="mn-sent">
          <span>{model} gets</span>
          <p>{parts.map((p, i) => (p.token ? <code key={i}>{p.text}</code> : <span key={i}>{p.text}</span>))}</p>
        </div>
      )}
    </div>
  );
}
