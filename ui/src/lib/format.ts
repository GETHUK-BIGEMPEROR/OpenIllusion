import type { Estimate, Outcome } from "./api";

export const shortModel = (id: string) => id.split("/").pop() ?? id;

export function bytes(n?: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function clock(s: number, cents = true): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return cents ? `${m}:${r.toFixed(2).padStart(5, "0")}` : `${m}:${Math.floor(r).toString().padStart(2, "0")}`;
}

export function elapsed(s: number): string {
  s = Math.max(0, Math.floor(s));
  return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

export function day(ts: number): string {
  const d = new Date(ts * 1000);
  const now = new Date();
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function stamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function money(e?: Estimate | null, times = 1): { label: string; tone: "exact" | "estimated" | "unknown" | "invalid" | "local" } {
  if (!e) return { label: "Estimating…", tone: "unknown" };
  if (e.source === "local") return { label: "Your GPU", tone: "local" };
  const f = (v?: string) => (v ? `$${(parseFloat(v) * times).toFixed(parseFloat(v) * times < 1 ? 3 : 2)}` : "");
  if (e.source === "exact" && e.amount) return { label: f(e.amount), tone: "exact" };
  if (e.source === "estimated") return { label: `${f(e.min_amount)}–${f(e.max_amount)}`, tone: "estimated" };
  if (e.source === "invalid") return { label: "Request invalid", tone: "invalid" };
  return { label: "Cost unknown", tone: "unknown" };
}

export const OUTCOME: Record<Outcome, { word: string; glyph: string; color: string; soft: string; text: string }> = {
  worked: { word: "Worked", glyph: "✓", color: "#5FD39A", soft: "rgba(95,211,154,0.2)", text: "#DDF7E9" },
  partly: { word: "Partly", glyph: "–", color: "#FFA24C", soft: "rgba(255,162,76,0.2)", text: "#FFE3C7" },
  didnt: { word: "Didn't", glyph: "×", color: "#FF6B7E", soft: "rgba(255,107,126,0.2)", text: "#FFD6DC" },
};

export const ROLES = ["character", "outfit", "location", "style", "product"] as const;
export const EDIT_ROLES = ["base", "character", "outfit", "location", "style", "product"] as const;
export const roleLabel = (r: string) => (r === "base" ? "Base" : r.charAt(0).toUpperCase() + r.slice(1));

export const LICENSES: { id: string; label: string }[] = [
  { id: "own-footage", label: "own footage" },
  { id: "own-image", label: "own image" },
  { id: "generated", label: "generated" },
  { id: "cc0", label: "CC0" },
  { id: "cc-by", label: "CC BY" },
  { id: "licensed", label: "licensed" },
  { id: "unknown", label: "unknown" },
];

export const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const hm = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** "Just now", "12 min ago", "3 h ago", "Yesterday 21:40", "Fri 14:20", "Mar 3". */
export function ago(ts: number): string {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const d = new Date(ts * 1000);
  const g = dayGroup(ts);
  if (g === "Today") return `${Math.floor(s / 3600)} h ago`;
  if (g === "Yesterday") return `Yesterday ${hm(d)}`;
  if (g === "Earlier this week") return `${d.toLocaleDateString(undefined, { weekday: "short" })} ${hm(d)}`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The Library's day sections: Today, Yesterday, Earlier this week, then one per month. */
export function dayGroup(ts: number): string {
  const d = new Date(ts * 1000);
  const days = Math.floor((new Date(new Date().toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  return d.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}
