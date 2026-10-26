import { useQueries, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Masonry } from "../components/Masonry";
import { cx, EmptyBox, I, jobProgress, Media, PageHead, QUEUED, Ring } from "../components/oi";
import { tplName } from "../components/TemplateCard";
import { Spinner } from "../components/ui";
import { api, fileUrl, trashFileUrl, type GenerationRow, type Job, type TrashItem } from "../lib/api";
import { confirm } from "../lib/confirm";
import { ago, bytes, dayGroup, errMsg } from "../lib/format";
import { isActive, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

const SOURCES = [
  { id: "mine", label: "My generations" },
  { id: "imported", label: "Imported" },
  { id: "starter", label: "Starters" },
  { id: "community", label: "Community" },
  { id: "trash", label: "Trash" },
] as const;

type Tab = "all" | "starred" | "active" | "failed";
const FAILED = new Set(["failed", "moderated", "cancelled"]);
const WHAT: Record<Tab, string> = { all: "all generations", starred: "starred generations", active: "", failed: "failed runs" };
const gens = (n: number) => (n === 1 ? "1 generation" : `${n} generations`);
// Today and Yesterday read as words in a sentence; months stay as they are.
const dayWords = (g: string) => (/^(Today|Yesterday|Earlier)/.test(g) ? g.toLowerCase() : g);
type ToastFn = ReturnType<typeof useApp.getState>["toast"];

function refreshLibrary(qc: QueryClient) {
  for (const k of ["generations", "facets", "trash"]) qc.invalidateQueries({ queryKey: [k] });
}

/** Move to trash in one request; the toast offers Undo. The server keeps runs that are still going. */
async function moveToTrash(ids: string[], qc: QueryClient, toast: ToastFn) {
  try {
    const r = await api.trashMany(ids);
    refreshLibrary(qc);
    toast({
      text: `${gens(r.moved.length)} moved to trash.${r.kept.length ? ` ${r.kept.length} still running stayed.` : ""}`, tone: "ok",
      action: r.moved.length ? { label: "Undo", run: () => { void api.restoreMany(r.moved).then(() => refreshLibrary(qc)); } } : undefined,
    });
    return true;
  } catch (e) {
    toast({ text: errMsg(e), tone: "error" });
    refreshLibrary(qc);
    return false;
  }
}
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
  const trashView = shelf === "trash";
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const trash = useQuery({ queryKey: ["trash"], queryFn: api.trash });
  const rows = useQuery({
    queryKey: ["generations", shelf, model],
    queryFn: () => api.generations({ shelf, model }),
    enabled: !community && !trashView,
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

  // Clearing acts on what's on screen (shelf, tab, template), read in full from the server
  // so nothing past the first page is missed. Running runs stay; starred ones stay unless ticked.
  const clearWhere = async (title: string, match: (g: GenerationRow) => boolean) => {
    let found: GenerationRow[];
    try {
      found = (await api.generations({ shelf, model, limit: 20000 })).filter(match);
    } catch (e) {
      return toast({ text: errMsg(e), tone: "error" });
    }
    const live = found.filter(running).length;
    const idle = found.filter((r) => !running(r));
    const starred = idle.filter((r) => r.starred).length;
    const askStar = tab !== "starred" && starred > 0;
    const goes = (opt: boolean) => (askStar && !opt ? idle.filter((r) => !r.starred) : idle);
    const res = await confirm({
      option: askStar ? { label: () => <>Also clear <b>{starred}</b> starred</> } : undefined,
      view: (opt) => {
        const g = goes(opt);
        return {
          title, count: g.length,
          previews: g.filter((r) => r.poster).map((r) => fileUrl(r.id, r.poster!)),
          body: g.length ? `${gens(g.length)} move to the trash. You can restore them for 7 days.` : "Nothing here can be cleared.",
          facts: [live ? `${live} running stay` : "", askStar && !opt ? `${starred} starred stay` : ""].filter(Boolean),
          action: g.length ? `Move ${g.length} to trash` : "Nothing to clear", empty: !g.length,
        };
      },
    });
    if (res.ok) await moveToTrash(goes(res.option).map((r) => r.id), qc, toast);
  };
  const clearView = () => void clearWhere(`Clear ${WHAT[tab]}${model ? ` from ${nameOf(model)}` : ""}?`, of[tab]);
  const clearDay = (g: string) => void clearWhere(`Clear ${dayWords(g)}?`, (r) => dayGroup(r.created) === g && of[tab](r));
  const canClear = !community && !trashView && tab !== "active" && list.some((r) => !running(r));

  const filters = (
    <>
      {!community && !trashView && (
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
      {!community && !trashView && models.length > 1 && (
        <>
          <label className="sr" htmlFor="libTpl">Template</label>
          <select className="select" id="libTpl" value={model} onChange={(e) => setModel(e.target.value)} style={{ maxWidth: 220 }}>
            <option value="">All templates</option>
            {models.map((m) => <option key={m} value={m}>{nameOf(m)}</option>)}
          </select>
        </>
      )}
      <span className="fspacer" />
      {trashView ? <TrashActions items={trash.data ?? []} /> : (
        <button className="btn" type="button" onClick={() => window.dispatchEvent(new Event("oi:import"))}
          title="Bring in a run: a .illusion file, an OpenIllusion PNG or MP4, or a generation JSON"><I n="import" />Import</button>
      )}
      {canClear && !picking && (
        <button className="btn danger" type="button" onClick={clearView} title="Move everything shown here to the trash">
          <I n="trash" /><span className="lbl">{tab === "all" ? "Clear all" : tab === "failed" ? "Clear failed" : "Clear starred"}</span>
        </button>
      )}
      {!community && !trashView && !!all.length && (
        <button className={cx("btn", picking && "primary")} type="button" onClick={() => { setPicking(!picking); setPicked(new Set()); }}>
          <I n="select" />{picking ? "Done" : "Select"}
        </button>
      )}
    </>
  );

  return (
    <div className="page library">
      <div className="scroll">
        <PageHead title="Library" count={community ? null : trashView ? trash.data?.length ?? null : total ?? all.length} filters={filters} />
        <div className="wall-wrap lib">
          {community ? <Community />
            : trashView ? <TrashWall q={trash} />
            : rows.isLoading ? <Skeleton />
            : rows.isError ? <EmptyBox icon="alert" title="Couldn't load generations" action={<button className="btn" type="button" onClick={() => rows.refetch()}>Try again</button>}>{errMsg(rows.error)}</EmptyBox>
            : groups.length ? groups.map(([g, v]) => (
              <section key={g} className="lgroup" aria-label={g}>
                <div className="ghead"><h3>{g}</h3><span>{v.length}</span>
                  {!picking && tab !== "active" && v.some((r) => !running(r)) && (
                    <button className="gclear" type="button" onClick={() => clearDay(g)} aria-label={`Clear ${dayWords(g)}`}><I n="trash" />Clear</button>
                  )}
                </div>
                <Masonry label={g} maxCols={5} minCol={220} items={v.map((r) => ({ key: r.id, aspect: r.width && r.height ? r.width / r.height : undefined, r }))}
                  render={({ r }) => <GenCard g={r} job={jobOf.get(r.id)} name={nameOf(r.model)} picking={picking} picked={picked.has(r.id)} onPick={() => pick(r.id)} />} />
              </section>
            ))
            : <Empty shelf={shelf} tab={tab} filtered={!!model} clear={() => { setTab("all"); setModel(""); }} />}
          {shelf === "mine" && <TrashLink n={trash.data?.length ?? 0} />}
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
            <p title={g.error ?? undefined}>{g.error ?? "Open it to see what went wrong."}</p>
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
        {(st === "done" || st === "failed") && !picking && (
          <button className="icon-btn sm glass reveal gdel" type="button" aria-label="Move to trash" title="Move to trash"
            onClick={(e) => { e.stopPropagation(); void moveToTrash([g.id], qc, toast); }}><I n="x" /></button>
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
    const rows = qc.getQueriesData<GenerationRow[]>({ queryKey: ["generations"] }).flatMap(([, d]) => d ?? []);
    const posters = ids.map((id) => rows.find((r) => r.id === id)).filter((r) => r?.poster).map((r) => fileUrl(r!.id, r!.poster!));
    const res = await confirm({
      view: () => ({
        title: `Move ${gens(ids.length)} to the trash?`, count: ids.length, previews: [...new Set(posters)],
        body: "You can restore them for 7 days. Runs still going are kept.", action: `Move ${ids.length} to trash`,
      }),
    });
    if (!res.ok) return;
    setBusy(true);
    if (await moveToTrash(ids, qc, toast)) done();
    setBusy(false);
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
                  <div className="ctop">{s.mode && <span className="pill">{s.mode === "motion" ? "Video" : "Image"}</span>}</div>
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

/** A quiet way into the trash, under My generations. */
function TrashLink({ n }: { n: number }) {
  if (!n) return null;
  return (
    <a className="trashlink" href="#/library?shelf=trash">
      <I n="trash" />Trash<span className="mono">{n}</span><span className="sub">kept 7 days</span><I n="right" />
    </a>
  );
}

function TrashActions({ items }: { items: TrashItem[] }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  if (!items.length) return null;
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
        previews: items.filter((t) => t.poster).map((t) => trashFileUrl(t.id, t.poster!)),
        body: `${gens(items.length)} ${items.length === 1 ? "is" : "are"} deleted for good. This can't be undone.`,
        facts: [`${bytes(items.reduce((a, t) => a + t.bytes, 0))} freed`, "Full-size files in your output folder stay"],
        action: "Hold to empty",
      }),
    });
    if (!res.ok) return;
    try {
      const r = await api.emptyTrash();
      qc.invalidateQueries({ queryKey: ["trash"] });
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

/** Deleted generations, newest first. Each can come back, or go for good. */
function TrashWall({ q }: { q: UseQueryResult<TrashItem[]> }) {
  if (q.isLoading) return <Skeleton />;
  if (q.isError) return <EmptyBox icon="alert" title="Couldn't read the trash" action={<button className="btn" type="button" onClick={() => q.refetch()}>Try again</button>}>{errMsg(q.error)}</EmptyBox>;
  const items = (q.data ?? []).map((t) => ({ key: t.id, aspect: t.width && t.height ? t.width / t.height : undefined, t }));
  if (!items.length) {
    return (
      <EmptyBox icon="trash" title="Trash is empty" action={<a className="btn" href="#/library">Back to library</a>}>
        Deleted generations wait here for 7 days, then go for good.
      </EmptyBox>
    );
  }
  return (
    <section className="lgroup" aria-label="Trash">
      <div className="ghead"><h3>Deleted</h3><span>{items.length}</span><span className="sub">Each goes for good 7 days after it was deleted.</span></div>
      <Masonry label="Trash" maxCols={5} minCol={220} items={items} render={({ t }) => <TrashCard t={t} />} />
    </section>
  );
}

function TrashCard({ t }: { t: TrashItem }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const left = Math.max(0, Math.ceil((t.purge_at - Date.now() / 1000) / 86400));
  const img = t.poster ? trashFileUrl(t.id, t.poster) : null;
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
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
      setBusy(false);
    }
  };
  return (
    <article className={cx("card gcard trcard", busy && "busy")} aria-label={`${t.prompt || t.title}, deleted`}>
      <Media src={img} poster={img} ar={t.width && t.height ? t.width / t.height : 4 / 5}>
        {!img && <span aria-hidden style={{ position: "absolute", inset: 0, background: "linear-gradient(160deg,#30233a,#1c1622)" }} />}
      </Media>
      <div className="ctop">
        <span className={cx("pill", left <= 1 && "rose")} title={`Deleted ${ago(t.deleted)}`}><I n="clock" />{left <= 0 ? "Goes today" : `${left}d left`}</span>
        <span className="fspacer" />
        <button className="icon-btn sm glass reveal tdel" type="button" aria-label="Delete for good" title="Delete for good" onClick={() => void purge()} disabled={busy}><I n="trash" /></button>
      </div>
      <div className="gprompt">
        <p>{t.prompt || t.title}</p>
        <div className="meta"><span className="when" title={bytes(t.bytes)}>Deleted {ago(t.deleted)}</span>
          <button className="btn sm" type="button" style={{ marginLeft: "auto" }} onClick={() => void restore()} disabled={busy}>{busy ? <Spinner size={12} /> : <I n="undo" />}Restore</button>
        </div>
      </div>
    </article>
  );
}

