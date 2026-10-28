import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ABPlayer, typing } from "../components/ABPlayer";
import { OutcomeToggle } from "../components/bits";
import { EngineDropdown } from "../components/Engine";
import { appRoot, Compare, cx, EmptyBox, gpuName, I, jobProgress, QUEUED, Ring, useStatus } from "../components/oi";
import { StageError, type Fix } from "../components/Studio";
import { tplModel, tplName, useCoverActions } from "../components/TemplateCard";
import { api, fileUrl, workflowUrl, type EngineInfo, type Manifest } from "../lib/api";
import { ago, elapsed, errMsg, roleLabel, shortModel, stamp, LICENSES } from "../lib/format";
import { isActive, useJobs } from "../lib/live";
import { go, href } from "../lib/route";
import { runName } from "../lib/runs";
import { posterOf, useApp } from "../lib/store";

type Mode = "input" | "result" | "compare";

/** One generation, full screen: the picture on the left, everything about it on the right. Arrows step through the Library. */
export function GenerationDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["generation", id], queryFn: () => api.generation(id), retry: false });
  const { data: jobs = [] } = useJobs();
  const job = jobs.find((j) => j.id === id);
  const toast = useApp((s) => s.toast);
  const share = useApp((s) => s.share);
  const loadGeneration = useApp((s) => s.loadGeneration);
  const setStudio = useApp((s) => s.setStudio);
  const libList = useApp((s) => s.libList);
  const templates = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const status = useStatus();
  const [swap, setSwap] = useState(false);
  const [more, setMore] = useState(false);
  const [mode, setMode] = useState<Mode>("compare");
  const m = q.data;
  const firstImage = m?.inputs.find((i) => i.slot === "image:1" && i.file);
  const before = m && firstImage?.file ? fileUrl(m.id, firstImage.file) : null;
  const after = m?.result?.file ? fileUrl(m.id, m.result.file) : null;
  const size = useImageSizeFrom(after ?? before);

  const list = libList.includes(id) ? libList : [id];
  const at = list.indexOf(id);
  const step = (d: number) => { const n = list[at + d]; if (n) go({ name: "generation", id: n }); };
  const back = () => go({ name: "library", shelf: m?._shelf ?? "mine" });

  const step_ = useRef(step);
  step_.current = step;
  const back_ = useRef(back);
  back_.current = back;
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey || document.querySelector("[role=dialog]")) return;
      if (e.key.toLowerCase() === "e" && m) { e.preventDefault(); share(m.id); }
      if (e.key === "ArrowLeft" && !(e.target as HTMLElement)?.closest?.("[role=slider]")) step_.current(-1);
      if (e.key === "ArrowRight" && !(e.target as HTMLElement)?.closest?.("[role=slider]")) step_.current(1);
      if (e.key === "Escape" && !document.querySelector("[data-radix-popper-content-wrapper]")) back_.current();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [m, share]);

  if (q.isLoading) {
    return (
      <div className="viewer" aria-busy="true">
        <div className="v-stage"><div className="v-top"><button className="icon-btn" type="button" aria-label="Back to library" onClick={back}><I n="back" /></button></div>
          <div className="canvas"><div className="frame" style={{ "--ar": 4 / 5 } as CSSProperties}><div className="media" style={{ position: "absolute", inset: 0 }} /></div></div></div>
        <aside className="v-info" />
      </div>
    );
  }
  if (!m) {
    return (
      <div className="page" style={{ display: "grid", placeItems: "center", padding: 24 }}>
        <EmptyBox icon="image" title="Generation not found" action={<button className="btn" type="button" onClick={() => go({ name: "library" })}>Back to library</button>}>
          {q.error ? errMsg(q.error) : "It may have been deleted."} Deleted generations stay in the trash for 7 days.
        </EmptyBox>
      </div>
    );
  }

  const remix = (opts?: { engine?: string; dropVideo?: boolean }) => {
    const md = loadGeneration(m, opts);
    setStudio(md, { current: null, group: [] });
    go({ name: md });
  };
  const rerun = async () => {
    try {
      const { ids } = await api.rerun(m.id);
      setStudio(m.mode, (st) => ({ current: ids[0], group: ids, session: [...ids, ...st.session] }));
      qc.invalidateQueries({ queryKey: ["jobs"] });
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
    const next = list[at + 1] ?? list[at - 1];
    if (next && next !== m.id) go({ name: "generation", id: next });
    else back();
  };

  const r = m.result;
  const tpl = templates.data?.find((e) => e.id === m.engine.model);
  const { name } = runName({ title: m.title, model: m.engine.model, prompt: m.prompt }, templates.data);
  const video = m.inputs.find((i) => i.slot.startsWith("video:"));
  const isVideo = !!after && (r?.kind ?? "image") === "video";
  const live = !!job && isActive(job);
  const failed = !live && ["failed", "moderated", "cancelled"].includes(m.status);
  const missingMedia = m.inputs.some((i) => !i.file && !i.url);
  const fixes: Fix[] = failed ? [
    { label: "Open in Create", run: () => remix(), primary: true },
    ...(!missingMedia && m.status !== "moderated" ? [{ label: "Try again", run: rerun }] : []),
  ] : [];
  const seed = r?.seed ?? (typeof m.params.seed === "number" && (m.params.seed as number) >= 0 ? String(m.params.seed) : null);
  const params = Object.entries(m.params).filter(([k]) => !["seed", "motion_mode"].includes(k));
  const local = m.engine.kind === "local";
  const ar =size ? size.w / size.h : 4 / 5;
  const eff: Mode = !before ? "result" : mode;

  let stage: ReactNode;
  if (after && isVideo) {
    const src = video?.file ? { kind: "video" as const, src: fileUrl(m.id, video.file), poster: fileUrl(m.id, posterOf(video.file)), label: "Source" } : null;
    stage = <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: "0 16px 16px" }}><ABPlayer a={src} b={{ kind: "video", src: after, poster: r?.poster ? fileUrl(m.id, r.poster) : null, label: "Result" }} /></div>;
  } else {
    let inner: ReactNode;
    if (after) inner = eff === "compare" && before ? <Compare before={before} after={after} lb="Input" la="Result" /> : <img src={eff === "input" && before ? before : after} alt={eff === "input" ? "Input" : "Result"} className={eff === "input" && before ? undefined : "alpha"} />;
    else if (live) {
      const qd = QUEUED.has(job!.state);
      const p = jobProgress(job);
      inner = (
        <>
          {(job!.preview ?? before) && <img src={job!.preview ?? before!} alt="" style={qd || !job!.preview ? { filter: "blur(8px) saturate(.3) brightness(.55)" } : undefined} />}
          <div className="noise" />
          <div className="hud"><div className="hud-in"><Ring p={p} /><b>{qd ? "Waiting in queue" : "Sampling"}</b>
            <span>{qd ? "starts after the current run" : job!.progress?.step && job!.progress.steps ? `step ${job!.progress.step}/${job!.progress.steps}` : job!.detail || "starting"}</span></div></div>
        </>
      );
    } else if (failed) {
      inner = (
        <>
          {before && <img src={before} alt="" style={{ filter: "saturate(.3) brightness(.4)" }} />}
          <div style={{ position: "absolute", inset: 0, zIndex: 3, display: "grid", placeItems: "center", padding: 16, overflow: "auto" }}>
            <StageError state={m.status} error={job?.error ?? r?.error} detail={job?.detail} fixes={fixes} compact />
          </div>
        </>
      );
    } else {
      inner = (
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
          <EmptyBox icon="layers" title="Recipe only" action={<button className="btn primary" type="button" onClick={() => remix()}>Open in Create</button>}>This generation carries its recipe but no result. Run it yourself.</EmptyBox>
        </div>
      );
    }
    stage = <div className="canvas"><div className={cx("frame", live && "live")} style={{ "--ar": ar, "--p": jobProgress(job) } as CSSProperties}>{inner}</div></div>;
  }

  const statusLine = live ? <span className="pill"><i className="dot" style={{ background: "var(--yellow)", animation: "pulse 1.2s infinite" }} />{QUEUED.has(job!.state) ? "Queued" : "Running"}</span>
    : failed ? <span className="pill rose">{m.status === "moderated" ? "Moderated" : m.status === "cancelled" ? "Cancelled" : "Failed"}</span>
    : m.status === "done" ? <span className="pill" style={{ background: "rgba(95,211,154,.14)", color: "var(--mint)" }}><I n="check" />Done</span> : null;

  return (
    <div className="viewer" role="region" aria-label={name}>
      <div className="v-stage">
        <div className="v-top">
          <button className="icon-btn" type="button" aria-label="Back to library" title="Back (Esc)" onClick={back}><I n="back" /></button>
          <div className="t"><b>{name}</b>{tpl && name !== tplName(tpl) ? ` · ${tplName(tpl)}` : ""}{size ? <> · <span className="mono">{size.w}×{size.h}</span></> : null}</div>
          {list.length > 1 && <span className="mono hint">{at + 1} / {list.length}</span>}
          <button className="icon-btn" type="button" aria-label="Previous" disabled={at <= 0} style={at <= 0 ? { opacity: 0.3 } : undefined} onClick={() => step(-1)}><I n="left" /></button>
          <button className="icon-btn" type="button" aria-label="Next" disabled={at >= list.length - 1} style={at >= list.length - 1 ? { opacity: 0.3 } : undefined} onClick={() => step(1)}><I n="right" /></button>
        </div>
        {stage}
        <div className="v-modes">
          {after && !isVideo && before && (
            <div className="seg" role="group" aria-label="View">
              <button type="button" aria-pressed={eff === "input"} onClick={() => setMode("input")}>Input</button>
              <button type="button" aria-pressed={eff === "result"} onClick={() => setMode("result")}>Result</button>
              <button type="button" aria-pressed={eff === "compare"} onClick={() => setMode("compare")}><I n="compare" />Compare</button>
            </div>
          )}
        </div>
      </div>

      <aside className="v-info" aria-label="Details">
        <div className="v-body">
          <div className="v-title">
            <EditableTitle value={name} onSave={(title) => save({ title })} />
            <div className="v-status">
              {statusLine}<span title={stamp(m.created)}>{ago(m.created)}</span>
              {r?.elapsed ? <span className="mono">{elapsed(r.elapsed)}</span> : null}
              <span>· {local ? gpuName(status.data?.local.gpu) ?? "Your ComfyUI" : `Comfy Router${m.engine.provider ? ` · ${m.engine.provider}` : ""}`}</span>
              {m.variant && <span className="pill" title={`Imported from a ${m.variant} .illusion`}>Imported</span>}
            </div>
          </div>

          <div className="kv">
            <div className="kv-h">Outcome</div>
            <OutcomeToggle value={m.outcome} onChange={(outcome) => save({ outcome })} />
          </div>

          <div className="kv">
            <div className="kv-h">{tpl?.prompt?.label ?? "Prompt"}{m.prompt && <CopyButton text={m.prompt} />}</div>
            <div className="quote">{m.prompt || <span style={{ color: "var(--text-3)" }}>No prompt</span>}</div>
          </div>

          <div className="kv">
            <div className="kv-h">Template</div>
            {tpl ? (
              <a className="tplrow" href={href({ name: "explore", t: tpl.id })}>
                {tpl.cover ? <img src={tpl.cover} alt="" /> : <span className="empty-ic" style={{ width: 40, height: 40, margin: 0, borderRadius: 9 }}><I n="image" /></span>}
                <div><b>{tplName(tpl)}</b><span>{tplModel(tpl)} · {tpl.kind === "local" ? "Local" : "Cloud"}</span></div><I n="right" />
              </a>
            ) : <div className="tplrow"><div><b className="mono" style={{ fontSize: 12 }}>{shortModel(m.engine.model)}</b><span>{local ? "Local" : "Cloud"} · not installed here</span></div></div>}
          </div>

          {m.inputs.length > 0 && (
            <div className="kv">
              <div className="kv-h">Inputs</div>
              <div style={{ display: "grid", gap: 8 }}>
                {m.inputs.map((i) => {
                  const lic = LICENSES.find((l) => l.id === i.license)?.label ?? i.license;
                  const src = i.file ? fileUrl(m.id, i.slot.startsWith("video:") ? posterOf(i.file) : i.file) : i.thumb;
                  return (
                    <div key={i.slot} className="inrow" title={`${i.slot} · ${lic}${i.contains_person ? " · person" : ""}`}>
                      {src ? <img src={src} alt="" style={i.file ? undefined : { opacity: 0.5 }} /> : <span className="empty-ic" style={{ width: 44, height: 44, margin: 0, borderRadius: 9 }}><I n="image" /></span>}
                      <div><b>{tpl?.inputs?.find((x) => x.slot === i.slot)?.label ?? slotLabel(i.slot, i.role)}</b><span>{i.file ? (i.license === "stock" ? "Sample" : i.license === "generated" ? "Generated" : "Your file") : "Missing from this file"}{i.width && i.height ? ` · ${i.width}×${i.height}` : ""}</span></div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="kv">
            <div className="kv-h">Settings</div>
            <dl className="dl">
              {params.map(([k, v]) => <div key={k}><dt style={{ textTransform: "capitalize" }}>{k.replace(/_/g, " ")}</dt><dd style={{ overflowWrap: "anywhere" }}>{String(v)}</dd></div>)}
              <div><dt>Seed</dt><dd>{seed ?? "Random"}</dd></div>
            </dl>
          </div>

          <Lineage m={m} />

          <div className="kv">
            <div className="kv-h">Tags</div>
            <Tags tags={m.tags} onSave={(tags) => save({ tags })} />
          </div>
          <div className="kv">
            <div className="kv-h"><label htmlFor="vnotes">Notes</label></div>
            <Notes m={m} onSave={(notes) => save({ notes })} />
          </div>

          <details className="help">
            <summary style={{ cursor: "pointer" }}>{local ? "Workflow JSON" : "Request JSON"} · <span className="mono">{m.id.slice(0, 8)}</span></summary>
            <pre className="mono" style={{ margin: "8px 0 0", padding: 10, borderRadius: 10, background: "var(--field)", border: "1px solid var(--line)", fontSize: 11, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 280, overflow: "auto" }}>{JSON.stringify(m.request_template, null, 2)}</pre>
          </details>
        </div>

        <div className="v-actions">
          <button className="btn primary" type="button" onClick={() => remix()} title="Load every input and setting into Create"><I n="remix" />Remix</button>
          <button className="btn" type="button" onClick={rerun} disabled={missingMedia || live} title={missingMedia ? "Some media isn't in this generation. Remix and add your own." : "Same settings, new seed"}><I n="refresh" />Re-run</button>
          <button className="icon-btn" type="button" aria-label="Export" title="Export (E)" onClick={() => share(m.id)} disabled={m.status !== "done"}><I n="share" /></button>
          <Popover.Root open={swap} onOpenChange={setSwap}>
            <Popover.Trigger asChild><button className="icon-btn" type="button" aria-label="Swap engine" title="Same inputs on another engine"><I n="cpu" /></button></Popover.Trigger>
            <Popover.Portal container={appRoot()}>
              <Popover.Content align="end" side="top" sideOffset={8} className="pop swap-pop">
                <p className="help">Same inputs on another engine. Opens Create.</p>
                <EngineDropdown mode={m.mode} value={m.engine.model} onChange={(engine) => { setSwap(false); remix({ engine }); }} />
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <button className="icon-btn" type="button" aria-label="More actions" aria-expanded={more} onClick={() => setMore(!more)}><I n="more" /></button>
          {more && <MoreMenu close={() => setMore(false)}>
            <button role="menuitem" type="button" onClick={() => { setMore(false); void save({ starred: !m.starred }); }}><I n="star" />{m.starred ? "Unstar" : "Star"}</button>
            {m.mode === "motion" && <button role="menuitem" type="button" onClick={() => { setMore(false); remix({ dropVideo: true }); }}><I n="film" />Remix with my own video</button>}
            {local && <a role="menuitem" className="mitem" href={workflowUrl(m.id)} download={`${m.id}.workflow.json`} onClick={() => setMore(false)}><I n="graph" />Download ComfyUI workflow</a>}
            {tpl && m.status === "done" && <CoverItem e={tpl} run={m.id} close={() => setMore(false)} />}
            <button role="menuitem" type="button" onClick={() => { navigator.clipboard?.writeText(m.id); setMore(false); toast({ text: "Generation ID copied.", tone: "ok" }); }}><I n="copy" />Copy generation ID</button>
            <hr />
            <button role="menuitem" className="danger" type="button" onClick={remove}><I n="trash" />Move to trash</button>
          </MoreMenu>}
        </div>
      </aside>
    </div>
  );
}

/** "image:2" reads "Image 2"; a free-form tray falls back to its role. */
function slotLabel(slot: string, role: string) {
  const [kind, n] = slot.split(":");
  return n && /^(image|video|audio)$/.test(kind) ? `${kind[0].toUpperCase()}${kind.slice(1)} ${n}` : roleLabel(role);
}

function MoreMenu({ close, children }: { close: () => void; children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: PointerEvent) => { if (!el.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('[aria-label="More actions"]')) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    window.addEventListener("pointerdown", on);
    window.addEventListener("keydown", key, true);
    return () => { window.removeEventListener("pointerdown", on); window.removeEventListener("keydown", key, true); };
  }, [close]);
  return <div ref={el} className="menu" role="menu">{children}</div>;
}

/** Pixel size of the picture on the stage, once it loads. */
function useImageSizeFrom(url: string | null) {
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url) return;
    let live = true;
    const img = new Image();
    img.onload = () => { if (live && img.naturalWidth) setSize({ url, w: img.naturalWidth, h: img.naturalHeight }); };
    img.src = url;
    return () => { live = false; };
  }, [url]);
  return size && size.url === url ? size : null;
}

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button className="btn sm ghost" type="button" style={{ height: 24, marginTop: -6, marginBottom: -6 }} onClick={() => navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1400); })}>
      <I n={ok ? "check" : "copy"} />{ok ? "Copied" : "Copy"}
    </button>
  );
}

