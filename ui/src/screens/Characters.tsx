// Character Lab: characters kept across runs. Each is a few photos and, made from them on the local ComfyUI, a RefMod
// (MiniMax H3's reference adapter) saved to the RefMod folder, where templates' RefMod inputs pick it (server/characters.py).
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { isImage, useFileDrop } from "../components/Drop";
import { cx, EmptyBox, I, PageHead } from "../components/oi";
import { useUploader } from "../components/Refs";
import { Spinner } from "../components/ui";
import { api, type Character } from "../lib/api";
import { coverUrl, refmodState } from "../lib/characters";
import { confirm } from "../lib/confirm";
import { ago, bytes, errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";
import { ACCEPT } from "./create/shared";

const MAX_PHOTOS = 16;
const busy = (c: Character) => !!c.making && c.making.state !== "failed";

/** The characters, refreshed every second while one's RefMod is being made. A RefMod made changes the RefMod folder and what can run. */
export function useCharacters() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["characters"],
    queryFn: api.characters,
    refetchInterval: (q) => (q.state.data?.some(busy) ? 1000 : false),
  });
  const made = (q.data ?? []).map((c) => `${c.id}:${c.refmod?.sha256 ?? ""}`).join("|");
  const prev = useRef(made);
  useEffect(() => {
    if (prev.current !== made) {
      qc.invalidateQueries({ queryKey: ["compose"] });
      qc.invalidateQueries({ queryKey: ["refmods"] });
    }
    prev.current = made;
  }, [made, qc]);
  return q;
}

export function Characters({ id }: { id?: string }) {
  const q = useCharacters();
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const list = q.data ?? [];
  const cur = list.find((c) => c.id === id) ?? (id ? undefined : list[0]);
  const [name, setName] = useState("");
  const [adding, setAdding] = useState(false);

  const create = async () => {
    if (!name.trim()) return;
    setAdding(true);
    try {
      const c = await api.createCharacter(name);
      qc.setQueryData<Character[]>(["characters"], (l) => [c, ...(l ?? [])]);
      setName("");
      go({ name: "characters", id: c.id });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setAdding(false);
    }
  };

  const newForm = (
    <form className="char-new" onSubmit={(ev) => { ev.preventDefault(); void create(); }}>
      <input className="input" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="New character's name" maxLength={60} aria-label="New character's name" />
      <button className="btn primary" type="submit" disabled={!name.trim() || adding}>{adding ? <Spinner size={12} /> : <I n="plus" />}<span className="lbl">Add</span></button>
    </form>
  );

  return (
    <div className="page">
      <div className="scroll">
        <PageHead title="Characters" count={q.data ? list.length : null} />
        {q.isLoading ? <div className="char-loading"><Spinner size={20} /></div>
          : q.isError ? <EmptyBox icon="alert" title="Couldn't read your characters" action={<button className="btn" type="button" onClick={() => q.refetch()}>Try again</button>}>{errMsg(q.error)}</EmptyBox>
          : !list.length ? (
            <EmptyBox icon="person" title="Keep a character for every run" action={newForm}>
              Give someone a name and a few photos. Their RefMod, made once on your ComfyUI, puts them into any template that takes a character.
            </EmptyBox>
          ) : (
            <div className="chars" data-open={id ? "" : undefined}>
              <nav className="char-list" aria-label="Your characters">
                {newForm}
                {list.map((c) => {
                  const st = refmodState(c);
                  const url = coverUrl(c);
                  return (
                    <a key={c.id} className="char-row" href={`#/characters/${c.id}`} aria-current={c.id === cur?.id ? "page" : undefined}>
                      {url ? <img src={url} alt="" loading="lazy" /> : <span className="char-row-ph"><I n="person" /></span>}
                      <span className="char-row-b"><b>{c.name}</b><small className={cx("char-st", st.tone)}><i className="dot" />{st.text}</small></span>
                    </a>
                  );
                })}
              </nav>
              {cur ? <CharacterDetail key={cur.id} c={cur} /> : <EmptyBox icon="person" title="That character is gone" action={<a className="btn" href="#/characters">See all</a>} />}
            </div>
          )}
      </div>
    </div>
  );
}

