import * as RSwitch from "@radix-ui/react-switch";
import * as RSlider from "@radix-ui/react-slider";
import { forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { AlertTriangle, CheckCircle, Info, XCircle } from "./Icons";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

/** primary: the one action per view (yellow). secondary: default. ghost: toolbar/quiet. contrast: white. danger. */
type BtnTone = "primary" | "secondary" | "ghost" | "contrast" | "danger";
// Older names, kept so every call site reads the same.
type LegacyTone = "yellow" | "light" | "quiet";
const LEGACY: Record<LegacyTone, BtnTone> = { yellow: "primary", light: "contrast", quiet: "ghost" };

const TONES: Record<BtnTone, string> = {
  primary: "bg-yellow text-ink font-semibold shadow-run hover:bg-yellow-light disabled:bg-raised disabled:text-faint disabled:shadow-none",
  secondary: "bg-raised text-text shadow-line hover:bg-active disabled:text-faint",
  ghost: "bg-transparent text-muted hover:text-text hover:bg-white/[0.05] disabled:text-faint",
  contrast: "bg-text text-bg font-semibold hover:bg-white disabled:bg-raised disabled:text-faint",
  danger: "bg-transparent text-rose-text hover:bg-rose/10 disabled:text-faint",
};
const SIZES = { xs: "h-6 px-2 text-xs gap-1 rounded-md", sm: "h-7 px-2.5 text-sm gap-1.5 rounded-lg", md: "h-8 px-3 text-sm gap-1.5 rounded-lg", lg: "h-9 px-4 text-base gap-2 rounded-lg" };

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { tone?: BtnTone | LegacyTone; size?: keyof typeof SIZES }>(
  function Button({ tone = "secondary", size = "md", className, ...p }, ref) {
    const t = (LEGACY as Record<string, BtnTone>)[tone] ?? (tone as BtnTone);
    return (
      <button
        ref={ref}
        type="button"
        className={cx("mk-btn inline-flex items-center justify-center border-0 whitespace-nowrap font-medium select-none disabled:pointer-events-none", TONES[t], SIZES[size], className)}
        {...p}
      />
    );
  },
);

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; size?: number; tone?: "ghost" | "secondary" | "glass" | "raised" }>(
  function IconButton({ label, size = 28, tone = "ghost", className, style, ...p }, ref) {
    const tones = {
      ghost: "bg-transparent text-muted hover:text-text hover:bg-white/[0.06]",
      secondary: "bg-raised text-soft shadow-line hover:bg-active hover:text-text",
      raised: "bg-raised text-soft shadow-line hover:bg-active hover:text-text",
      glass: "glass text-text hover:bg-black/60",
    };
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        title={label}
        className={cx("mk-btn inline-flex items-center justify-center rounded-lg border-0 shrink-0 disabled:opacity-40 disabled:pointer-events-none", tones[tone], className)}
        style={{ width: size, height: size, ...style }}
        {...p}
      />
    );
  },
);

export function Card({ className, children, ...p }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx("bg-surface rounded-xl border border-line p-3 flex flex-col gap-3", className)} {...p}>
      {children}
    </div>
  );
}

export function CardHead({ title, right, id }: { title: ReactNode; right?: ReactNode; id?: string }) {
  return (
    <div className="flex items-center justify-between gap-2 min-h-[20px]">
      <h2 id={id} className="m-0 eyebrow">{title}</h2>
      {right && <span className="text-xs text-muted">{right}</span>}
    </div>
  );
}

/** A block inside a side panel: eyebrow header, hairline between blocks. */
export function Section({ title, meta, children, className, bodyClass, ...p }: Omit<HTMLAttributes<HTMLElement>, "title"> & { title?: ReactNode; meta?: ReactNode; bodyClass?: string }) {
  return (
    <section className={cx("px-4 py-3.5 border-b border-line last:border-b-0", className)} {...p}>
      {(title || meta) && (
        <div className="flex items-center justify-between gap-2 mb-2.5 min-h-[16px]">
          {title && <h2 className="m-0 eyebrow">{title}</h2>}
          {meta && <span className="text-xs text-muted truncate">{meta}</span>}
        </div>
      )}
      <div className={cx("flex flex-col gap-3", bodyClass)}>{children}</div>
    </section>
  );
}