function EditableTitle({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <>
      <label className="sr" htmlFor="vtitle">Title</label>
      <input id="vtitle" value={v} onChange={(e) => setV(e.target.value)} onBlur={() => (v.trim() && v !== value ? onSave(v.trim()) : setV(value))}
        onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { e.stopPropagation(); setV(value); (e.target as HTMLInputElement).blur(); } }} />
    </>
  );
}

function Notes({ m, onSave }: { m: Manifest; onSave: (v: string) => void }) {
  const [v, setV] = useState(m.notes);
  useEffect(() => setV(m.notes), [m.notes]);
  return <textarea className="textarea" id="vnotes" rows={3} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => v !== m.notes && onSave(v)} placeholder="What worked, what to try next" />;
}

function Tags({ tags, onSave }: { tags: string[]; onSave: (t: string[]) => void }) {
  const [v, setV] = useState("");
  const add = () => {
    const t = v.trim().replace(/^#/, "").toLowerCase();
    if (t && !tags.includes(t)) onSave([...tags, t]);
    setV("");
  };
  return (
    <div className="tags">
      {tags.map((t) => (
        <span key={t} className="tag" style={{ display: "inline-flex", alignItems: "center", gap: 2, paddingRight: 3 }}>
          {t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onSave(tags.filter((x) => x !== t))} style={{ width: 16, height: 16, display: "grid", placeItems: "center", borderRadius: 4 }}><I n="x" style={{ width: 10, height: 10 }} /></button>
        </span>
      ))}
      <input className="input" aria-label="Add tag" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }} onBlur={add}
        placeholder="Add tag" style={{ height: 26, width: 110, fontSize: 12, borderRadius: 8, padding: "0 8px" }} />
    </div>
  );
}

