import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Masonry } from "../components/Masonry";
import { cx, EmptyBox, I, PageHead, useStatus } from "../components/oi";
import { TemplateCard, tplChips, tplName } from "../components/TemplateCard";
import { TemplateInspector } from "../components/TemplateInspector";
import { api, type EngineInfo } from "../lib/api";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

type Where = "any" | "local" | "cloud";
// Filters outlive a trip to Create and back.
const last = { tag: "", where: "any" as Where };

// Mixed shapes, so the placeholder wall looks like the one that replaces it.
const SKELETON = [0.8, 0.75, 0.8, 1, 0.66, 0.8, 1.33, 0.75].map((aspect, i) => ({ key: String(i), aspect }));

/** Every template as a wall. Click runs it in Create; (i) opens its details on the right. */
export function Explore({ t }: { t?: string }) {
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const status = useStatus();
  const openTemplate = useApp((s) => s.openTemplate);
  const [tag, setTag] = useState(last.tag);
  const [where, setWhere] = useState(last.where);
  useEffect(() => { Object.assign(last, { tag, where }); }, [tag, where]);

  const every = useMemo(() => engines.data ?? [], [engines.data]);
  // A draft stays off the wall until one of its results is published as its cover.
  const all = useMemo(() => every.filter((e) => !e.draft), [every]);
  const drafts = every.filter((e) => e.draft);
  // Photos and videos share one wall; the badge on each card says which it makes.
  const chips = useMemo(() => tplChips(all), [all]);
  const shown = all
    .filter((e) => (!tag || e.tags?.includes(tag)) && (where === "any" || e.kind === where))
    .sort((a, b) => Number(b.curated) - Number(a.curated) || Number(b.kind === "local") - Number(a.kind === "local"));
  const tiles = shown.map((e) => ({ key: e.id, aspect: e.cover ? e.cover_aspect : undefined, e }));

  const locked = (e: EngineInfo) =>
    e.kind === "cloud" ? (status.data?.router.ok ? null : "Add a Comfy API key in Settings")
      : status.data?.local.comfyui ? null : "Start ComfyUI or set its address in Settings";
  const use = (e: EngineInfo) => { openTemplate(e.mode, e.id); go({ name: e.mode }); };
  const inspect = (id?: string) => go({ name: "explore", t: id });

  // The panel keeps showing the last template while it slides shut.
  const open = every.find((e) => e.id === t);
  const shownInPanel = useRef<EngineInfo | undefined>(undefined);
  if (open) shownInPanel.current = open;
  const panel = open ?? shownInPanel.current;
  const close = useMemo(() => () => inspect(), []);

  const local = all.filter((e) => e.kind === "local").length;
  const covers = all.filter((e) => e.cover).slice(0, 3);

  const filters = (
    <>
      <button className="chip" type="button" aria-pressed={!tag} onClick={() => setTag("")}>All</button>
      {chips.map((c) => <button key={c.tag} className="chip" type="button" aria-pressed={tag === c.tag} onClick={() => setTag(tag === c.tag ? "" : c.tag)}>{c.label}</button>)}
      <span className="fspacer" />
      <div className="seg" role="group" aria-label="Where it runs">
        <button type="button" aria-pressed={where === "any"} onClick={() => setWhere("any")}>Any</button>
        <button type="button" aria-pressed={where === "local"} onClick={() => setWhere("local")}><i className="dot" />Local</button>
        <button type="button" aria-pressed={where === "cloud"} onClick={() => setWhere("cloud")}><i className="dot violet" />Cloud</button>
      </div>
    </>
  );

  const empty = where === "cloud" && !status.data?.has_key
      ? <EmptyBox icon="cloud" title="Cloud templates need an API key" action={<a className="btn primary" href="#/settings">Add a key</a>}>Add a Comfy API key in Settings and cloud templates show up here.</EmptyBox>
      : <EmptyBox icon="search" title="Nothing here" action={<button className="btn" type="button" onClick={() => { setTag(""); setWhere("any"); }}>Show all</button>}>Try another category or clear the filter.</EmptyBox>;

  return (
    <div className="page explore">
      <div className="scroll">
        <PageHead title="Explore" filters={filters} actions={<a className="btn" href="#/build" title="Make a template from a ComfyUI workflow or a cloud model"><I n="plus" />New template</a>} />
        {covers.length > 0 && <div className="aura" aria-hidden>{covers.map((e) => <img key={e.id} src={e.cover!} alt="" />)}</div>}
        <div className="wall-wrap">
          <div className="lede">
            <div>
              <h2>Pick a look. Drop in a photo. <em>Run it on your GPU.</em></h2>
              <p>Every template comes with a sample photo and a prompt that already work. Swap in your own and edit the words.</p>
            </div>
            {!!all.length && (
              <div className="lede-stats">
                <div className="stat"><b>{all.length}</b><span>templates</span></div>
                <div className="stat"><b style={{ color: status.data?.local.comfyui ? "var(--mint)" : undefined }}>{local}</b><span>run locally</span></div>
                <div className="stat"><b>{all.length - local}</b><span>on the cloud</span></div>
              </div>
            )}
          </div>
        </div>
        {drafts.length > 0 && <Drafts list={drafts} selected={t} onUse={use} onInspect={(id) => inspect(id === t ? undefined : id)} />}
        <div className="wall-wrap" style={{ paddingTop: 4 }}>
          {engines.isLoading ? (
            <Masonry label="Loading templates" items={SKELETON} maxCols={4} minCol={250} render={(x) => <div aria-hidden className="card"><div className="media" style={{ "--ar": x.aspect } as CSSProperties} /></div>} />
          ) : engines.isError ? (
            <EmptyBox icon="alert" title="Couldn't load templates" action={<button className="btn" type="button" onClick={() => engines.refetch()}>Try again</button>}>{errMsg(engines.error)}</EmptyBox>
          ) : tiles.length ? (
            <Masonry label="Templates" items={tiles} maxCols={4} minCol={250}
              render={({ e }) => <TemplateCard e={e} locked={locked(e)} selected={e.id === t} onUse={() => use(e)} onInspect={() => inspect(e.id === t ? undefined : e.id)} />} />
          ) : empty}
        </div>
      </div>
      <div className={open ? "scrim on" : "scrim"} onClick={close} />
      <aside className={open ? "inspector open" : "inspector"} aria-label="Template details" aria-hidden={!open}>
        {panel && <TemplateInspector key={panel.id} e={panel} locked={locked(panel)} onUse={() => use(panel)} onClose={close} />}
      </aside>
    </div>
  );
}

/** Templates built but not published yet. Each one goes on the wall once a run of it becomes its cover. */
function Drafts({ list, selected, onUse, onInspect }: { list: EngineInfo[]; selected?: string; onUse: (e: EngineInfo) => void; onInspect: (id: string) => void }) {
  return (
    <section className="wall-wrap drafts" aria-label="Drafts">
      <div className="drafts-h"><b>Drafts</b><span>Run one, then publish a result. That result becomes its cover and puts it on the wall.</span></div>
      <div className="drafts-row">
        {list.map((e) => (
          <div key={e.id} className={cx("draft", e.id === selected && "sel")}>
            <button className="draft-go" type="button" onClick={() => onUse(e)} title="Open in Create">
              <span className="draft-ic"><I n={e.mode === "motion" ? "film" : "image"} /></span>
              <span className="draft-t"><b>{tplName(e)}</b><small>{e.kind === "local" ? "Local" : "Cloud"} · not published</small></span>
              <span className="draft-run"><I n="play" />Run</span>
            </button>
            <button className="icon-btn sm" type="button" aria-label={`Details for ${tplName(e)}`} onClick={() => onInspect(e.id)}><I n="info" /></button>
          </div>
        ))}
      </div>
    </section>
  );
}
