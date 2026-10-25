import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Masonry } from "../components/Masonry";
import { cx, EmptyBox, I, jobProgress, Media, PageHead, QUEUED, Ring } from "../components/oi";
import { tplName } from "../components/TemplateCard";
import { Spinner } from "../components/ui";
import { api, fileUrl, type GenerationRow, type Job } from "../lib/api";
import { ago, day, dayGroup, errMsg } from "../lib/format";
import { isActive, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

const SOURCES = [
  { id: "mine", label: "My generations" },
  { id: "imported", label: "Imported" },
  { id: "starter", label: "Starters" },
  { id: "community", label: "Community" },
] as const;

type Tab = "all" | "starred" | "active" | "failed";
const FAILED = new Set(["failed", "moderated", "cancelled"]);
// The tab and template filter outlive a trip to the viewer and back.
const last = { tab: "all" as Tab, model: "" };

/** Library: every run, newest first, grouped by day on a masonry wall. Source lives in the URL. */
export function Library({ shelf: fromRoute }: { shelf?: string }) {
  const shelf = SOURCES.some((s) => s.id === fromRoute) ? fromRoute! : "mine";
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const [tab, setTab] = useState(last.tab);
  const [model, setModel] = useState(last.model);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => { Object.assign(last, { tab, model }); }, [tab, model]);
  useEffect(() => { setPicking(false); setPicked(new Set()); }, [shelf]);

  const community = shelf === "community";
  const rows = useQuery({
    queryKey: ["generations", shelf, model],
    queryFn: () => api.generations({ shelf, model }),
    enabled: !community,
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === "running") ? 5000 : false),
  });
  const { data: jobs = [] } = useJobs();
  const jobOf = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  const all = rows.data ?? [];
  const running = (g: GenerationRow) => g.status === "running" || !!(jobOf.get(g.id) && isActive(jobOf.get(g.id)!));
  const of: Record<Tab, (g: GenerationRow) => boolean> = {
    all: () => true,
    starred: (g) => g.starred,
    active: running,
    failed: (g) => FAILED.has(g.status),
  };
  const list = all.filter(of[tab]);
  const n = (t: Tab) => all.filter(of[t]).length;

  const setLibList = useApp((s) => s.setLibList);
  const ids = list.map((g) => g.id).join(",");
  useEffect(() => { setLibList(ids ? ids.split(",") : []); }, [ids, setLibList]);

  const groups = useMemo(() => {
    const out: [string, GenerationRow[]][] = [];
    for (const g of list) {
      const k = dayGroup(g.created);
      const at = out.find(([h]) => h === k);
      if (at) at[1].push(g);
      else out.push([k, [g]]);
    }
    return out;
  }, [list]);

  const names = useMemo(() => new Map((engines.data ?? []).map((e) => [e.id, tplName(e)])), [engines.data]);
  const nameOf = (m: string) => names.get(m) ?? m.split("/").pop() ?? m;
  const models = facets.data?.models ?? [];
  const pick = (id: string) => setPicked((p) => { const s = new Set(p); if (s.has(id)) s.delete(id); else s.add(id); return s; });
  const total = facets.data?.shelves?.[shelf];

  const filters = (
    <>
      {!community && (
        <div className="seg" role="group" aria-label="Show">
          <button type="button" aria-pressed={tab === "all"} onClick={() => setTab("all")}>All<span className="n">{all.length}</span></button>
          <button type="button" aria-pressed={tab === "starred"} onClick={() => setTab("starred")}><I n="star" />Starred<span className="n">{n("starred")}</span></button>
          <button type="button" aria-pressed={tab === "active"} onClick={() => setTab("active")}>In progress<span className="n">{n("active")}</span></button>
          <button type="button" aria-pressed={tab === "failed"} onClick={() => setTab("failed")}>Failed<span className="n">{n("failed")}</span></button>
        </div>
      )}
      <label className="sr" htmlFor="libSrc">Source</label>
      <select className="select" id="libSrc" value={shelf} onChange={(e) => go({ name: "library", shelf: e.target.value })}>
        {SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      {!community && models.length > 1 && (
        <>
          <label className="sr" htmlFor="libTpl">Template</label>
          <select className="select" id="libTpl" value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">All templates</option>
            {models.map((m) => <option key={m} value={m}>{nameOf(m)}</option>)}
          </select>
        </>
      )}
      <span className="fspacer" />
      {!community && <span className="hint">Saved the moment each run finishes</span>}
      {!community && !!all.length && (
        <button className={cx("btn", picking && "primary")} type="button" onClick={() => { setPicking(!picking); setPicked(new Set()); }}>
          <I n="select" />{picking ? "Done" : "Select"}
        </button>
      )}
    </>
  );

  return (
    <div className="page library">
      <div className="scroll">
        <PageHead title="Library" count={community ? null : total ?? all.length} filters={filters} />
        <div className="wall-wrap lib">
          {community ? <Community />
            : rows.isLoading ? <Skeleton />
            : rows.isError ? <EmptyBox icon="alert" title="Couldn't load generations" action={<button className="btn" type="button" onClick={() => rows.refetch()}>Try again</button>}>{errMsg(rows.error)}</EmptyBox>
            : groups.length ? groups.map(([g, v]) => (
              <section key={g} className="lgroup" aria-label={g}>
                <div className="ghead"><h3>{g}</h3><span>{v.length}</span></div>
                <Masonry label={g} maxCols={5} minCol={220} items={v.map((r) => ({ key: r.id, aspect: r.width && r.height ? r.width / r.height : undefined, r }))}
                  render={({ r }) => <GenCard g={r} job={jobOf.get(r.id)} name={nameOf(r.model)} picking={picking} picked={picked.has(r.id)} onPick={() => pick(r.id)} />} />
              </section>
            ))
            : <Empty shelf={shelf} tab={tab} filtered={!!model} clear={() => { setTab("all"); setModel(""); }} />}
          {shelf === "mine" && !community && <TrashLink />}
        </div>
      </div>
      {picking && picked.size > 0 && <Bulk ids={[...picked]} done={() => { setPicked(new Set()); setPicking(false); }} />}
    </div>
  );
}

