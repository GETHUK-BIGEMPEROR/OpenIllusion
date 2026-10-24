import { cx } from "./ui";

/** The OpenIllusion mark: an open ring with an offset pupil — a lens that looks back. */
export function Logo({ size = 28, className, mono = false }: { size?: number; className?: string; mono?: boolean }) {
  return (
    <svg role="img" aria-label="OpenIllusion" width={size} height={size} viewBox="0 0 24 24" className={cx("shrink-0 block", className)}>
      <rect width="24" height="24" rx="6.5" fill={mono ? "currentColor" : "#F2FF59"} />
      <path d="M17.6 9.2A6 6 0 1 1 14.8 6.7" fill="none" stroke="#211927" strokeWidth="2.3" strokeLinecap="round" />
      <circle cx="13.3" cy="10.7" r="2.35" fill="#211927" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <Logo size={22} />
      <span className="title text-[13.5px] tracking-[-0.01em]">Open<span className="text-muted">Illusion</span></span>
    </span>
  );
}
