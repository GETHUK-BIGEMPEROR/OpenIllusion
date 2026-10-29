import * as RSlider from "@radix-ui/react-slider";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { I } from "./oi";
import type { IconName } from "./sprite";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// React faces of the shared classes in styles/common.css and styles/fields.css.

/** primary: the one action per view (neon gradient). secondary: default. ghost: toolbar/quiet. contrast: white. danger. */
type BtnTone = "primary" | "secondary" | "ghost" | "contrast" | "danger";
const SIZES = { xs: "xs", sm: "sm", md: "", lg: "" };

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone; size?: keyof typeof SIZES }>(
  function Button({ tone = "secondary", size = "md", className, ...p }, ref) {
    return <button ref={ref} type="button" className={cx("btn", tone !== "secondary" && tone, SIZES[size], className)} {...p} />;
  },
);

/** A square icon button; 28 px unless `size` says otherwise. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: number; tone?: "ghost" | "raised" | "glass" }>(
  function IconButton({ label, size = 28, tone = "ghost", className, style, ...p }, ref) {
    return (
      <button ref={ref} type="button" aria-label={label} title={label} className={cx("icon-btn sm", tone !== "ghost" && tone, className)}
        style={size !== 28 ? { width: size, height: size, ...style } : style} {...p} />
    );
  },
);

type BadgeTone = "neutral" | "violet" | "mint" | "orange" | "rose" | "glass";
export function Badge({ tone = "neutral", className, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone }) {
  return <span className={cx("pill", tone === "neutral" ? "soft" : tone !== "glass" && tone, className)} {...p} />;
}

/** Equal-width choices in one row (the `.seg` look, as a grid). */
export function Segmented<T extends string | number>({ value, options, onChange, label, cols, render }: {
  value: T; options: readonly T[]; onChange: (v: T) => void; label: string; cols?: number; render?: (v: T) => ReactNode;
}) {
  const n = cols ?? Math.min(options.length, 5);
  return (
    <div role="radiogroup" aria-label={label} className="seg cols" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button key={String(o)} type="button" role="radio" aria-checked={o === value} onClick={() => onChange(o)} title={String(o)}>
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string; disabled?: boolean }) {
  return <button id={id} type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)} />;
}

export function Slider({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  return (
    <RSlider.Root className="slider" value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} aria-label={label}>
      <RSlider.Track className="slider-track"><RSlider.Range className="slider-range" /></RSlider.Track>
      <RSlider.Thumb className="slider-thumb" />
    </RSlider.Root>
  );
}

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...p }, ref) {
  return <input ref={ref} className={cx("input sm", className)} {...p} />;
});

export function Select({ className, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cx("select", className)} {...p} />;
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <span aria-hidden className={cx("spin", className)} style={{ width: size, height: size }} />;
}

type NoticeTone = "info" | "warn" | "error" | "ok";
const NOTICE: Record<NoticeTone, IconName> = { info: "info", warn: "alert", error: "fail", ok: "ok" };

/** The one way to say something went wrong (or needs doing): icon, title, body, actions. */
export function Notice({ tone = "info", title, children, actions, className, role }: { tone?: NoticeTone; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string; role?: string }) {
  return (
    <div role={role ?? (tone === "error" ? "alert" : "status")} className={cx("notice", tone, className)}>
      <I n={NOTICE[tone]} size={15} />
      <div className="notice-b">
        {title && <b>{title}</b>}
        {children && <div className="notice-c">{children}</div>}
        {actions && <div className="notice-a">{actions}</div>}
      </div>
    </div>
  );
}