function CharacterDetail({ c }: { c: Character }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const { upload, busy: uploading } = useUploader();
  const [adding, setAdding] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(c.name);
  const [notes, setNotes] = useState(c.notes);
  useEffect(() => setName(c.name), [c.name]);
  const st = refmodState(c);
  const making = busy(c);
  const full = c.photos.length >= MAX_PHOTOS;

  const put = (next: Character) => qc.setQueryData<Character[]>(["characters"], (l) => (l ?? []).map((x) => (x.id === next.id ? next : x)));
  const act = async (fn: () => Promise<Character>) => {
    try {
      put(await fn());
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const addFiles = async (files: File[]) => {
    const room = MAX_PHOTOS - c.photos.length;
    const pics = files.filter(isImage);
    if (!pics.length) return void toast({ text: "Characters take photos.", tone: "warn" });
    if (pics.length > room) toast({ text: `A character takes up to ${MAX_PHOTOS} photos; ${room ? `added the first ${room}` : "remove one first"}.`, tone: "warn" });
    setAdding((n) => n + Math.min(room, pics.length));
    try {
      for (const a of await upload(pics.slice(0, room), "image")) await act(() => api.addCharacterPhoto(c.id, a.asset));
    } finally {
      setAdding(0);
    }
  };
  const drop = useFileDrop((f) => void addFiles(f), { accept: isImage, disabled: full });
  const saveName = () => { if (name.trim() && name.trim() !== c.name) void act(() => api.patchCharacter(c.id, { name })); else setName(c.name); };
  const saveNotes = () => { if (notes !== c.notes) void act(() => api.patchCharacter(c.id, { notes })); };
  const remove = async () => {
    const r = await confirm({
      tone: "danger", icon: "trash",
      view: () => ({ title: `Delete ${c.name}?`, body: "Their photos go for good. Their RefMod stays in your RefMod folder, so templates can still use it.", previews: coverUrl(c) ? [coverUrl(c)!] : undefined, action: "Delete character" }),
    });
    if (!r.ok) return;
    try {
      await api.deleteCharacter(c.id);
      qc.setQueryData<Character[]>(["characters"], (l) => (l ?? []).filter((x) => x.id !== c.id));
      go({ name: "characters" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };

  return (
    <article className="char" aria-label={c.name}>
      <a className="btn ghost sm char-back" href="#/characters"><I n="back" />All characters</a>
      <header className="char-head">
        <div className="char-face">{coverUrl(c) ? <img src={coverUrl(c)!} alt={`${c.name}'s face`} /> : <I n="person" />}</div>
        <div className="char-id">
          <input className="char-name" value={name} onChange={(ev) => setName(ev.target.value)} onBlur={saveName}
            onKeyDown={(ev) => { if (ev.key === "Enter") (ev.target as HTMLInputElement).blur(); if (ev.key === "Escape") { setName(c.name); (ev.target as HTMLInputElement).blur(); } }}
            maxLength={60} aria-label="Name" />
          <textarea className="textarea char-notes" value={notes} onChange={(ev) => setNotes(ev.target.value)} onBlur={saveNotes} rows={2} maxLength={1000}
            placeholder="Notes: who they are, what they wear" aria-label="Notes" />

          <section className={cx("refmod", st.tone)} aria-labelledby="rm-h">
            <div className="refmod-h">
              <h4 id="rm-h">RefMod</h4>
              <span className={cx("char-st", st.tone)}>{making ? <Spinner size={11} /> : <i className="dot" />}{st.text}</span>
            </div>
            {c.making?.state === "failed" ? <p className="refmod-why">{c.making.detail}</p>
              : making ? <p>{c.making!.detail}…</p>
              : c.refmod ? (
                <p className="mono refmod-facts">
                  {c.refmod.photos.length} photo{c.refmod.photos.length === 1 ? "" : "s"}{c.refmod.tokens ? ` · ${c.refmod.tokens.toLocaleString()} tokens` : ""} · {bytes(c.refmod.bytes)} · made {ago(c.refmod.made).toLowerCase()}
                </p>
              ) : <p>Encodes the photos once with MiniMax H3's video VAE on your ComfyUI. A few seconds; no model download beyond the VAE.</p>}
            {c.refmod_stale && !making && <p className="refmod-why warn">Made from {c.refmod!.photos.length} photo{c.refmod!.photos.length === 1 ? "" : "s"}; it still runs, but remake it to use the photos as they are now.</p>}
            <div className="refmod-acts">
              <button className={cx("btn", (!c.refmod || c.refmod_stale || c.making?.state === "failed") && "primary")} type="button"
                disabled={making || !c.photos.length} onClick={() => void act(() => api.makeRefmod(c.id))}
                title={c.photos.length ? undefined : "Add a photo first"}>
                {making ? <Spinner size={12} /> : <I n={c.refmod ? "refresh" : "zap"} />}{c.refmod || c.making?.state === "failed" ? "Make again" : "Make RefMod"}
              </button>
            </div>
            {c.refmod && !making && <p className="refmod-why">Pick {c.name} in any template's RefMod input.</p>}
          </section>
        </div>
      </header>

      <section className="char-photos" aria-labelledby="ph-h">
        <div className="sec-h"><h4 id="ph-h">Photos</h4><span className="mono">{c.photos.length} / {MAX_PHOTOS}</span></div>
        <p className="char-hint">Clear, well-lit shots of one person: the face close, then head to toe. The star marks their face: it shows wherever their RefMod is picked.</p>
        <div className={cx("char-grid", drop.over && "drop")} {...drop.props} data-drop="Drop to add">
          {c.photos.map((p) => (
            <figure key={p} className={cx("char-ph", p === c.cover && "cover")}>
              <img src={c.photo_urls[p]} alt="" loading="lazy" />
              <figcaption>
                <button className="icon-btn sm" type="button" aria-pressed={p === c.cover} aria-label={p === c.cover ? "The face" : "Use as the face"} title={p === c.cover ? "The face" : "Use as the face"}
                  onClick={() => p !== c.cover && void act(() => api.patchCharacter(c.id, { cover: p }))}><I n="star" /></button>
                <button className="icon-btn sm" type="button" aria-label="Remove photo" title="Remove" disabled={making}
                  onClick={() => void act(() => api.removeCharacterPhoto(c.id, p))}><I n="x" /></button>
              </figcaption>
            </figure>
          ))}
          {Array.from({ length: adding }, (_, i) => <div key={`up-${i}`} className="char-ph pending"><Spinner size={16} /></div>)}
          {!full && (
            <button className="char-ph add" type="button" onClick={() => input.current?.click()} disabled={uploading > 0}>
              <I n="plus" /><span>{c.photos.length ? "Add photos" : "Drop photos or click"}</span>
            </button>
          )}
        </div>
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(ev) => { void addFiles([...(ev.target.files ?? [])]); ev.target.value = ""; }} />
      </section>

      <footer className="char-foot">
        <button className="btn ghost danger" type="button" onClick={() => void remove()} disabled={making}><I n="trash" />Delete character</button>
      </footer>
    </article>
  );
}
