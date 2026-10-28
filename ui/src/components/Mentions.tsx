// Under a cloud prompt: each filled photo, clip or sound by its card's name. A click puts that name in the
// prompt at the cursor; the run sends the name the model reads for it.
import type { RefObject } from "react";
import type { Mention } from "../lib/fields";
import { I } from "./oi";

export function Mentions({ list, none, model, ta, value, onChange }: {
  list: Mention[]; none?: string | null; model: string; ta: RefObject<HTMLTextAreaElement | null>; value: string; onChange: (v: string) => void;
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
  return (
    <div className="mentions" role="group" aria-label="Name a file in the prompt">
      <span className="mn-l">Name in prompt</span>
      {list.map((m) => (
        <button key={m.key} className="mn" type="button" onClick={() => put(m.name)} title={`Put ${m.name} in the prompt. ${model} gets it as ${m.token}.`}>
          {m.thumb ? <img src={m.thumb} alt="" /> : <I n={m.kind === "video" ? "film" : m.kind === "audio" ? "sound" : "image"} />}
          <span>{m.name}</span>
        </button>
      ))}
    </div>
  );
}