function Empty({ shelf, tab, filtered, clear }: { shelf: string; tab: Tab; filtered: boolean; clear: () => void }) {
  if (tab === "starred") return <EmptyBox icon="star" title="Nothing starred yet" action={<button className="btn" type="button" onClick={clear}>Show all</button>}>Star a result to keep it here.</EmptyBox>;
  if (tab !== "all" || filtered) return <EmptyBox icon="search" title="Nothing here" action={<button className="btn" type="button" onClick={clear}>Clear filters</button>}>Change the filter to see more.</EmptyBox>;
  if (shelf === "imported") return <EmptyBox icon="import" title="Nothing imported">Drop a .illusion file, an OpenIllusion PNG or MP4, or paste a generation link anywhere in this window.</EmptyBox>;
  if (shelf === "starter") return <EmptyBox icon="layers" title="No starters">This install has an empty starters folder.</EmptyBox>;
  return (
    <EmptyBox icon="library" title="No generations yet" action={<a className="btn primary" href="#/explore">Browse templates</a>}>
      Each run lands here with its inputs, settings and result, including the ones that fail.
    </EmptyBox>
  );
}

function Skeleton() {
  const items = [0.8, 1, 0.75, 1.33, 0.8, 0.66, 1, 0.8, 0.75, 1.2].map((aspect, i) => ({ key: String(i), aspect }));
  return (
    <section className="lgroup" aria-busy="true" aria-label="Loading">
      <Masonry label="Loading" items={items} maxCols={5} minCol={220} render={(x) => <div aria-hidden className="card"><div className="media" style={{ "--ar": x.aspect } as CSSProperties} /></div>} />
    </section>
  );
}

