import { useRef, useState } from "react";
import type { EngineInfo } from "../lib/api";
import { go } from "../lib/route";
import { slotOf, useApp, type RefSlot } from "../lib/store";
import { Brush, Close, ImageIcon, Landscape, Motion, Package, Person, Refresh, Shirt } from "./Icons";
import { bySlot, useUploader, withRefs } from "./Refs";
import { Spinner, cx } from "./ui";

const ACCEPT = "image/png,image/jpeg,image/webp";

const iconFor = (label = "") =>
  /person|people|face|portrait/i.test(label) ? Person
    : /garment|outfit|cloth|shirt|wear/i.test(label) ? Shirt
    : /product|object|item/i.test(label) ? Package
    : /scene|landscape|place|background/i.test(label) ? Landscape
    : ImageIcon;

const withArticle = (label: string) => `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label.toLowerCase()}`;

/** The template at the top of the inputs: its cover, its name, and a way back to the wall to pick another. */
export function TemplateHeader({ e }: { e: EngineInfo }) {
  const [name, model] = e.label.split(" · ");
  const ModeIcon = e.mode === "motion" ? Motion : Brush;
  const openTemplate = useApp((s) => s.openTemplate);
  return (
    <div className="relative h-[132px] rounded-xl overflow-hidden bg-surface ring-1 ring-inset ring-white/[0.06]">
      {e.cover_video ? (
        <video src={e.cover_video} poster={e.cover ?? undefined} muted loop playsInline autoPlay aria-hidden className="absolute inset-0 w-full h-full object-cover object-[center_22%]" />
      ) : e.cover ? (
        <img src={e.cover} alt="" className="absolute inset-0 w-full h-full object-cover object-[center_22%]" />
      ) : (
        <span aria-hidden className="absolute inset-0 bg-[radial-gradient(120%_90%_at_100%_0%,rgba(242,255,89,0.18),transparent_60%),linear-gradient(160deg,#30233a,#1c1622)]" />
      )}
      <span aria-hidden className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/35 to-black/10" />
      <div className="absolute right-2 top-2 flex gap-1">
        <button type="button" onClick={() => openTemplate(e.mode, e.id)} title="Back to the template's samples and default prompt"
          className="mk-btn glass h-7 px-2.5 rounded-lg border-0 text-xs font-semibold text-white inline-flex items-center gap-1.5 hover:bg-black/60">
          <Refresh size={12} />Reset
        </button>
        <button type="button" onClick={() => go({ name: "library", shelf: "templates", t: e.id })}
          className="mk-btn glass h-7 px-2.5 rounded-lg border-0 text-xs font-semibold text-white inline-flex items-center gap-1.5 hover:bg-black/60">
          <ModeIcon size={12} />Change
        </button>
      </div>
      <div className="absolute inset-x-3 bottom-2.5 flex flex-col gap-0.5 min-w-0">
        <h2 className="m-0 font-display text-lg leading-[1.15] font-bold uppercase tracking-[0.01em] text-yellow truncate" title={e.label}>{name}</h2>
        <p className="m-0 text-xs text-white/75 truncate">{[model ?? e.provider, e.kind === "local" ? "Local · your GPU" : "Cloud"].join(" · ")}</p>
      </div>
    </div>
  );
}

