import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ModeBadge, ModelChip } from "../components/bits";
import { GenerationCard } from "../components/GenerationCard";
import { TemplateCard } from "../components/TemplateCard";
import { Box, Close, Download, Frame, Link, Motion, Search, Trash } from "../components/Icons";
import { Button, Empty, Notice, Select, Spinner, TextInput, cx } from "../components/ui";
import { api, type EngineInfo, type Mode, type Outcome } from "../lib/api";
import { day, errMsg, OUTCOME } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

const SHELVES = [
  { id: "templates", label: "Templates" },
  { id: "mine", label: "My generations" },
  { id: "imported", label: "Imported" },
  { id: "starter", label: "Starters" },
  { id: "community", label: "Community" },
] as const;

const GRID = "grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(212px,1fr))]";

/** Library: the shelf lives in the URL so back/forward and links land on the right tab. */
export function Library({ shelf: fromRoute }: { shelf?: string }) {
  const search = useApp((s) => s.search);
  const setSearch = useApp((s) => s.setSearch);
  const shelf = SHELVES.some((s) => s.id === fromRoute) ? fromRoute! : "templates";
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const counts: Record<string, number | undefined> = { ...(facets.data?.shelves ?? {}), templates: engines.data?.length };
  const pick = (id: string) => {
    setSearch("");
    go({ name: "library", shelf: id });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-5 border-b border-line flex items-end gap-4">
        <div role="tablist" aria-label="Shelves" className="flex items-end gap-5 -mb-px overflow-x-auto">
          {SHELVES.map((s) => {
            const on = shelf === s.id && !search;
            return (
              <button key={s.id} role="tab" type="button" aria-selected={on} onClick={() => pick(s.id)}
                className={cx("mk-btn relative h-10 px-0 border-0 bg-transparent text-sm font-medium inline-flex items-center gap-1.5 whitespace-nowrap",
                  on ? "text-text" : "text-muted hover:text-soft")}>
                {s.label}
                {s.id !== "community" && counts[s.id] != null && (
                  <span className={cx("min-w-[18px] h-[16px] px-1 rounded text-[10px] leading-4 font-mono tabular text-center", on ? "bg-active text-soft" : "bg-white/[0.05] text-faint")}>{counts[s.id]}</span>
                )}
                <span aria-hidden className={cx("absolute left-0 right-0 bottom-0 h-[2px] rounded-full transition-colors", on ? "bg-yellow" : "bg-transparent")} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scroll-y">
        <div className="px-5 py-4 flex flex-col gap-4 max-w-[1680px]">
          {search ? <Generations shelf={shelf} search={search} />
            : shelf === "templates" ? <Templates engines={engines.data} loading={engines.isLoading} error={engines.error} />
            : shelf === "community" ? <Community />
            : <Generations key={shelf} shelf={shelf} search="" />}
        </div>
      </div>
    </div>
  );
}

function FilterBar({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      {children}
      {right && <span className="ml-auto text-xs text-muted">{right}</span>}
    </div>
  );
}

function Chip({ on, onClick, children, dot }: { on: boolean; onClick: () => void; children: ReactNode; dot?: string }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={cx("mk-btn h-7 px-2.5 rounded-lg border text-sm inline-flex items-center gap-1.5", on ? "bg-active border-line2 text-text" : "bg-transparent border-line text-muted hover:text-text hover:border-line2")}>
      {dot && <span aria-hidden className="w-1.5 h-1.5 rounded-full" style={{ background: dot }} />}{children}
    </button>
  );
}

function Generations({ shelf, search }: { shelf: string; search: string }) {
  const setSearch = useApp((s) => s.setSearch);
  const [mode, setMode] = useState<Mode | "">("");
  const [model, setModel] = useState("");
  const [outcome, setOutcome] = useState<Outcome | "none" | "">("");
  const [driving, setDriving] = useState(false);
  const [tag, setTag] = useState("");
  const facets = useQuery({ queryKey: ["facets"], queryFn: api.facets });
  const rows = useQuery({
    queryKey: ["generations", shelf, search, mode, model, outcome, driving, tag],
    queryFn: () => api.generations({ shelf: search ? undefined : shelf, q: search, mode, model, outcome, tag, has_driving: driving ? 1 : undefined }),
    refetchInterval: (q) => ((q.state.data ?? []).some((r) => r.status === "running") ? 5000 : false),
  });
  const filtered = !!(mode || model || outcome || driving || tag);
  const clear = () => { setMode(""); setModel(""); setOutcome(""); setDriving(false); setTag(""); };
  const n = rows.data?.length ?? 0;

  return (
    <>
      <FilterBar right={rows.data ? `${n} ${n === 1 ? "generation" : "generations"} · newest first` : null}>
        {search && (
          <span className="h-7 pl-2.5 pr-1 rounded-lg bg-violet/15 text-violet-lighter text-sm inline-flex items-center gap-1.5">
            <Search size={12} />“{search}” in all shelves
            <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="mk-btn w-5 h-5 rounded border-0 bg-transparent text-violet-light hover:text-text flex items-center justify-center"><Close size={9} /></button>
          </span>
        )}
        <Select aria-label="Mode" value={mode} onChange={(e) => setMode(e.target.value as Mode | "")} className="h-7 w-auto">
          <option value="">All modes</option><option value="motion">Motion</option><option value="edit">Edit</option>
        </Select>
        <Select aria-label="Model" value={model} onChange={(e) => setModel(e.target.value)} className="h-7 w-auto max-w-[220px]">
          <option value="">Any model</option>
          {(facets.data?.models ?? []).map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
        </Select>
        <Select aria-label="Outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as Outcome | "")} className="h-7 w-auto">
          <option value="">Any outcome</option>
          {(Object.keys(OUTCOME) as Outcome[]).map((o) => <option key={o} value={o}>{OUTCOME[o].word}</option>)}
          <option value="none">Not rated</option>
        </Select>
        {!!facets.data?.tags.length && (
          <Select aria-label="Tag" value={tag} onChange={(e) => setTag(e.target.value)} className="h-7 w-auto">
            <option value="">Any tag</option>
            {facets.data.tags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </Select>
        )}
        <Chip on={driving} onClick={() => setDriving(!driving)}><Motion size={13} />Has driving video</Chip>
        {filtered && <Button tone="ghost" size="sm" onClick={clear}>Clear filters</Button>}
      </FilterBar>

      {rows.isLoading ? (
        <SkeletonGrid />
      ) : rows.isError ? (
        <Notice tone="error" title="Couldn't load generations" actions={<Button size="sm" onClick={() => rows.refetch()}>Try again</Button>}>{errMsg(rows.error)}</Notice>
      ) : n ? (
        <div className={GRID}>{rows.data!.map((s) => <GenerationCard key={s.id} s={s} />)}</div>
      ) : search || filtered ? (
        <Empty icon={<Search size={18} />} title="Nothing matches" action={<Button size="sm" onClick={() => { clear(); setSearch(""); }}>Clear search and filters</Button>}>
          Search looks through titles, prompts, tags and notes.
        </Empty>
      ) : shelf === "mine" ? (
        <Empty icon={<Frame size={18} />} title="No generations yet"
          action={<><Button tone="primary" size="md" onClick={() => go({ name: "library", shelf: "templates" })}>Browse templates</Button><Button size="md" onClick={() => go({ name: "edit" })}>Open Edit studio</Button></>}>
          Each run lands here with its inputs, settings and result, including the ones that fail.
        </Empty>
      ) : shelf === "imported" ? (
        <Empty icon={<Download size={18} />} title="Nothing imported">Drop a .illusion file, an OpenIllusion PNG or MP4, or paste a generation link anywhere in this window.</Empty>
      ) : (
        <Empty icon={<Box size={18} />} title="No starters">This install has an empty starters folder.</Empty>
      )}
      {shelf === "mine" && !search && <TrashLink />}
    </>
  );
}

function SkeletonGrid({ n = 8 }: { n?: number }) {
  return (
    <div className={GRID} aria-busy="true" aria-label="Loading">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="rounded-xl border border-line overflow-hidden">
          <div className="skeleton aspect-[16/10]" />
          <div className="p-2.5 flex flex-col gap-2"><div className="skeleton h-3 w-2/3 rounded" /><div className="skeleton h-2.5 w-1/3 rounded" /></div>
        </div>
      ))}
    </div>
  );
}

/** Every engine as a template, cloud and local side by side. Click one to open its studio with it loaded. */
function Templates({ engines = [], loading, error }: { engines?: EngineInfo[]; loading: boolean; error: unknown }) {
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const setStudio = useApp((s) => s.setStudio);
  const [kind, setKind] = useState<"" | "cloud" | "local">("");
  const [mode, setMode] = useState<Mode | "">("");
  const shown = engines
    .filter((e) => (!kind || e.kind === kind) && (!mode || e.mode === mode))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || Number(b.kind === "local") - Number(a.kind === "local"));
  const locked = (e: EngineInfo) =>
    e.kind === "cloud" ? (status.data?.router.ok ? null : "Add a Comfy API key in Settings")
      : status.data?.local.comfyui ? null : "Start ComfyUI or set its address in Settings";
  const use = (e: EngineInfo) => {
    setStudio(e.mode, { engine: e.id, raw: null });
    go({ name: e.mode });
  };
  const count = (k: "cloud" | "local") => engines.filter((e) => e.kind === k).length;

  return (
    <>
      <FilterBar right="Cloud runs on Comfy Router · Local runs in your ComfyUI">
        <Chip on={kind === ""} onClick={() => setKind("")}>All</Chip>
        <Chip on={kind === "cloud"} onClick={() => setKind("cloud")} dot="#9A86F0">Cloud <span className="font-mono text-xs text-faint">{count("cloud")}</span></Chip>
        <Chip on={kind === "local"} onClick={() => setKind("local")} dot="#F2FF59">Local <span className="font-mono text-xs text-faint">{count("local")}</span></Chip>
        <span className="w-px h-4 bg-line2 mx-1" aria-hidden />
        <Chip on={mode === ""} onClick={() => setMode("")}>Any mode</Chip>
        <Chip on={mode === "edit"} onClick={() => setMode("edit")}>Edit</Chip>
        <Chip on={mode === "motion"} onClick={() => setMode("motion")}>Motion</Chip>
      </FilterBar>
      {loading ? (
        <SkeletonGrid n={6} />
      ) : error ? (
        <Notice tone="error" title="Couldn't load templates">{errMsg(error)}</Notice>
      ) : shown.length ? (
        <div className={GRID}>{shown.map((e) => <TemplateCard key={e.id} e={e} locked={locked(e)} onUse={() => use(e)} />)}</div>
      ) : (
        <Empty icon={<Box size={18} />} title="No templates match" action={<Button size="sm" onClick={() => { setKind(""); setMode(""); }}>Show all</Button>} />
      )}
    </>
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
    <div className="flex flex-col gap-5">
      <form className="flex flex-col gap-1.5 max-w-[640px]" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label htmlFor="idx" className="text-sm font-medium text-soft">Add an index</label>
        <div className="flex gap-2">
          <TextInput id="idx" value={url} aria-invalid={!!addErr} onChange={(e) => { setUrl(e.target.value); setAddErr(null); }} placeholder="https://raw.githubusercontent.com/…/index.json" className="flex-1 h-8 font-mono text-sm" />
          <Button type="submit" size="md" disabled={!url.trim()}>Add</Button>
        </div>
        <span className={cx("text-xs", addErr ? "text-rose-text" : "text-muted")}>{addErr ?? "Any public index.json of generation links. Read-only. OpenIllusion hosts nothing."}</span>
      </form>
      {!urls.length && <Empty icon={<Link size={18} />} title="No community indexes">Add the URL of an index.json, for example a GitHub repo where people share generations by pull request.</Empty>}
      {urls.map((u, i) => {
        const q = indexes[i];
        return (
          <section key={u} className="flex flex-col gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <h2 className="m-0 text-md font-semibold">{q.data?.name ?? "Index"}</h2>
              <span className="font-mono text-xs text-faint truncate">{u}</span>
              <Button tone="ghost" size="sm" className="ml-auto" onClick={() => remove(u)}><Trash size={13} />Remove</Button>
            </div>
            {q.isLoading && <SkeletonGrid n={4} />}
            {q.isError && <Notice tone="error" title="Couldn't read this index" actions={<Button size="sm" onClick={() => q.refetch()}>Try again</Button>}>{errMsg(q.error)}</Notice>}
            {q.data && !q.data.generations.length && <p className="m-0 text-sm text-muted">This index lists no generations.</p>}
            <div className={GRID}>
              {q.data?.generations.map((s) => (
                <button key={s.url} type="button" onClick={() => open(s.url)} disabled={!!busy}
                  className="mk-btn group text-left block rounded-xl bg-surface border border-line hover:border-line2 overflow-hidden p-0">
                  <div className="relative aspect-[16/10] bg-raised flex items-center justify-center text-faint">
                    {s.poster ? <img src={s.poster} alt="" loading="lazy" className="w-full h-full object-cover" /> : <Frame size={20} />}
                    {s.mode && <span className="absolute left-2 top-2"><ModeBadge mode={s.mode} glass /></span>}
                    {busy === s.url && <span className="absolute inset-0 flex items-center justify-center bg-bg/60"><Spinner size={16} /></span>}
                  </div>
                  <div className="px-2.5 py-2 flex flex-col gap-1">
                    <span className="text-sm font-semibold truncate">{s.title ?? s.url.split("/").pop()}</span>
                    <span className="flex items-center gap-2 min-w-0">{s.model && <ModelChip model={s.model} />}{s.author && <span className="text-xs text-muted truncate">by {s.author}</span>}<span className="ml-auto text-xs text-violet-light opacity-0 group-hover:opacity-100 transition-opacity">Review</span></span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
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
    <details className="group mt-2 rounded-xl border border-line">
      <summary className="h-9 px-3 flex items-center gap-2 cursor-pointer text-sm text-muted hover:text-text select-none">
        <Trash size={13} />Trash <span className="font-mono text-xs text-faint">{trash.data.length}</span><span className="text-faint">· deleted generations are kept 7 days</span>
      </summary>
      <ul className="m-0 p-0 list-none border-t border-line">
        {trash.data.map((t) => (
          <li key={t.id} className="h-10 px-3 flex items-center gap-3 text-sm border-b border-line last:border-b-0">
            <span className="flex-1 truncate">{t.title}</span>
            <span className="text-xs text-muted tabular">{day(t.deleted)}</span>
            <Button size="xs" onClick={() => restore(t.id)}>Restore</Button>
          </li>
        ))}
      </ul>
    </details>
  );
}
