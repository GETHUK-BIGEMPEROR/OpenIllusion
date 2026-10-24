import * as Popover from "@radix-ui/react-popover";
import { useRef, useState } from "react";
import { api } from "../lib/api";
import { errMsg, roleLabel } from "../lib/format";
import type { Asset, Mode } from "../lib/api";
import { EDIT_ROLES, ROLES } from "../lib/format";
import { newKey, useApp, type RefSlot } from "../lib/store";
import { Check, Chevron, Close, Plus } from "./Icons";
import { Spinner, cx } from "./ui";

/** Uploaded images appended to a tray: the first one in an empty tray gets the default role. */
export function withRefs(refs: RefSlot[], assets: Asset[], roles: readonly string[], defaultRole: string): RefSlot[] {
  return [
    ...refs,
    ...assets.map((a, i) => ({
      ...a, key: newKey(), role: refs.length === 0 && i === 0 ? defaultRole : roles.find((r) => r !== defaultRole) ?? defaultRole,
      license: "own-image", contains_person: false, consent: false,
    }) as RefSlot),
  ];
}

/** Add images to a studio's tray from outside it (a drop on the canvas or anywhere in the window). */
export function addToTray(mode: Mode, assets: Asset[]) {
  const st = useApp.getState();
  st.setStudio(mode, (s) => ({ refs: mode === "edit" ? withRefs(s.refs, assets, EDIT_ROLES, "base") : withRefs(s.refs, assets, ROLES, "character") }));
}

export function useUploader() {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(0);
  const upload = async (files: File[], kind?: "image" | "video") => {
    setBusy((n) => n + files.length);
    const out = [];
    for (const f of files) {
      try {
        const a = await api.upload(f);
        if (kind && a.kind !== kind) toast({ text: `${f.name} is a ${a.kind}, not a${kind === "image" ? "n image" : " video"}.`, tone: "warn" });
        else out.push(a);
      } catch (e) {
        toast({ text: `${f.name}: ${errMsg(e)}`, tone: "error" });
      } finally {
        setBusy((n) => n - 1);
      }
    }
    return out;
  };
  return { upload, busy };
}

export function RoleChip({ role, roles, onChange, selected }: { role: string; roles: readonly string[]; onChange: (r: string) => void; selected?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={`Role: ${roleLabel(role)}. Change role`} className={cx("mk-btn h-6 rounded-md border-0 text-xs font-medium w-full truncate pl-2 pr-1 inline-flex items-center justify-between gap-1", selected ? "bg-violet/15 text-violet-lighter" : "bg-raised text-soft hover:bg-active")}>
          <span className="truncate">{roleLabel(role)}</span><Chevron size={11} className="shrink-0 opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={6} className="z-50 rounded-lg bg-surface p-1 shadow-pop flex flex-col min-w-[140px] animate-pop">
          {roles.map((r) => (
            <button key={r} type="button" onClick={() => { onChange(r); setOpen(false); }} className={cx("mk-btn text-left h-7 px-2 rounded-md border-0 text-sm flex items-center justify-between gap-3", r === role ? "bg-active text-text" : "bg-transparent text-soft hover:bg-raised")}>
              {roleLabel(r)}{r === role && <Check size={12} className="text-violet-light" />}
            </button>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function RefTray({
  refs, max, roles, onChange, urlOnly, selectedKey, onSelect, defaultRole = "character", aspect = "3 / 4",
}: {
  refs: RefSlot[];
  max: number;
  roles: readonly string[];
  onChange: (refs: RefSlot[]) => void;
  urlOnly?: boolean;
  selectedKey?: string;
  onSelect?: (key: string) => void;
  defaultRole?: string;
  aspect?: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { upload, busy } = useUploader();
  const [over, setOver] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);

  const add = async (files: File[]) => {
    const room = Math.max(0, max - refs.length);
    const list = await upload(files.slice(0, room), "image");
    onChange(withRefs(refs, list, roles, defaultRole));
  };

  const patch = (key: string, p: Partial<RefSlot>) => onChange(refs.map((r) => (r.key === key ? { ...r, ...p } : r)));
  const reorder = (from: string, to: string) => {
    const a = refs.findIndex((r) => r.key === from);
    const b = refs.findIndex((r) => r.key === to);
    if (a < 0 || b < 0 || a === b) return;
    const next = refs.slice();
    const [x] = next.splice(a, 1);
    next.splice(b, 0, x);
    onChange(next);
  };

  return (
    <div
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        e.stopPropagation();
        setOver(false);
        add([...e.dataTransfer.files]);
      }}
      className={cx("rounded-lg transition-shadow", over && "shadow-[0_0_0_2px_#9A86F0]")}
    >
      <div className="grid grid-cols-3 gap-1.5">
        {refs.map((r, i) => (
          <div
            key={r.key}
            className="flex flex-col gap-1 min-w-0"
            draggable
            onDragStart={() => setDragKey(r.key)}
            onDragOver={(e) => { if (dragKey) e.preventDefault(); }}
            onDrop={(e) => { if (dragKey) { e.preventDefault(); e.stopPropagation(); reorder(dragKey, r.key); setDragKey(null); } }}
          >
            <div
              className={cx("group relative rounded-md overflow-hidden bg-raised", onSelect && "cursor-pointer")}
              style={{ aspectRatio: aspect, boxShadow: selectedKey === r.key ? "0 0 0 2px #9A86F0" : undefined }}
              onClick={() => onSelect?.(r.key)}
            >
              {r.url ? <img src={r.url} alt={`${roleLabel(r.role)} reference ${i + 1}`} className={cx("w-full h-full object-cover block", r.missing && "opacity-50 blur-[1px]")} /> : null}
              <span className="glass absolute left-1 top-1 min-w-[16px] h-4 flex items-center justify-center font-mono text-[10px] rounded px-1">{i + 1}</span>
              {r.missing && <span className="absolute inset-x-1 bottom-1 glass text-xs2 text-center rounded py-0.5 text-orange-text">Missing</span>}
              <button type="button" aria-label={`Remove reference ${i + 1}`} onClick={(e) => { e.stopPropagation(); onChange(refs.filter((x) => x.key !== r.key)); }} className="glass mk-btn absolute right-1 top-1 w-5 h-5 rounded border-0 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity">
                <Close size={8} />
              </button>
            </div>
            <RoleChip role={r.role} roles={roles} selected={i === 0} onChange={(role) => patch(r.key, { role })} />
            {urlOnly && (
              <input aria-label={`Public URL for image ${i + 1}`} placeholder="https://…" value={r.publicUrl ?? ""} onChange={(e) => patch(r.key, { publicUrl: e.target.value })}
                aria-invalid={!r.publicUrl} className="field h-6 px-2 text-xs2 font-mono min-w-0" />
            )}
          </div>
        ))}
        {refs.length < max && (
          <button
            type="button"
            aria-label="Add reference image"
            onClick={() => input.current?.click()}
            className="mk-btn rounded-md border border-dashed border-line2 bg-transparent text-muted hover:text-text hover:border-white/25 hover:bg-white/[0.02] flex flex-col items-center justify-center gap-1 text-xs"
            style={{ aspectRatio: aspect }}
          >
            {busy ? <Spinner size={14} /> : <Plus size={16} />}
            {busy ? "Uploading" : "Add"}
          </button>
        )}
      </div>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => { add([...(e.target.files ?? [])]); e.target.value = ""; }} />
    </div>
  );
}