/** One dropzone per input the template names. Slots can be filled in any order. */
export function TemplateSlots({ e, refs, onChange, roles, defaultRole }: {
  e: EngineInfo; refs: RefSlot[]; onChange: (refs: RefSlot[]) => void; roles: readonly string[]; defaultRole: string;
}) {
  const { upload } = useUploader();
  const [busy, setBusy] = useState<number | null>(null);
  const at = (n: number) => refs.find((r, i) => slotOf(r, i) === n);

  const fill = async (n: number, files: File[]) => {
    const f = files.find((x) => /^image\//.test(x.type)) ?? files[0];
    if (!f) return;
    setBusy(n);
    try {
      const [asset] = await upload([f], "image");
      if (!asset) return;
      const rest = bySlot(refs).filter((r) => r.slot !== n);
      const [added] = withRefs([], [asset], roles, defaultRole);
      onChange(bySlot([...rest, { ...added, slot: n, role: n === 1 ? defaultRole : roles.find((r) => r !== defaultRole) ?? defaultRole }]));
    } finally {
      setBusy(null);
    }
  };
  const clear = (n: number) => onChange(bySlot(refs).filter((r) => r.slot !== n));

  return (
    <div className="flex flex-col gap-2">
      {(e.inputs ?? []).map((input, i) => (
        <SlotCard key={input.slot} n={i + 1} label={input.label ?? `Image ${i + 1}`} hint={input.hint} r={at(i + 1)}
          busy={busy === i + 1} numbered={(e.inputs?.length ?? 0) > 1 || e.max_images > 1}
          onFiles={(files) => fill(i + 1, files)} onClear={() => clear(i + 1)} />
      ))}
    </div>
  );
}

function SlotCard({ n, label, hint, r, busy, numbered, onFiles, onClear }: {
  n: number; label: string; hint?: string; r?: RefSlot; busy: boolean; numbered: boolean; onFiles: (f: File[]) => void; onClear: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const Icon = iconFor(label);
  const pick = () => input.current?.click();
  const drop = {
    onDragOver: (ev: React.DragEvent) => { if (ev.dataTransfer.types.includes("Files")) { ev.preventDefault(); ev.stopPropagation(); setOver(true); } },
    onDragLeave: (ev: React.DragEvent) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node | null)) setOver(false); },
    onDrop: (ev: React.DragEvent) => { if (!ev.dataTransfer.files.length) return; ev.preventDefault(); ev.stopPropagation(); setOver(false); onFiles([...ev.dataTransfer.files]); },
  };
  const tag = numbered && (
    <span className="glass absolute left-2 top-2 h-5 px-1.5 rounded-md text-xs2 font-mono leading-5 text-white/90">Image {n}</span>
  );

  return (
    <div data-own-drop {...drop} className="relative">
      <input ref={input} type="file" accept={ACCEPT} hidden onChange={(ev) => { onFiles([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
      {r?.url ? (
        <div className={cx("group relative h-[176px] rounded-xl overflow-hidden bg-deep ring-1 ring-inset transition-shadow", over ? "ring-2 ring-violet" : "ring-white/[0.08]")}>
          <img src={r.url} alt={`${label}: ${r.name ?? "uploaded image"}`} className={cx("absolute inset-0 w-full h-full object-cover", r.missing && "opacity-50 blur-[1px]")} />
          <span aria-hidden className="absolute inset-x-0 top-0 h-14 bg-gradient-to-b from-black/50 to-transparent" />
          <span className="glass absolute left-2 top-2 h-6 px-2 rounded-md text-xs font-semibold leading-6 text-white">
            {numbered && <span className="font-mono font-normal text-white/70">Image {n} · </span>}{label}
          </span>
          {r.sample && !r.missing && !busy && (
            <span className="glass absolute inset-x-2 bottom-2 rounded-md px-2 py-1 text-xs leading-[1.4] text-white/90 flex items-center gap-1.5">
              <span className="shrink-0 h-4 px-1.5 rounded bg-yellow text-ink text-[10px] font-bold uppercase tracking-[0.04em] leading-4">Sample</span>
              <span className="truncate">Swap in your own photo</span>
            </span>
          )}
          <div className="absolute right-2 top-2 flex gap-1">
            <button type="button" onClick={pick} aria-label={`Replace ${label.toLowerCase()}`} title="Replace"
              className="mk-btn glass w-7 h-7 rounded-lg border-0 text-white flex items-center justify-center hover:bg-black/60"><Refresh size={13} /></button>
            <button type="button" onClick={onClear} aria-label={`Remove ${label.toLowerCase()}`} title="Remove"
              className="mk-btn glass w-7 h-7 rounded-lg border-0 text-white flex items-center justify-center hover:bg-black/60"><Close size={10} /></button>
          </div>
          {r.missing && <span className="absolute inset-x-2 bottom-2 glass text-xs text-center rounded-md py-1 text-orange-text">File missing. Replace it.</span>}
          {busy && <span className="absolute inset-0 bg-black/45 flex items-center justify-center"><Spinner size={18} /></span>}
        </div>
      ) : (
        <button type="button" onClick={pick} aria-label={`Add ${withArticle(label)}${hint ? `. ${hint}` : ""}`}
          className={cx("mk-btn relative w-full min-h-[148px] px-4 py-5 rounded-xl border border-dashed flex flex-col items-center justify-center gap-2 text-center transition-colors",
            over ? "border-violet bg-violet/[0.08]" : "border-line2 bg-white/[0.015] hover:border-white/25 hover:bg-white/[0.035]")}>
          {tag}
          <span className="w-10 h-10 rounded-full bg-raised ring-1 ring-white/[0.08] flex items-center justify-center text-soft">
            {busy ? <Spinner size={16} /> : <Icon size={18} />}
          </span>
          <span className="text-sm font-semibold text-text">Add {withArticle(label)}</span>
          {hint && <span className="text-xs text-muted leading-[1.45] max-w-[230px]">{hint}</span>}
          <span className="text-xs2 text-faint">Click or drop · PNG, JPEG, WebP</span>
        </button>
      )}
    </div>
  );
}