function Lineage({ m }: { m: Manifest }) {
  const links: { label: string; id: string }[] = [];
  if (m.lineage.forked_from) links.push({ label: "Remixed from", id: m.lineage.forked_from });
  for (const c of m.lineage.chain) links.push({ label: "From an image run", id: c.split(":")[1] ?? c });
  for (const c of m.lineage.sent_to) links.push({ label: "Sent to Video", id: c });
  for (const v of m._variants ?? []) if (v.id !== m.id) links.push({ label: `Variant · ${v.title}`, id: v.id });
  if (!links.length) return null;
  return (
    <div className="kv">
      <div className="kv-h">Lineage<span>{links.length}</span></div>
      <div style={{ display: "grid", gap: 4 }}>
        {links.map((l, i) => (
          <a key={i} className="tplrow" href={href({ name: "generation", id: l.id })} style={{ padding: "8px 10px" }}>
            <div><b>{l.label}</b><span className="mono">{l.id.slice(0, 8)}</span></div><I n="right" />
          </a>
        ))}
      </div>
    </div>
  );
}

/** "Use as template cover": this result becomes the template's cover. */
function CoverItem({ e, run, close }: { e: EngineInfo; run: string; close: () => void }) {
  const { busy, fromRun } = useCoverActions(e);
  return (
    <button role="menuitem" type="button" disabled={busy} onClick={async () => { if (await fromRun(run)) close(); }}>
      <I n="image" />Use as template cover
    </button>
  );
}
