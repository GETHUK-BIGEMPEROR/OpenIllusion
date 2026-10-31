import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Masonry } from "../components/Masonry";
import { cx, EmptyBox, I, Media, PageHead } from "../components/oi";
import { Spinner } from "../components/ui";
import { api, trashFileUrl, type TrashItem } from "../lib/api";
import { confirm } from "../lib/confirm";
import { ago, bytes, dayGroup, errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";
import { gens, refreshLibrary, Skeleton } from "./Library";

const poster = (t: TrashItem) => (t.poster ? trashFileUrl(t.id, t.poster) : null);
// Wide clips are cropped to stay tall enough for the prompt and Restore.
const aspect = (t: TrashItem) => (t.width && t.height ? Math.min(t.width / t.height, 1.25) : 4 / 5);
const daysLeft = (t: TrashItem) => Math.max(0, Math.ceil((t.purge_at - Date.now() / 1000) / 86400));

/** Deleted generations: each waits 7 days, then goes for good. Restore or delete them here, one at a time or picked. */
export function Trash() {
  const q = useQuery({ queryKey: ["trash"], queryFn: api.trash });
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const items = q.data ?? [];
  const size = items.reduce((a, t) => a + t.bytes, 0);
  // Grouped by the day they were deleted, newest first, like the library.
  const groups = useMemo(() => {
    const m = new Map<string, TrashItem[]>();
    for (const t of [...items].sort((a, b) => b.deleted - a.deleted)) {
      const g = dayGroup(t.deleted);
      m.set(g, [...(m.get(g) ?? []), t]);
    }
    return [...m];
  }, [items]);
  const pick = (id: string) => setPicked((s) => {
    const n = new Set(s);
    if (!n.delete(id)) n.add(id);
    return n;
  });
  const stopPicking = () => { setPicked(new Set()); setPicking(false); };

  return (
    <div className="page library">
      <div className="scroll">
        <PageHead title="Trash"
          filters={items.length ? <span className="trash-sum"><b className="mono">{items.length}</b> in the trash · {bytes(size)} · each goes for good 7 days after it was deleted</span> : undefined}
          actions={items.length ? (
            <>
              {!picking && <TrashActions items={items} />}
              <button className={cx("btn", picking && "primary")} type="button" onClick={() => (picking ? stopPicking() : setPicking(true))}>
                <I n="select" /><span className="lbl">{picking ? "Done" : "Select"}</span>
              </button>
            </>
          ) : undefined} />
        <div className="wall-wrap lib">
          {q.isLoading ? <Skeleton />
            : q.isError ? <EmptyBox icon="alert" title="Couldn't read the trash" action={<button className="btn" type="button" onClick={() => q.refetch()}>Try again</button>}>{errMsg(q.error)}</EmptyBox>
            : !items.length ? (
              <EmptyBox icon="trash" title="Trash is empty" action={<a className="btn" href="#/library">Open library</a>}>
                Deleted generations wait here for 7 days, then go for good.
              </EmptyBox>
            )
            : groups.map(([g, v]) => (
              <section key={g} className="lgroup" aria-label={g}>
                <div className="ghead"><h3>Deleted {/^(Today|Yesterday|Earlier)/.test(g) ? g.toLowerCase() : `in ${g}`}</h3><span>{v.length}</span></div>
                <Masonry label={g} maxCols={6} minCol={180} items={v.map((t) => ({ key: t.id, aspect: aspect(t), t }))}
                  render={({ t }) => <TrashCard t={t} picking={picking} picked={picked.has(t.id)} onPick={() => pick(t.id)} />} />
              </section>
            ))}
        </div>
      </div>
      {picking && picked.size > 0 && <Bulk items={items.filter((t) => picked.has(t.id))} done={stopPicking} />}
    </div>
  );
}

function TrashActions({ items }: { items: TrashItem[] }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const restoreAll = async () => {
    try {
      const r = await api.restoreMany(items.map((t) => t.id));
      refreshLibrary(qc);
      toast({ text: `${gens(r.restored.length)} restored.`, tone: "ok", action: { label: "Open library", run: () => go({ name: "library" }) } });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const empty = async () => {
    const res = await confirm({
      hold: true,
      view: () => ({
        title: "Empty the trash?", count: items.length,
        previews: items.map(poster).filter((p): p is string => !!p),
        body: `${gens(items.length)} ${items.length === 1 ? "is" : "are"} deleted for good. This can't be undone.`,
        facts: [`${bytes(items.reduce((a, t) => a + t.bytes, 0))} freed`, "Full-size files in your output folder stay"],
        action: "Hold to empty",
      }),
    });
    if (!res.ok) return;
    try {
      const r = await api.emptyTrash();
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["storage"] });
      toast({ text: `Trash emptied. ${gens(r.removed)} deleted for good.`, tone: "ok" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  return (
    <>
      <button className="btn" type="button" onClick={restoreAll}><I n="undo" /><span className="lbl">Restore all</span></button>
      <button className="btn danger" type="button" onClick={empty}><I n="trash" /><span className="lbl">Empty trash</span></button>
    </>
  );
}

/** Restore or delete for good everything picked. */
function Bulk({ items, done }: { items: TrashItem[]; done: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const ids = items.map((t) => t.id);
  const restore = async () => {
    setBusy(true);
    try {
      const r = await api.restoreMany(ids);
      refreshLibrary(qc);
      toast({ text: `${gens(r.restored.length)} restored.`, tone: "ok", action: { label: "Open library", run: () => go({ name: "library" }) } });
      done();
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const purge = async () => {
    const res = await confirm({
      hold: true,
      view: () => ({
        title: `Delete ${gens(ids.length)} for good?`, count: ids.length,
        previews: items.map(poster).filter((p): p is string => !!p),
        body: "They can't be restored after this.", facts: [`${bytes(items.reduce((a, t) => a + t.bytes, 0))} freed`],
        action: "Hold to delete",
      }),
    });
    if (!res.ok) return;
    setBusy(true);
    try {
      const r = await api.purgeMany(ids);
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["storage"] });
      toast({ text: `${gens(r.removed.length)} deleted for good.`, tone: "ok" });
      done();
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="bulk" role="toolbar" aria-label="Selection">
      <b>{ids.length} selected</b>
      <button className="btn sm" type="button" onClick={restore} disabled={busy}>{busy ? <Spinner size={12} /> : <I n="undo" />}<span className="lbl">Restore</span></button>
      <button className="btn sm danger" type="button" onClick={purge} disabled={busy}><I n="trash" /><span className="lbl">Delete for good</span></button>
      <button className="icon-btn sm" type="button" aria-label="Clear selection" onClick={done}><I n="x" /></button>
    </div>
  );
}

function TrashCard({ t, picking, picked, onPick }: { t: TrashItem; picking: boolean; picked: boolean; onPick: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const left = daysLeft(t);
  const img = poster(t);
  const restore = async () => {
    setBusy(true);
    try {
      await api.restore(t.id);
      refreshLibrary(qc);
      toast({ text: `“${t.title}” restored.`, tone: "ok", action: { label: "Open", run: () => go({ name: "generation", id: t.id }) } });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
      setBusy(false);
    }
  };
  const purge = async () => {
    const res = await confirm({
      hold: true,
      view: () => ({
        title: "Delete for good?", previews: img ? [img] : [], count: 1,
        body: `“${t.title}” can't be restored after this.`, facts: [`${bytes(t.bytes)} freed`], action: "Hold to delete",
      }),
    });
    if (!res.ok) return;
    setBusy(true);
    try {
      await api.purge(t.id);
      qc.invalidateQueries({ queryKey: ["trash"] });
      qc.invalidateQueries({ queryKey: ["storage"] });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
      setBusy(false);
    }
  };
  return (
    <article className={cx("card gcard trcard", busy && "busy", picked && "picked")} aria-label={`${t.prompt || t.title}, deleted`}
      {...(picking ? {
        role: "button", tabIndex: 0, "aria-pressed": picked, onClick: onPick,
        onKeyDown: (e: React.KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } },
      } : {})}>
      <Media src={img} poster={img} ar={aspect(t)}>
        {!img && <span aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(160deg,#22222A,#121217)" }} />}
      </Media>
      <div className="ctop">
        {picking && <span className="check"><I n="check" /></span>}
        <span className={cx("pill", left <= 1 && "rose")} title={`Deleted ${ago(t.deleted)}`}><I n="clock" />{left <= 0 ? "Goes today" : `${left}d left`}</span>
        <span className="fspacer" />
        {!picking && <button className="icon-btn sm glass reveal tdel" type="button" aria-label="Delete for good" title="Delete for good" onClick={() => void purge()} disabled={busy}><I n="trash" /></button>}
      </div>
      <div className="gprompt">
        <p>{t.prompt || t.title}</p>
        <div className="meta"><span className="when">{bytes(t.bytes)}</span>
          {!picking && <button className="btn sm" type="button" style={{ marginLeft: "auto" }} onClick={() => void restore()} disabled={busy}>{busy ? <Spinner size={12} /> : <I n="undo" />}Restore</button>}
        </div>
      </div>
    </article>
  );
}
