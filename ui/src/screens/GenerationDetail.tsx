import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useState, type ReactNode } from "react";
import { ABPlayer, typing } from "../components/ABPlayer";
import { KindBadge, ModeBadge, OutcomeToggle, StateBadge } from "../components/bits";
import { EngineDropdown } from "../components/Engine";
import { ArrowLeft, Check, Chevron, Close, Copy, Frame, Graph, More, Refresh, Trash, Upload } from "../components/Icons";
import { StageError, StageRunning, type Fix } from "../components/Studio";
import { Badge, Button, Empty, IconButton, Kbd, Section, cx } from "../components/ui";
import { api, fileUrl, workflowUrl, type Manifest } from "../lib/api";
import { elapsed, errMsg, roleLabel, shortModel, stamp, LICENSES } from "../lib/format";
import { useElapsed, useJobs } from "../lib/live";
import { go, href } from "../lib/route";
import { useApp } from "../lib/store";

export function GenerationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["generation", id], queryFn: () => api.generation(id), retry: false });
  const { data: jobs = [] } = useJobs();
  const job = jobs.find((j) => j.id === id);
  const t = useElapsed(job?.started ?? job?.created, job?.finished);
  const toast = useApp((s) => s.toast);
  const share = useApp((s) => s.share);
  const loadGeneration = useApp((s) => s.loadGeneration);
  const setStudio = useApp((s) => s.setStudio);
  const [swap, setSwap] = useState(false);
  const [more, setMore] = useState(false);
  const m = q.data;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || document.querySelector("[role=dialog]")) return;
      if (e.key.toLowerCase() === "e" && m) { e.preventDefault(); share(m.id); }
      if (e.key === "Escape" && !document.querySelector("[data-radix-popper-content-wrapper]")) go({ name: "library", shelf: m?._shelf ?? "mine" });
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [m, share]);

  if (q.isLoading) {
    return (
      <div className="flex-1 min-h-0 grid xl:grid-cols-[minmax(0,1fr)_340px]" aria-busy="true">
        <div className="p-3"><div className="skeleton h-full min-h-[320px] rounded-lg" /></div>
        <div className="border-l border-line bg-panel p-4 flex flex-col gap-3 max-xl:hidden"><div className="skeleton h-5 w-2/3 rounded" /><div className="skeleton h-3 w-1/3 rounded" /><div className="skeleton h-24 rounded-lg" /></div>
      </div>
    );
  }
  if (!m) {
    return (
      <Empty icon={<Frame size={18} />} title="Generation not found" className="flex-1" action={<Button size="md" onClick={() => go({ name: "library", shelf: "mine" })}>Back to library</Button>}>
        {q.error ? errMsg(q.error) : "It may have been deleted."} Deleted generations stay in the trash for 7 days.
      </Empty>
    );
  }

  const remix = (opts?: { engine?: string; dropVideo?: boolean }) => {
    const mode = loadGeneration(m, opts);
    setStudio(mode, { current: null, group: [] });
    go({ name: mode });
  };
  const rerun = async () => {
    try {
      const { ids } = await api.rerun(m.id);
      setStudio(m.mode, (st) => ({ current: ids[0], group: ids, session: [...ids, ...st.session] }));
      toast({ text: "Re-running with a new seed.", tone: "ok", action: { label: "Watch", run: () => go({ name: m.mode }) } });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const save = async (p: Parameters<typeof api.patch>[1]) => {
    try {
      const next = await api.patch(m.id, p);
      qc.setQueryData(["generation", m.id], { ...m, ...next });
      qc.invalidateQueries({ queryKey: ["generations"] });
    } catch (e) {
      toast({ text: `Couldn't save: ${errMsg(e)}`, tone: "error" });
    }
  };
  const remove = async () => {
    setMore(false);
    try {
      await api.remove(m.id);
    } catch (e) {
      return toast({ text: errMsg(e), tone: "error" });
    }
    for (const k of ["generations", "facets", "trash"]) qc.invalidateQueries({ queryKey: [k] });
    toast({ text: `“${m.title}” moved to trash.`, action: { label: "Undo", run: async () => { await api.restore(m.id); qc.invalidateQueries({ queryKey: ["generations"] }); go({ name: "generation", id: m.id }); } } });
    go({ name: "library", shelf: "mine" });
  };

  const r = m.result;
  const video = m.inputs.find((i) => i.slot.startsWith("video:"));
  const hero = r?.file
    ? { kind: (r.kind ?? "video") as "video" | "image", src: fileUrl(m.id, r.file), poster: r.poster ? fileUrl(m.id, r.poster) : null, label: "Result" }
    : null;
  const source = video?.file
    ? { kind: "video" as const, src: fileUrl(m.id, video.file), poster: fileUrl(m.id, "driving/poster.webp"), label: "Source" }
    : m.mode === "edit" && m.inputs[0]?.file ? { kind: "image" as const, src: fileUrl(m.id, m.inputs[0].file), label: "Before" } : null;
  const shelf = m._shelf ?? "mine";
  const missingMedia = m.inputs.some((i) => !i.file && !i.url);
  const failed = ["failed", "moderated", "cancelled"].includes(m.status);
  const fixes: Fix[] = failed ? [
    { label: "Open in studio", run: () => remix(), primary: true },
    ...(!missingMedia && m.status !== "moderated" ? [{ label: "Try again", run: rerun, icon: <Refresh size={13} /> }] : []),
  ] : [];
  const seed = r?.seed ?? (typeof m.params.seed === "number" && (m.params.seed as number) >= 0 ? String(m.params.seed) : null);
  const params = Object.entries(m.params).filter(([k]) => !["seed", "motion_mode"].includes(k));
  const local = m.engine.kind === "local";

  let stage: ReactNode;
  if (hero) stage = <ABPlayer a={source && hero.kind === source.kind ? (source.kind === "image" ? { ...source, poster: null } : source) : null} b={hero} />;
  else if (m.status === "running" && job) stage = <div className="relative flex-1 rounded-lg overflow-hidden bg-deep"><StageRunning job={job} t={t} /></div>;
  else if (failed) stage = <div className="flex-1 rounded-lg bg-deep flex items-center justify-center p-6"><StageError state={m.status} error={job?.error ?? r?.error} detail={job?.detail} fixes={fixes} /></div>;
  else stage = (
    <Empty icon={<Frame size={18} />} title="Recipe only" className="flex-1 rounded-lg bg-deep" action={<Button tone="primary" size="md" onClick={() => remix()}>Open in studio</Button>}>
      This generation carries its recipe but no result. Open it in the studio to run it yourself.
    </Empty>
  );

  return (
    <div className="flex-1 min-h-0 grid xl:grid-cols-[minmax(0,1fr)_340px] max-xl:overflow-y-auto max-xl:scroll-y">
      <section aria-label="Result" className="min-h-0 min-w-0 flex flex-col max-xl:min-h-[min(640px,80vh)]">
        <div className="shrink-0 h-11 px-3 flex items-center gap-1.5 border-b border-line">
          <a href={href({ name: "library", shelf })} className="h-7 pl-1.5 pr-2.5 rounded-md inline-flex items-center gap-1.5 text-sm text-muted hover:text-text hover:bg-white/[0.04]" title="Back (Esc)">
            <ArrowLeft size={14} />Back
          </a>
          <span className="w-px h-4 bg-line mx-1" aria-hidden />
          {job && job.state !== "done" ? <StateBadge job={job} /> : m.status !== "done" && m.status !== "draft" ? <StateBadge job={{ state: m.status, queue_position: null }} /> : null}
          <span className="flex-1" />
          <Button size="sm" tone="primary" onClick={() => remix()} title="Load every input and setting into the studio">Remix</Button>
          <Button size="sm" onClick={rerun} disabled={missingMedia || m.status === "running"} title={missingMedia ? "Some media isn't in this generation. Remix and add your own." : "Same settings, new seed"}><Refresh size={13} />Re-run</Button>
          <Popover.Root open={swap} onOpenChange={setSwap}>
            <Popover.Trigger asChild><Button size="sm" className="max-md:hidden">Swap engine<Chevron size={12} /></Button></Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} className="z-50 w-[320px] p-2 rounded-xl bg-surface shadow-float animate-pop">
                <p className="m-0 px-1 pb-2 text-xs text-muted">Same inputs on another engine. Opens the studio.</p>
                <EngineDropdown mode={m.mode} value={m.engine.model} onChange={(engine) => { setSwap(false); remix({ engine }); }} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Button size="sm" onClick={() => share(m.id)} aria-keyshortcuts="E"><Upload size={13} />Export<Kbd className="ml-0.5 max-md:hidden">E</Kbd></Button>
          <Popover.Root open={more} onOpenChange={setMore}>
            <Popover.Trigger asChild><IconButton label="More actions" tone="ghost"><More size={16} /></IconButton></Popover.Trigger>
            <Popover.Portal>
              <Popover.Content align="end" sideOffset={6} className="z-50 min-w-[220px] p-1 rounded-lg bg-surface shadow-pop animate-pop flex flex-col">
                {m.mode === "motion" && <MenuItem onClick={() => { setMore(false); remix({ dropVideo: true }); }}>Remix with my own video</MenuItem>}
                {local && <MenuItem href={workflowUrl(m.id)} download={`${m.id}.workflow.json`} icon={<Graph size={14} />}>Download ComfyUI workflow</MenuItem>}
                <MenuItem icon={<Copy size={14} />} onClick={() => { navigator.clipboard?.writeText(m.id); setMore(false); toast({ text: "Generation ID copied.", tone: "ok" }); }}>Copy ID</MenuItem>
                <span className="h-px bg-line my-1" aria-hidden />
                <MenuItem danger icon={<Trash size={14} />} onClick={remove}>Move to trash</MenuItem>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
        </div>
        <div className="flex-1 min-h-0 p-3 flex flex-col">{stage}</div>
        {m.inputs.length > 0 && (
          <div className="shrink-0 border-t border-line px-3 py-2 flex items-center gap-2">
            <span className="eyebrow shrink-0 w-14">Inputs</span>
            <ul className="m-0 p-0 list-none flex-1 min-w-0 flex gap-1.5 overflow-x-auto scroll-y pb-0.5">
              {m.inputs.map((i) => {
                const lic = LICENSES.find((l) => l.id === i.license)?.label ?? i.license;
                return (
                  <li key={i.slot} title={`${roleLabel(i.role)} · ${i.slot} · ${lic}${i.contains_person ? " · person" : ""}`}
                    className="relative shrink-0 w-[60px] h-[60px] rounded-md overflow-hidden bg-raised">
                    {i.file ? <img src={fileUrl(m.id, i.slot.startsWith("video:") ? "driving/poster.webp" : i.file)} alt={`${roleLabel(i.role)} input`} className="w-full h-full object-cover" />
                      : i.thumb ? <img src={i.thumb} alt="" className="w-full h-full object-cover opacity-50" /> : null}
                    <span className="glass absolute inset-x-0.5 bottom-0.5 h-4 rounded text-[10px] leading-4 text-center truncate px-0.5">{i.file ? roleLabel(i.role) : "Missing"}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <aside aria-label="Details" className="min-h-0 bg-panel border-l border-line xl:overflow-y-auto scroll-y max-xl:border-l-0 max-xl:border-t">
        <div className="px-4 pt-3.5 pb-3 border-b border-line flex flex-col gap-2">
          <span className="flex items-center gap-1.5"><ModeBadge mode={m.mode} /><KindBadge model={m.engine.model} />{m.variant && <Badge tone="neutral" title={`Imported from a ${m.variant} .illusion`}>Imported</Badge>}</span>
          <EditableTitle value={m.title} onSave={(title) => save({ title })} />
          <span className="text-xs text-faint tabular">{stamp(m.created)} · <span className="font-mono">{m.id.slice(0, 8)}</span></span>
        </div>
        <Section title="Outcome">
          <OutcomeToggle value={m.outcome} onChange={(outcome) => save({ outcome })} />
        </Section>
        <Section title="Prompt" meta={m.prompt ? <CopyButton text={m.prompt} /> : undefined}>
          <p className={cx("m-0 text-sm leading-[1.55] whitespace-pre-wrap break-words", m.prompt ? "text-soft" : "text-faint")}>{m.prompt || "No prompt"}</p>
        </Section>
        <Section title="Run">
          <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
            <Row k="Engine"><span className="font-mono text-xs break-all">{shortModel(m.engine.model)}</span></Row>
            <Row k="Runs on">{local ? "Your ComfyUI" : `Comfy Router${m.engine.provider ? ` · ${m.engine.provider}` : ""}`}</Row>
            {params.map(([k, v]) => <Row key={k} k={k.replace(/_/g, " ")}><span className="font-mono text-xs break-all">{String(v)}</span></Row>)}
            <Row k="Seed"><span className="font-mono text-xs">{seed ?? "Random"}</span></Row>
            <Row k="Time">{r?.elapsed ? elapsed(r.elapsed) : "—"}</Row>
            <Row k="Cost">{local ? "No credits" : r?.cost_reported ? `${r.cost_reported} credits` : "Not reported"}</Row>
          </dl>
        </Section>
        <Lineage m={m} />
        <Section title="Notes">
          <Notes m={m} onSave={(notes) => save({ notes })} />
        </Section>
        <Section title="Tags">
          <Tags tags={m.tags} onSave={(tags) => save({ tags })} />
        </Section>
        <details className="group border-b border-line">
          <summary className="h-10 px-4 flex items-center gap-2 cursor-pointer select-none hover:bg-white/[0.02]">
            <Chevron size={12} className="text-muted -rotate-90 group-open:rotate-0 transition-transform" />
            <span className="eyebrow">{local ? "Workflow JSON" : "Request JSON"}</span>
          </summary>
          <pre className="m-0 mx-4 mb-3.5 rounded-lg bg-deep border border-line p-2.5 font-mono text-xs2 leading-[1.6] text-soft whitespace-pre-wrap break-all max-h-[280px] overflow-auto scroll-y">{JSON.stringify(m.request_template, null, 2)}</pre>
        </details>
      </aside>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return <><dt className="text-muted first-letter:uppercase truncate">{k}</dt><dd className="m-0 min-w-0 text-soft">{children}</dd></>;
}

function MenuItem({ children, onClick, href: to, download, icon, danger }: { children: ReactNode; onClick?: () => void; href?: string; download?: string; icon?: ReactNode; danger?: boolean }) {
  const cls = cx("mk-btn h-8 px-2 rounded-md border-0 bg-transparent text-left text-sm inline-flex items-center gap-2 w-full", danger ? "text-rose-text hover:bg-rose/10" : "text-soft hover:bg-raised hover:text-text");
  const inner = <><span className="w-4 flex justify-center text-muted">{icon}</span>{children}</>;
  return to ? <a href={to} download={download} className={cls}>{inner}</a> : <button type="button" onClick={onClick} className={cls}>{inner}</button>;
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button type="button" onClick={() => navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1400); })}
      className="mk-btn h-5 px-1 rounded border-0 bg-transparent text-xs text-muted hover:text-text inline-flex items-center gap-1">
      {ok ? <Check size={11} className="text-mint" /> : <Copy size={11} />}{ok ? "Copied" : "Copy"}
    </button>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea aria-label="Title" rows={1} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => (v.trim() && v !== value ? onSave(v.trim()) : setV(value))}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } if (e.key === "Escape") { setV(value); (e.target as HTMLTextAreaElement).blur(); } }}
      className="text-lg font-semibold bg-transparent border-0 outline-none resize-none p-1 -m-1 rounded-md w-full leading-[1.3] hover:bg-white/[0.03] focus:bg-white/[0.04]" style={{ fieldSizing: "content" } as React.CSSProperties} />
  );
}

