import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Masonry } from "../components/Masonry";
import { EmptyBox, I, PageHead, useStatus } from "../components/oi";
import { sharedTags, TemplateCard } from "../components/TemplateCard";
import { TemplateInspector } from "../components/TemplateInspector";
import { api, type EngineInfo } from "../lib/api";
import { errMsg } from "../lib/format";
import { go, href } from "../lib/route";
import { useApp } from "../lib/store";

type Kind = "all" | "edit" | "motion";
type Where = "all" | "local" | "cloud";
// Filters outlive a trip to Create and back.
const last = { use: "", kind: "all" as Kind, where: "all" as Where };

// Mixed shapes, so the placeholder wall looks like the one that replaces it.
const SKELETON = [0.8, 0.75, 0.8, 1, 0.66, 0.8, 1.33, 0.75].map((aspect, i) => ({ key: String(i), aspect }));

const NAMES: Record<string, string> = { lora: "LoRA", refmod: "RefMod" };
const tagLabel = (t: string) => NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1);

/** Every template as one wall, photos and videos together. Click runs it in Create; (i) opens its details on the right. */
export function Explore({ t }: { t?: string }) {
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const status = useStatus();
  const openTemplate = useApp((s) => s.openTemplate);
  const [use, setUse] = useState(last.use);
  const [kind, setKind] = useState(last.kind);
  const [where, setWhere] = useState(last.where);
  useEffect(() => { Object.assign(last, { use, kind, where }); }, [use, kind, where]);

  const every = useMemo(() => (engines.data ?? []).filter((e) => !e.hidden), [engines.data]);
  const all = every;
  const uses = sharedTags(all);
  const tagged = all.filter((e) => !use || !uses.includes(use) || e.tags?.includes(use));
  const pool = tagged.filter((e) => where === "all" || e.kind === where);
  const count = (k: Kind) => pool.filter((e) => k === "all" || e.mode === k).length;
  const runs = (w: Where) => tagged.filter((e) => (w === "all" || e.kind === w) && (kind === "all" || e.mode === kind)).length;
  const shown = pool
    .filter((e) => kind === "all" || e.mode === kind)
    .sort((a, b) => Number(b.curated) - Number(a.curated) || Number(b.kind === "local") - Number(a.kind === "local"));
  const tiles = shown.map((e) => ({ key: e.id, aspect: e.cover ? e.cover_aspect : undefined, e }));

  const locked = (e: EngineInfo) =>
    e.kind === "cloud" ? (status.data?.router.ok ? null : "Add a Comfy API key in Settings")
      : status.data?.local.comfyui ? null : "Start ComfyUI or set its address in Settings";
  const use_ = (e: EngineInfo) => { openTemplate(e.mode, e.id); go({ name: e.mode }); };
  const inspect = (id?: string) => go({ name: "explore", t: id });

  // The panel keeps showing the last template while it slides shut.
  const open = every.find((e) => e.id === t);
  const shownInPanel = useRef<EngineInfo | undefined>(undefined);
  if (open) shownInPanel.current = open;
  const panel = open ?? shownInPanel.current;
  const close = useMemo(() => () => inspect(), []);

  const filters = (
    <>
      <div className="seg" role="group" aria-label="What it makes">
        <button type="button" aria-pressed={kind === "all"} onClick={() => setKind("all")}>All<span className="n">{count("all")}</span></button>
        <button type="button" aria-pressed={kind === "edit"} onClick={() => setKind("edit")}><I n="image" />Photo<span className="n">{count("edit")}</span></button>
        <button type="button" aria-pressed={kind === "motion"} onClick={() => setKind("motion")}><I n="film" />Video<span className="n">{count("motion")}</span></button>
      </div>
      <span className="vsep" />
      {/* Where it runs: a toggle each, off shows both. */}
      <div className="seg" role="group" aria-label="Where it runs">
        <button type="button" aria-pressed={where === "local"} onClick={() => setWhere(where === "local" ? "all" : "local")} title="Runs on your ComfyUI"><I n="cpu" />Local<span className="n">{runs("local")}</span></button>
        <button type="button" aria-pressed={where === "cloud"} onClick={() => setWhere(where === "cloud" ? "all" : "cloud")} title="Runs on Comfy Router, paid per run"><I n="cloud" />Cloud<span className="n">{runs("cloud")}</span></button>
      </div>
    </>
  );
  // Tags get their own row under the filters: one tap each, tap again (or Everything) to clear.
  const tags = uses.length > 0 && (
    <div className="tagrow" role="group" aria-label="Tags">
      <button className="chip" type="button" aria-pressed={!use || !uses.includes(use)} onClick={() => setUse("")}>Everything</button>
      {uses.map((u) => <button key={u} className="chip" type="button" aria-pressed={use === u} onClick={() => setUse(use === u ? "" : u)}>{tagLabel(u)}</button>)}
    </div>
  );

  return (
    <div className="page explore">
      <div className="scroll">
        <PageHead filters={filters} sub={tags || undefined} actions={<a className="btn" href="#/build" title="Make a template from a ComfyUI workflow or a Comfy Router model"><I n="plus" /><span className="lbl">New template</span></a>} />
        <div className="wall-wrap wtop">
          {engines.isLoading ? (
            <Masonry label="Loading templates" items={SKELETON} maxCols={4} minCol={250} render={(x) => <div aria-hidden className="card"><div className="media" style={{ "--ar": x.aspect } as CSSProperties} /></div>} />
          ) : engines.isError ? (
            <EmptyBox icon="alert" title="Couldn't load templates" action={<button className="btn" type="button" onClick={() => engines.refetch()}>Try again</button>}>{errMsg(engines.error)}</EmptyBox>
          ) : tiles.length ? (
            <Masonry label="Templates" items={tiles} maxCols={4} minCol={250}
              render={({ e }) => <TemplateCard e={e} locked={locked(e)} selected={e.id === t} onUse={() => use_(e)} onInspect={() => inspect(e.id === t ? undefined : e.id)} />} />
          ) : where === "cloud" && !every.some((e) => e.kind === "cloud") ? (
            <EmptyBox icon="cloud" title="No cloud templates yet" action={<a className="btn primary" href={href({ name: "build", cloud: true })}><I n="plus" />Build one</a>}>Pick a Comfy Router model and the inputs people fill. It runs on Comfy's servers with your API key.</EmptyBox>
          ) : (
            <EmptyBox icon="search" title="No templates match" action={<button className="btn" type="button" onClick={() => { setUse(""); setKind("all"); setWhere("all"); }}>Show all</button>}>Clear the filter to see all of them.</EmptyBox>
          )}
        </div>
      </div>
      <div className={open ? "scrim on" : "scrim"} onClick={close} />
      <aside className={open ? "inspector open" : "inspector"} aria-label="Template details" aria-hidden={!open}>
        {panel && <TemplateInspector key={panel.id} e={panel} locked={locked(panel)} onUse={() => use_(panel)} onClose={close} />}
      </aside>
    </div>
  );
}