export function Mono({ className, ...p }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("font-mono", className)} {...p} />;
}

type BadgeTone = "neutral" | "violet" | "yellow" | "mint" | "orange" | "rose" | "glass";
const BADGE: Record<BadgeTone, string> = {
  neutral: "bg-white/[0.06] text-soft",
  violet: "bg-violet/15 text-violet-light",
  yellow: "bg-yellow/[0.12] text-yellow-light",
  mint: "bg-mint/15 text-mint-text",
  orange: "bg-orange/15 text-orange-text",
  rose: "bg-rose/15 text-rose-text",
  glass: "glass text-text",
};
export function Badge({ tone = "neutral", dot, className, children, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: BadgeTone; dot?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1 h-[18px] px-1.5 rounded-md text-xs2 font-semibold tracking-[0.03em] whitespace-nowrap", BADGE[tone], className)} {...p}>
      {dot && <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: dot }} />}
      {children}
    </span>
  );
}

export function Pill({ className, ...p }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("inline-flex items-center gap-1.5 rounded-md px-2 h-6 text-xs", className)} {...p} />;
}

export function Glass({ className, ...p }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cx("glass inline-flex items-center rounded-md px-2 h-[22px] text-xs", className)} {...p} />;
}

export function Segmented<T extends string | number>({
  value, options, onChange, label, cols, className, render, size = "md",
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  label: string;
  cols?: number;
  className?: string;
  render?: (v: T) => ReactNode;
  size?: "sm" | "md";
}) {
  const n = cols ?? Math.min(options.length, 5);
  return (
    <div role="radiogroup" aria-label={label} className={cx("grid p-0.5 bg-bg border border-line rounded-lg gap-0.5", className)} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          role="radio"
          aria-checked={o === value}
          onClick={() => onChange(o)}
          title={String(o)}
          className={cx(
            "mk-btn border-0 rounded-md cursor-pointer truncate px-1.5",
            size === "sm" ? "h-6 text-xs" : "h-[26px] text-sm",
            o === value ? "bg-active text-text shadow-seg font-medium" : "bg-transparent text-muted hover:text-text",
          )}
        >
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, label, id, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; id?: string; disabled?: boolean }) {
  return (
    <RSwitch.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
      className={cx("relative w-[30px] h-[18px] rounded-full border-0 p-0 cursor-pointer shrink-0 transition-colors disabled:opacity-40", checked ? "bg-violet" : "bg-active2")}
    >
      <RSwitch.Thumb className="block w-3.5 h-3.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.35)] transition-transform translate-x-[2px] data-[state=checked]:translate-x-[14px]" />
    </RSwitch.Root>
  );
}

export function Slider({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  return (
    <RSlider.Root className="relative flex items-center h-4 select-none touch-none" value={[value]} min={min} max={max} step={step} onValueChange={(v) => onChange(v[0])} aria-label={label}>
      <RSlider.Track className="relative grow h-1 rounded-full bg-active2">
        <RSlider.Range className="absolute h-full rounded-full bg-violet" />
      </RSlider.Track>
      <RSlider.Thumb className="block w-3.5 h-3.5 rounded-full bg-text shadow-[0_1px_4px_rgba(0,0,0,0.5)] hover:scale-110 transition-transform focus-visible:outline-2 focus-visible:outline-violet" />
    </RSlider.Root>
  );
}

export function Field({ label, children, hint, htmlFor, aside, error }: { label: ReactNode; children: ReactNode; hint?: ReactNode; htmlFor?: string; aside?: ReactNode; error?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={htmlFor} className="text-sm text-soft font-medium">{label}</label>
        {aside && <span className="text-xs text-muted">{aside}</span>}
      </div>
      {children}
      {error ? <p className="m-0 text-xs text-rose-text">{error}</p> : hint ? <p className="m-0 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...p }, ref) {
  return <input ref={ref} className={cx("field h-8 px-2.5 text-sm min-w-0", className)} {...p} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...p }, ref) {
  return <textarea ref={ref} className={cx("field px-2.5 py-2 text-base leading-[1.5] min-w-0", className)} {...p} />;
});

const CHEVRON = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23A39CAC' stroke-width='2'%3E%3Cpath d='m7 10 5 5 5-5'/%3E%3C/svg%3E\")";
export function Select({ className, style, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx("field h-8 pl-2.5 pr-7 text-sm appearance-none bg-no-repeat bg-[right_8px_center] bg-[length:14px] cursor-pointer min-w-0", className)}
      style={{ backgroundImage: CHEVRON, ...style }}
      {...p}
    />
  );
}

