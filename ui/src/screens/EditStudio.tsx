import { useQueries } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ABPlayer, typing } from "../components/ABPlayer";
import { useEngine } from "../components/Engine";
import { ArrowRight, Brush, External, Refresh, Star, Upload } from "../components/Icons";
import { RegionCanvas } from "../components/RegionCanvas";
import { addToTray, RefTray, useUploader } from "../components/Refs";
import {
  ActionBar, EmptyStage, EngineCard, invalidFields, OutcomeBar, PromptCard, RawRequest, RunCard, RunStatus, SessionStrip, StageBar, StageError,
  StageRunning, StudioLayout, useCompose, useCurrent, useStudio, type Fix,
} from "../components/Studio";
import { Badge, Button, Kbd, Section, Segmented, cx } from "../components/ui";
import { StateBadge } from "../components/bits";
import { api, fileUrl, type Manifest } from "../lib/api";
import { EDIT_ROLES, errMsg, roleLabel } from "../lib/format";
import { useElapsed, useJobs } from "../lib/live";
import { go } from "../lib/route";
import { newKey, useApp, type RefSlot } from "../lib/store";
import { engineBoxes } from "../lib/boxes";

export function EditStudio() {
  const [s, set] = useStudio("edit");
  const engine = useEngine("edit", s.engine);
  const { spec, compose, estimate } = useCompose("edit", s, engine);
  const { generation: m, job, elapsed } = useCurrent(s.current);
  const invalid = invalidFields(compose, job?.error);
  const share = useApp((st) => st.share);
  const toast = useApp((st) => st.toast);
  const setStudio = useApp((st) => st.setStudio);
  const { data: jobs = [] } = useJobs();
  const [view, setView] = useState<"canvas" | "result">("canvas");
  const { upload, busy } = useUploader();

  const base = s.refs[0];
  const group = s.group.length ? s.group : s.current ? [s.current] : [];
  const variants = useQueries({ queries: group.map((id) => ({ queryKey: ["generation", id], queryFn: () => api.generation(id), retry: false })) });
  const vlist = variants.map((q) => q.data).filter(Boolean) as Manifest[];
  const anyDone = vlist.some((v) => v.status === "done");
  const shown = vlist.find((v) => v.id === s.current) ?? vlist[0];
  const shownJob = shown ? jobs.find((j) => j.id === shown.id) : undefined;
  const shownT = useElapsed(shownJob?.started ?? shownJob?.created, shownJob?.finished);
  const running = vlist.some((v) => v.status === "running");

  useEffect(() => {
    if (job && job.state === "done") setView("result");
  }, [job?.state]);

  const star = (id: string) => set((st) => ({ selected: st.selected.includes(id) ? st.selected.filter((x) => x !== id) : [...st.selected, id] }));

  const sendToMotion = () => {
    const picks = (s.selected.length ? s.selected : s.current ? [s.current] : []).map((id) => vlist.find((v) => v.id === id)).filter((v): v is Manifest => !!v && v.status === "done" && !!v.result?.file);
    if (!picks.length) return toast({ text: "Star a finished variant first.", tone: "warn" });
    const role = s.returnRole ?? "character";
    setStudio("motion", (mo) => {
      const add: RefSlot[] = picks.map((v) => ({
        key: newKey(), asset: `gen:${v.id}/${v.result!.file}`, name: `${v.title}.webp`, kind: "image", url: fileUrl(v.id, v.result!.file!),
        role, license: "generated", contains_person: base?.contains_person ?? false, consent: base?.consent ?? false,
      }));
      return { refs: [...mo.refs, ...add].slice(0, 9), chain: [...new Set([...mo.chain, ...picks.map((v) => `edit:${v.id}`)])], current: null };
    });
    set({ returnRole: null });
    toast({ text: `${picks.length} image${picks.length > 1 ? "s" : ""} sent to Motion as ${roleLabel(role)}.`, tone: "ok", action: { label: "Open Motion", run: () => go({ name: "motion" }) } });
  };

  const rerun = async (id: string) => {
    try {
      const { ids } = await api.rerun(id);
      set((st) => ({ current: ids[0], group: ids, session: [...ids, ...st.session] }));
      setView("result");
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() === "e" && m?.status === "done") { e.preventDefault(); share(m.id); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [m, share]);

  const boxJson = engineBoxes(s.boxes);
  const nBoxes = s.boxes.filter((b) => b.label.trim()).length;
  const pickImage = () => document.querySelector<HTMLButtonElement>('[aria-label="Add reference image"]')?.click();

  // Failure on the shown variant: plain words plus the fixes the engine suggested.
  const failed = shown && ["failed", "moderated", "cancelled"].includes(shown.status) ? shown : null;
  const fixes: Fix[] = [];
  if (failed) {
    const suggested = shownJob?.fixes ?? [];
    if (suggested.includes("smaller") || /memory/i.test(String(shownJob?.detail ?? failed.result?.error?.message ?? ""))) {
      const size = engine?.params.find((p) => /^(size|resolution|megapixels|width)$/.test(p.key));
      if (size) fixes.push({ label: "Use a smaller size", run: () => { const opts = size.options ?? []; const i = opts.indexOf(String(s.params[size.key] ?? size.default)); if (opts.length && i > 0) { set((st) => ({ params: { ...st.params, [size.key]: opts[i - 1] }, raw: null })); toast({ text: `${size.label} set to ${opts[i - 1]}. Press Run.`, tone: "ok" }); } else if (size.type === "int") { set((st) => ({ params: { ...st.params, [size.key]: size.min ?? size.default }, raw: null })); } } });
    }
    if (suggested.includes("rerun") || failed.status !== "cancelled") fixes.push({ label: "Try again", run: () => rerun(failed.id), primary: true, icon: <Refresh size={13} /> });
  }

  const stage = !base ? (
    <EmptyStage icon={<Brush size={20} />} title="Add an image to edit" onPick={pickImage} onDrop={async (files) => addToTray("edit", await upload(files.slice(0, engine?.max_images ?? 10), "image"))} busy={!!busy}
      meta="PNG, JPEG or WebP · up to 16 MP · 20 MB">
      Click or drop an image. The first image in the tray is the canvas; draw boxes on it to point at what should change.
    </EmptyStage>
  ) : view === "canvas" || !shown ? (
    <RegionCanvas src={base.url} natural={{ width: base.width, height: base.height }} boxes={s.boxes} onChange={(boxes) => set({ boxes })} />
  ) : (
    <ABPlayer
      a={{ kind: "image", src: base.url, label: "Before" }}
      b={shown.status === "done" && shown.result?.file ? { kind: "image", src: fileUrl(shown.id, shown.result.file), label: "After", badge: shown.result.seed != null ? <Badge tone="glass" className="font-mono">seed {shown.result.seed}</Badge> : undefined } : { kind: "image", src: null, label: "After" }}
      overlay={
        shown.status === "running" && shownJob ? <StageRunning job={shownJob} t={shownT} compact={group.length > 1} />
        : failed ? <div className="absolute inset-0 flex items-center justify-center p-4 bg-deep/70"><StageError state={failed.status} error={shownJob?.error ?? failed.result?.error} detail={shownJob?.detail} fixes={fixes} compact /></div>
        : undefined
      }
    />
  );

  return (
    <StudioLayout
      left={
        <>
          <Section title="Images" meta={`${s.refs.length} / ${engine?.max_images ?? 10}`} data-own-drop>
            <RefTray refs={s.refs} max={engine?.max_images ?? 10} roles={EDIT_ROLES} defaultRole="base" aspect="1 / 1" onChange={(refs) => set({ refs })} />
            <p className="m-0 mt-2 text-xs text-faint">First image is the canvas. Drag to reorder.</p>
          </Section>
          <PromptCard mode="edit" s={s} set={set} label={engine?.prompt?.label ?? "Instruction"} hint={engine?.prompt?.hint} invalid={invalid.has("prompt")}>
            {boxJson && (
              <details className="group rounded-md border border-line">
                <summary className="h-7 px-2 flex items-center gap-1.5 cursor-pointer text-xs text-muted hover:text-soft select-none">
                  {nBoxes} region{nBoxes === 1 ? "" : "s"} appended as JSON
                </summary>
                <pre className="m-0 px-2 pb-2 font-mono text-xs2 leading-[1.6] text-soft whitespace-pre-wrap break-all">{boxJson}</pre>
              </details>
            )}
          </PromptCard>
        </>
      }
      center={
        <>
          <StageBar s={s} set={set}>
            <RunStatus m={m} job={job} t={elapsed} />
            {(anyDone || running || !!failed) && base && (
              <Segmented label="Stage view" size="sm" value={view === "canvas" ? "Canvas" : "Result"} options={["Canvas", "Result"] as const} onChange={(v) => setView(v === "Canvas" ? "canvas" : "result")} cols={2} className="w-[150px] shrink-0" />
            )}
          </StageBar>
          <div className="flex-1 min-h-0 p-3 flex flex-col gap-2">
            {stage}
            {group.length > 1 && (
              <div role="listbox" aria-label="Variants" className="shrink-0 flex gap-1.5 overflow-x-auto">
                {group.map((id, i) => {
                  const v = vlist.find((x) => x.id === id);
                  const j = jobs.find((x) => x.id === id);
                  const on = s.current === id;
                  const starred = s.selected.includes(id);
                  const done = v?.status === "done" && v.result?.poster;
                  return (
                    <div key={id} role="option" aria-selected={on} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); set({ current: id }); setView("result"); } }}
                      onClick={() => { set({ current: id }); setView("result"); }}
                      className={cx("relative shrink-0 w-[92px] h-[92px] rounded-md overflow-hidden bg-raised cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-violet", on ? "ring-2 ring-text ring-offset-1 ring-offset-bg" : "opacity-85 hover:opacity-100")}>
                      {done ? <img src={fileUrl(v!.id, v!.result!.poster!)} alt={`Variant ${i + 1}`} className="w-full h-full object-cover" /> : <div className={cx("w-full h-full", v?.status === "running" && "stage-shimmer")} />}
                      <span className="glass absolute left-1 top-1 h-4 px-1 rounded text-[10px] font-mono leading-4">v{i + 1}</span>
                      {j && j.state !== "done" && <span className="absolute left-1 bottom-1 scale-90 origin-bottom-left"><StateBadge job={j} /></span>}
                      {done && (
                        <button type="button" aria-pressed={starred} aria-label={starred ? `Unstar variant ${i + 1}` : `Star variant ${i + 1}`} onClick={(e) => { e.stopPropagation(); star(id); }}
                          className={cx("mk-btn absolute right-1 top-1 w-6 h-6 rounded-md border-0 flex items-center justify-center", starred ? "bg-yellow text-ink" : "glass text-text")}>
                          <Star size={12} filled={starred} />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {m && m.status === "done" && (
            <ActionBar>
              <OutcomeBar m={m} />
              <span className="w-px h-5 bg-line mx-1 max-md:hidden" aria-hidden />
              <Button size="sm" onClick={() => rerun(m.id)}><Refresh size={13} />Re-run</Button>
              <Button size="sm" onClick={() => { useApp.getState().loadGeneration(m); set({ current: null, group: [] }); setView("canvas"); toast({ text: "Loaded into a new draft. Change anything, then Run.", tone: "ok" }); }}>Remix</Button>
              <Button size="sm" tone="ghost" onClick={() => go({ name: "generation", id: m.id })}><External size={13} />Open</Button>
              <Button size="sm" tone="contrast" onClick={() => share(m.id)} aria-keyshortcuts="E"><Upload size={13} />Export<Kbd className="ml-0.5">E</Kbd></Button>
            </ActionBar>
          )}
          <SessionStrip mode="edit" s={s} set={set} onPick={(id) => { set({ group: [id] }); setView("result"); }} />
        </>
      }
      right={
        <>
          <EngineCard mode="edit" s={s} set={set} engine={engine} invalid={invalid} />
          <Section title="Variants" meta="Run in parallel">
            <Segmented label="Variants" value={s.variants} options={[1, 2, 3, 4] as const} onChange={(variants) => set({ variants })} cols={4} />
          </Section>
          <RawRequest s={s} set={set} spec={spec} compose={compose} />
        </>
      }
      run={
        <RunCard mode="edit" s={s} set={set} spec={spec} compose={compose} estimate={estimate} times={s.variants}
          label={s.variants > 1 ? `Run ${s.variants} variants` : "Run edit"}
          onRan={(ids) => { set({ group: ids }); setView("result"); }}
          extra={anyDone && (
            <Button size="md" tone="ghost" className="w-full justify-between" onClick={sendToMotion} title={`Lands in Motion's tray as ${roleLabel(s.returnRole ?? "character")}. Lineage is kept on both.`}>
              <span>{s.selected.length ? `Send ${s.selected.length} starred to Motion` : "Send result to Motion"}</span><ArrowRight size={14} />
            </Button>
          )}
        />
      }
    />
  );
}
