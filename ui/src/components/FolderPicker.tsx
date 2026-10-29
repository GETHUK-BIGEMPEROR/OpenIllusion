// A folder picker that works the same on Windows, macOS, Linux and in Docker. A browser can't hand a page a
// folder's path, so the server lists its folders (server/folders.py) and this walks them.
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, type FolderListing } from "../lib/api";
import { errMsg } from "../lib/format";
import { cx, I } from "./oi";
import { IconButton, Spinner } from "./ui";

/** Each step of a path, with the path up to it: C:\ › Users › you, or / › home › you. */
function crumbs(path: string, sep: string) {
  const win = sep === "\\";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const head = win ? `${parts.shift() ?? ""}\\` : "/";
  const out = [{ label: win ? head.slice(0, -1) : "/", path: head }];
  let at = head;
  for (const p of parts) {
    at = at.endsWith(sep) ? at + p : at + sep + p;
    out.push({ label: p, path: at });
  }
  return out;
}

export function FolderPicker({ open, start, title = "Choose a folder", onPick, onClose }: {
  open: boolean; start?: string; title?: string; onPick: (path: string) => void; onClose: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-bg" />
        <Dialog.Content className="dlg fpick" aria-describedby={undefined}>
          {open && <Picker start={start} title={title} onPick={onPick} onClose={onClose} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Picker({ start, title, onPick, onClose }: { start?: string; title: string; onPick: (path: string) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const [at, setAt] = useState<string | undefined>(start || undefined);
  const q = useQuery({ queryKey: ["folders", at ?? ""], queryFn: () => api.folders(at), placeholderData: (prev) => prev, staleTime: 5000 });
  const d = q.data;
  const [typing, setTyping] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => { list.current?.scrollTo({ top: 0 }); setErr(null); }, [d?.path]);
  const go = (p: string) => { setTyping(null); setNaming(null); setAt(p); };
  const make = async () => {
    if (!d || !naming?.trim()) return;
    try {
      const r = await api.makeFolder(d.path, naming);
      qc.setQueryData<FolderListing>(["folders", d.path], r);
      setNaming(null);
      if (r.made) go(r.made);
    } catch (x) {
      setErr(errMsg(x));
    }
  };
  const here = d?.path ?? "";
  return (
    <>
      <div className="dlg-h">
        <div><Dialog.Title>{title}</Dialog.Title></div>
        <Dialog.Close asChild><IconButton label="Close"><I n="x" size={11} /></IconButton></Dialog.Close>
      </div>
      <div className="fp-body">
        <nav className="fp-side" aria-label="Places">
          {d?.places.map((p) => (
            <button key={p.path + p.label} type="button" className={cx(here === p.path && "on")} onClick={() => go(p.path)} title={p.path}>
              <I n={p.label === "Home" ? "home" : p.label === "Output folder" ? "library" : "folder"} />{p.label}
            </button>
          ))}
          {d && d.roots.length > 0 && <div className="fp-sep" />}
          {d?.roots.map((r) => (
            <button key={r} type="button" className={cx(here === r && "on")} onClick={() => go(r)}><I n="drive" />{r.replace(/\\$/, "") || r}</button>
          ))}
        </nav>
        <div className="fp-main">
          <div className="fp-bar">
            <IconButton label="Up one folder" disabled={!d?.parent} onClick={() => d?.parent && go(d.parent)}><I n="back" size={13} style={{ rotate: "90deg" }} /></IconButton>
            {typing === null ? (
              <div className="fp-crumbs" onDoubleClick={() => setTyping(here)} title="Double-click to type a path">
                {d && crumbs(d.path, d.sep).map((c, i, all) => (
                  <span key={c.path}>
                    <button type="button" className={cx(i === all.length - 1 && "cur")} onClick={() => go(c.path)}>{c.label}</button>
                    {i < all.length - 1 && <I n="right" size={10} />}
                  </span>
                ))}
              </div>
            ) : (
              <form className="fp-type" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); if (typing.trim()) go(typing.trim()); }}>
                <input className="input mono" autoFocus value={typing} spellCheck={false} aria-label="Folder path"
                  onChange={(e) => setTyping(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setTyping(null); } }} />
              </form>
            )}
            <IconButton label="Type a path" onClick={() => setTyping(typing === null ? here : null)}><I n="pencil" size={13} /></IconButton>
          </div>
          <div className="fp-list" ref={list} role="list" aria-busy={q.isFetching || undefined}>
            {naming !== null && (
              <form className="fp-row new" role="listitem" onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void make(); }}>
                <I n="folder" />
                <input className="input" autoFocus value={naming} placeholder="New folder name" aria-label="New folder name"
                  onChange={(e) => { setNaming(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); setNaming(null); } }} />
                <button className="btn sm" type="submit" disabled={!naming.trim()}>Make</button>
              </form>
            )}
            {q.isError && !d ? <p className="fp-empty">{errMsg(q.error)}</p>
              : !d ? <div className="fp-empty"><Spinner /></div>
              : d.denied ? <p className="fp-empty"><I n="lock" />This folder can't be opened.</p>
              : !d.dirs.length && naming === null ? <p className="fp-empty">No folders in here. Use this one, or make a new folder.</p>
              : d.dirs.map((x) => (
                <button key={x.path} type="button" role="listitem" className="fp-row" onClick={() => go(x.path)}>
                  <I n="folder" /><span>{x.name}</span><I n="right" size={11} className="fp-go" />
                </button>
              ))}
          </div>
          {(err || d?.missing || (q.isError && d)) && (
            <p className="fp-note" role="alert">{err ?? (q.isError ? errMsg(q.error) : "That folder isn't there, so this is the nearest one that is.")}</p>
          )}
        </div>
      </div>
      <div className="dlg-f">
        <button className="btn" type="button" disabled={!d || d.denied || naming !== null} onClick={() => setNaming("")}><I n="plus" />New folder</button>
        <span className="note mono" title={here}>{d && !d.writable ? "Can't write here. Pick another folder." : here}</span>
        <button className="btn ghost" type="button" onClick={onClose}>Cancel</button>
        <button className="btn primary" type="button" disabled={!d || !d.writable} onClick={() => d && onPick(d.path)}>Use this folder</button>
      </div>
    </>
  );
}