export function Dot({ tone, pulse }: { tone: "ok" | "warn" | "bad" | "off" | "busy"; pulse?: boolean }) {
  const c = { ok: "#5FD39A", warn: "#FFA24C", bad: "#FF6B7E", off: "#6E6578", busy: "#FFA24C" }[tone];
  return (
    <span aria-hidden className="relative inline-flex w-2 h-2 shrink-0">
      {pulse && <span className="absolute inset-0 rounded-full animate-ping opacity-60" style={{ background: c }} />}
      <span className="relative w-2 h-2 rounded-full" style={{ background: c }} />
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx("inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 font-mono text-xs2 font-medium rounded-[5px] border opacity-60", className)} style={{ borderColor: "currentColor" }}>{children}</kbd>;
}

export function Empty({ title, children, action, icon, className }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center gap-2 py-14 px-6", className)}>
      {icon && <span className="w-10 h-10 mb-1 rounded-xl bg-surface border border-line flex items-center justify-center text-muted">{icon}</span>}
      <span className="text-md font-semibold">{title}</span>
      {children && <p className="m-0 max-w-[380px] text-sm text-muted">{children}</p>}
      {action && <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Spinner({ size = 14, className }: { size?: number; className?: string }) {
  return <span aria-hidden className={cx("inline-block rounded-full border-[1.5px] border-current border-t-transparent animate-spin shrink-0", className)} style={{ width: size, height: size }} />;
}

type NoticeTone = "info" | "warn" | "error" | "ok";
const NOTICE: Record<NoticeTone, { box: string; icon: string; Icon: typeof Info }> = {
  info: { box: "bg-violet/[0.07] border-violet/20", icon: "text-violet-light", Icon: Info },
  warn: { box: "bg-orange/[0.07] border-orange/25", icon: "text-orange", Icon: AlertTriangle },
  error: { box: "bg-rose/[0.07] border-rose/25", icon: "text-rose", Icon: XCircle },
  ok: { box: "bg-mint/[0.06] border-mint/20", icon: "text-mint", Icon: CheckCircle },
};

/** The one way to say something went wrong (or needs doing): icon, title, body, actions. */
export function Notice({ tone = "info", title, children, actions, className, role }: { tone?: NoticeTone; title?: ReactNode; children?: ReactNode; actions?: ReactNode; className?: string; role?: string }) {
  const k = NOTICE[tone];
  return (
    <div role={role ?? (tone === "error" ? "alert" : "status")} className={cx("flex gap-2.5 px-3 py-2.5 rounded-lg border text-sm", k.box, className)}>
      <k.Icon size={15} className={cx("shrink-0 mt-px", k.icon)} />
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        {title && <span className="font-semibold text-text leading-[17px]">{title}</span>}
        {children && <div className="text-soft leading-[17px] [&_code]:font-mono [&_code]:text-xs [&_code]:text-text">{children}</div>}
        {actions && <div className="flex flex-wrap gap-1.5 pt-0.5">{actions}</div>}
      </div>
    </div>
  );
}

export function Divider({ className }: { className?: string }) {
  return <span aria-hidden className={cx("block h-px bg-line", className)} />;
}

/** A row in a popover menu: a button, or a link when given href. */
export function MenuItem({ children, onClick, href: to, download, icon, danger }: { children: ReactNode; onClick?: () => void; href?: string; download?: string; icon?: ReactNode; danger?: boolean }) {
  const cls = cx("mk-btn h-8 px-2 rounded-md border-0 bg-transparent text-left text-sm inline-flex items-center gap-2 w-full", danger ? "text-rose-text hover:bg-rose/10" : "text-soft hover:bg-raised hover:text-text");
  const inner = <><span className="w-4 flex justify-center text-muted">{icon}</span>{children}</>;
  return to ? <a href={to} download={download} className={cls}>{inner}</a> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}