function Notes({ m, onSave }: { m: Manifest; onSave: (v: string) => void }) {
  const [v, setV] = useState(m.notes);
  useEffect(() => setV(m.notes), [m.notes]);
  return (
    <textarea aria-label="Notes" rows={3} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== m.notes && onSave(v)} placeholder="What worked, what to try next"
      className="field w-full px-2.5 py-2 text-sm leading-[1.5] resize-y" />
  );
}

function Tags({ tags, onSave }: { tags: string[]; onSave: (t: string[]) => void }) {
  const [v, setV] = useState("");
  const add = () => {
    const t = v.trim().replace(/^#/, "").toLowerCase();
    if (t && !tags.includes(t)) onSave([...tags, t]);
    setV("");
  };
  return (
    <div className="flex flex-wrap gap-1 items-center">
      {tags.map((t) => (
        <span key={t} className="h-6 pl-2 pr-0.5 rounded-md bg-violet/15 text-violet-lighter text-xs inline-flex items-center gap-0.5">
          #{t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onSave(tags.filter((x) => x !== t))} className="mk-btn w-5 h-5 rounded border-0 bg-transparent text-violet-light hover:text-text flex items-center justify-center"><Close size={8} /></button>
        </span>
      ))}
      <input aria-label="Add tag" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} onBlur={add} placeholder="Add tag"
        className="h-6 w-20 px-1.5 rounded-md border border-dashed border-line2 bg-transparent text-xs outline-none placeholder:text-faint focus:border-violet/60 focus:w-28 transition-[width]" />
    </div>
  );
}

function Lineage({ m }: { m: Manifest }) {
  const links: { label: string; id: string }[] = [];
  if (m.lineage.forked_from) links.push({ label: "Remixed from", id: m.lineage.forked_from });
  for (const c of m.lineage.chain) links.push({ label: "From Edit", id: c.split(":")[1] ?? c });
  for (const c of m.lineage.sent_to) links.push({ label: "Sent to Motion", id: c });
  for (const v of m._variants ?? []) if (v.id !== m.id) links.push({ label: `Variant · ${v.title}`, id: v.id });
  if (!links.length) return null;
  return (
    <Section title="Lineage" meta={String(links.length)}>
      <ul className="m-0 p-0 list-none flex flex-col">
        {links.map((l, i) => (
          <li key={i}>
            <a href={href({ name: "generation", id: l.id })} className="h-8 -mx-1.5 px-1.5 rounded-md flex items-center gap-2 text-sm text-soft hover:bg-white/[0.04] hover:text-text">
              <span className="flex-1 truncate">{l.label}</span>
              <span className="font-mono text-xs2 text-faint">{l.id.slice(0, 8)}</span>
              <Chevron size={11} className="-rotate-90 text-faint" />
            </a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