/** One run on the wall. Running ones sharpen as they sample; failed ones say why on the card. */
function GenCard({ g, job, name, picking, picked, onPick }: { g: GenerationRow; job?: Job; name: string; picking: boolean; picked: boolean; onPick: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const loadGeneration = useApp((s) => s.loadGeneration);
  const live = !!job && isActive(job);
  const queued = live && QUEUED.has(job!.state);
  const st = live ? (queued ? "queued" : "running") : g.status === "running" ? "running" : FAILED.has(g.status) ? "failed" : "done";
  const p = st === "running" ? jobProgress(job) : 0;
  const img = (st === "running" && job?.preview) || (g.poster ? fileUrl(g.id, g.poster) : null);
  const video = st === "done" && g.result_kind === "video" && g.preview ? fileUrl(g.id, g.preview) : null;
  const ar = g.width && g.height ? g.width / g.height : 4 / 5;
  const steps = job?.progress?.steps;
  const step = job?.progress?.step;

  const open = () => (picking ? onPick() : go({ name: "generation", id: g.id }));
  const star = async () => {
    const next = !g.starred;
    qc.setQueriesData<GenerationRow[]>({ queryKey: ["generations"] }, (rows) => rows?.map((r) => (r.id === g.id ? { ...r, starred: next } : r)));
    try {
      await api.patch(g.id, { starred: next });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
    qc.invalidateQueries({ queryKey: ["generations"] });
  };
  const remix = async () => {
    try {
      const mode = loadGeneration(await api.generation(g.id));
      go({ name: mode });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const retry = async () => {
    try {
      await api.rerun(g.id);
      qc.invalidateQueries({ queryKey: ["jobs"] });
      qc.invalidateQueries({ queryKey: ["generations"] });
      toast({ text: "Running it again.", tone: "ok" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const failText = g.status === "moderated" ? "Blocked by moderation" : g.status === "cancelled" ? "Cancelled" : "Run failed";

  return (
    <article className={cx("card gcard", `st-${st}`, picked && "picked")} tabIndex={0} role="button" style={{ "--p": p } as CSSProperties}
      aria-label={`${g.prompt || g.title}, ${st}`} aria-pressed={picking ? picked : undefined}
      onClick={open} onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); } }}>
      <Media src={img} video={video} poster={img} ar={ar}>
        {!img && !video && <span aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(160deg,#30233a,#1c1622)" }} />}
        {(st === "running" || st === "queued") && (
          <>
            <div className="noise" />
            <div className="hud"><div className="hud-in">
              <Ring p={p} sm />
              <b>{queued ? "Waiting" : "Sampling"}</b>
              <span>{queued ? (job?.queue_position ? `#${job.queue_position} in queue` : "in queue") : step && steps ? `${step}/${steps}` : job?.detail || "starting"}</span>
            </div></div>
          </>
        )}
        {st === "failed" && (
          <div className="gfail">
            <span className="ic"><I n="alert" /></span>
            <b>{failText}</b>
            <p>Open it to see what ComfyUI said.</p>
            {!picking && <button className="btn sm" type="button" onClick={(e) => { e.stopPropagation(); void retry(); }}><I n="refresh" />Try again</button>}
          </div>
        )}
      </Media>
      <div className="ctop">
        {picking && <span className="check"><I n="check" /></span>}
        {st === "failed" ? <span className="pill rose">{g.status === "moderated" ? "Moderated" : g.status === "cancelled" ? "Cancelled" : "Failed"}</span>
          : st !== "done" ? <span className="pill"><i className="dot" style={{ background: "var(--yellow)", animation: "pulse 1.2s infinite" }} />{queued ? "Queued" : "Running"}</span>
          : g.variant ? <span className="pill" title={`Imported from a ${g.variant} .illusion package`}>Imported</span> : null}
        <span className="fspacer" />
        {st === "done" && !picking && (
          <>
            <button className={cx("icon-btn sm glass fav", !g.starred && "reveal")} type="button" aria-pressed={g.starred} aria-label={g.starred ? "Unstar" : "Star"}
              onClick={(e) => { e.stopPropagation(); void star(); }}><I n="star" /></button>
            <button className="icon-btn sm glass reveal" type="button" aria-label="Remix in Create" title="Remix in Create"
              onClick={(e) => { e.stopPropagation(); void remix(); }}><I n="remix" /></button>
          </>
        )}
      </div>
      {st === "done" && (
        <div className="gprompt reveal">
          <p>{g.prompt || g.title}</p>
          <div className="meta"><b>{name}</b><span>{ago(g.created)}</span>{g.elapsed != null && <span className="mono">{Math.round(g.elapsed)} s</span>}</div>
        </div>
      )}
    </article>
  );
}

/** Download or trash everything picked. Trash can be undone. */
function Bulk({ ids, done }: { ids: string[]; done: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const refresh = () => { for (const k of ["generations", "facets", "trash"]) qc.invalidateQueries({ queryKey: [k] }); };

  const download = async () => {
    setBusy(true);
    try {
      const ms = await Promise.all(ids.map((id) => api.generation(id)));
      let n = 0;
      for (const m of ms) {
        const f = m.result?.file;
        if (!f) continue;
        const a = document.createElement("a");
        a.href = fileUrl(m.id, f);
        a.download = `${m.title || m.id}.${f.split(".").pop()}`;
        a.click();
        n++;
        await new Promise((r) => setTimeout(r, 150));
      }
      toast({ text: n ? `Downloading ${n} result${n > 1 ? "s" : ""}.` : "None of these have a result yet.", tone: n ? "ok" : "warn" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };
  const trash = async () => {
    setBusy(true);
    try {
      await Promise.all(ids.map((id) => api.remove(id)));
      refresh();
      done();
      toast({
        text: `${ids.length} moved to trash.`, tone: "ok",
        action: { label: "Undo", run: () => { void Promise.all(ids.map((id) => api.restore(id))).then(refresh); } },
      });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
      refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bulk" role="toolbar" aria-label="Selection">
      <b>{ids.length} selected</b>
      <button className="btn sm" type="button" onClick={download} disabled={busy}>{busy ? <Spinner size={12} /> : <I n="download" />}<span className="lbl">Download</span></button>
      <button className="btn sm danger" type="button" onClick={trash} disabled={busy}><I n="trash" /><span className="lbl">Move to trash</span></button>
      <button className="icon-btn sm" type="button" aria-label="Clear selection" onClick={done}><I n="x" /></button>
    </div>
  );
}

function Community() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const setReview = useApp((s) => s.setReview);
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [addErr, setAddErr] = useState<string | null>(null);
  const urls = settings.data?.community_indexes ?? [];
  const indexes = useQueries({ queries: urls.map((u) => ({ queryKey: ["community", u], queryFn: () => api.community(u), staleTime: 300_000, retry: false })) });

  const add = async () => {
    const u = url.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) return setAddErr("Use a full http(s) URL to an index.json.");
    if (urls.includes(u)) return setAddErr("That index is already added.");
    setAddErr(null);
    await api.saveSettings({ community_indexes: [...urls, u] });
    setUrl("");
    qc.invalidateQueries({ queryKey: ["settings"] });
  };
  const remove = async (u: string) => {
    await api.saveSettings({ community_indexes: urls.filter((x) => x !== u) });
    qc.invalidateQueries({ queryKey: ["settings"] });
  };
  const open = async (u: string) => {
    setBusy(u);
    try {
      setReview(await api.importUrl(u));
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <form className="ofield" style={{ maxWidth: 640, margin: "0 auto", width: "100%" }} onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <label htmlFor="idx">Add a community index</label>
        <div className="irow">
          <input className="input mono" id="idx" value={url} aria-invalid={!!addErr} onChange={(e) => { setUrl(e.target.value); setAddErr(null); }} placeholder="https://raw.githubusercontent.com/…/index.json" style={{ height: 36, padding: "0 12px", fontSize: 12.5 }} />
          <button className="btn" type="submit" disabled={!url.trim()}>Add</button>
        </div>
        <p className="help" style={addErr ? { color: "var(--rose)" } : undefined}>{addErr ?? "Any public index.json of generation links. Read-only. OpenIllusion hosts nothing."}</p>
      </form>
      {!urls.length && <EmptyBox icon="globe" title="No community indexes">Add the URL of an index.json, for example a GitHub repo where people share generations by pull request.</EmptyBox>}
      {urls.map((u, i) => {
        const q = indexes[i];
        const items = (q.data?.generations ?? []).map((s) => ({ key: s.url, aspect: 4 / 5, s }));
        return (
          <section key={u} className="lgroup">
            <div className="ghead"><h3>{q.data?.name ?? "Index"}</h3><span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u}</span>
              <button className="btn sm ghost" type="button" style={{ marginLeft: "auto" }} onClick={() => void remove(u)}><I n="trash" />Remove</button></div>
            {q.isLoading && <Skeleton />}
            {q.isError && <EmptyBox icon="alert" title="Couldn't read this index" action={<button className="btn" type="button" onClick={() => q.refetch()}>Try again</button>}>{errMsg(q.error)}</EmptyBox>}
            {q.data && !items.length && <p className="help" style={{ textAlign: "center" }}>This index lists no generations.</p>}
            {!!items.length && (
              <Masonry label={q.data?.name ?? "Index"} items={items} maxCols={5} minCol={220} render={({ s }) => (
                <article className="card gcard st-done" tabIndex={0} role="button" aria-label={`Review ${s.title ?? s.url}`} onClick={() => !busy && void open(s.url)}
                  onKeyDown={(e) => { if (e.key === "Enter") void open(s.url); }}>
                  <Media src={s.poster} ar={4 / 5}>{busy === s.url && <div className="hud"><div className="hud-in"><Spinner size={16} /></div></div>}</Media>
                  <div className="ctop">{s.mode && <span className="pill">{s.mode === "motion" ? "Motion" : "Edit"}</span>}</div>
                  <div className="gprompt"><p>{s.title ?? s.url.split("/").pop()}</p><div className="meta">{s.model && <b>{s.model.split("/").pop()}</b>}{s.author && <span>by {s.author}</span>}</div></div>
                </article>
              )} />
            )}
          </section>
        );
      })}
    </>
  );
}

export function TrashLink() {
  const trash = useQuery({ queryKey: ["trash"], queryFn: api.trash });
  const qc = useQueryClient();
  if (!trash.data?.length) return null;
  const restore = async (id: string) => {
    await api.restore(id);
    for (const k of ["trash", "generations", "facets"]) qc.invalidateQueries({ queryKey: [k] });
  };
  return (
    <details className="set-card" style={{ maxWidth: "var(--wall-max)", width: "100%", margin: "0 auto", padding: "12px 16px" }}>
      <summary style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-2)" }}>
        <I n="trash" />Trash <span className="mono" style={{ color: "var(--text-3)" }}>{trash.data.length}</span><span style={{ color: "var(--text-3)" }}>· deleted generations are kept 7 days</span>
      </summary>
      <div style={{ marginTop: 10, display: "grid" }}>
        {trash.data.map((t) => (
          <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0", borderTop: "1px solid var(--line)", fontSize: 13 }}>
            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.title}</span>
            <span className="mono" style={{ color: "var(--text-3)", fontSize: 11.5 }}>{day(t.deleted)}</span>
            <button className="btn sm" type="button" onClick={() => void restore(t.id)}>Restore</button>
          </div>
        ))}
      </div>
    </details>
  );
}
