import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { settle, useConfirm } from "../lib/confirm";
import { appRoot, cx, I } from "./oi";

const HOLD_MS = 900;
// The newest in front, the next two tucked behind to the left and right.
const FAN = [0, -1, 1];

/** The one confirm dialog. Mounted once in App; opened with ``confirm()``. */
export function ConfirmHost() {
  const open = useConfirm((s) => s.open);
  const [option, setOption] = useState(false);
  useEffect(() => { setOption(!!open?.option?.on); }, [open]);
  // Leaving the page cancels: the dialog is about what was on screen.
  useEffect(() => {
    const cancel = () => settle({ ok: false, option: false });
    window.addEventListener("hashchange", cancel);
    return () => window.removeEventListener("hashchange", cancel);
  }, []);
  if (!open) return null;
  const v = open.view(option);
  const shown = (v.previews ?? []).slice(0, 3);
  const more = Math.max(0, (v.count ?? shown.length) - shown.length);
  const tone = open.tone ?? "danger";

  return (
    <Dialog.Root open onOpenChange={(o) => !o && settle({ ok: false, option })}>
      <Dialog.Portal container={appRoot()}>
        <Dialog.Overlay className="overlay cf-scrim" />
        <Dialog.Content className={cx("modal confirm", tone)} aria-describedby={v.body ? "cf-body" : undefined}
          onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(".cf-cancel")?.focus(); }}>
          {shown.length > 0 && <img className="cf-glow" src={shown[0]} alt="" aria-hidden />}
          {shown.length ? (
            <div className="cf-art" aria-hidden>
              <div className="cf-stack">
                {shown.map((src, i) => <img key={src + i} src={src} alt="" style={{ "--i": i, "--off": FAN[i] } as CSSProperties} />)}
              </div>
              {more > 0 && <span className="cf-more">+{more}</span>}
            </div>
          ) : (
            <div className="cf-ic" aria-hidden><I n={open.icon ?? "trash"} /></div>
          )}
          <Dialog.Title asChild><h2>{v.title}</h2></Dialog.Title>
          {v.body && <p id="cf-body" className="cf-body">{v.body}</p>}
          {!!v.facts?.length && <ul className="cf-facts">{v.facts.map((f) => <li key={f}>{f}</li>)}</ul>}
          {open.option && (
            <label className="cf-opt">
              <input type="checkbox" checked={option} onChange={(e) => setOption(e.target.checked)} />
              <span className="box"><I n="check" /></span>
              <span>{open.option.label(option)}</span>
            </label>
          )}
          <div className="cf-actions">
            <button className="btn cf-cancel" type="button" onClick={() => settle({ ok: false, option })}>Cancel</button>
            {open.hold
              ? <HoldButton label={v.action} disabled={v.empty} onDone={() => settle({ ok: true, option })} />
              : <button className={cx("btn", tone === "danger" ? "cf-go" : "primary")} type="button" disabled={v.empty} onClick={() => settle({ ok: true, option })}>{v.action}</button>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Confirms only after a press-and-hold (pointer, Enter or Space), so a stray click can't delete for good. */
function HoldButton({ label, disabled, onDone }: { label: string; disabled?: boolean; onDone: () => void }) {
  const [held, setHeld] = useState(false);
  const timer = useRef<number>();
  const start = () => {
    if (disabled || timer.current) return;
    setHeld(true);
    timer.current = window.setTimeout(onDone, HOLD_MS);
  };
  const stop = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setHeld(false);
  };
  useEffect(() => stop, []);
  return (
    <button className={cx("btn cf-go cf-hold", held && "held")} type="button" disabled={disabled} style={{ "--hold": `${HOLD_MS}ms` } as CSSProperties}
      aria-describedby="cf-hold-hint" onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} onPointerCancel={stop}
      onKeyDown={(e) => { if ((e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); start(); } }}
      onKeyUp={(e) => { if (e.key === "Enter" || e.key === " ") stop(); }}
      onClick={(e) => e.preventDefault()}>
      <span className="fill" aria-hidden />
      <span className="lbl">{held ? "Keep holding…" : label}</span>
      <span id="cf-hold-hint" className="sr">Press and hold to confirm</span>
    </button>
  );
}
