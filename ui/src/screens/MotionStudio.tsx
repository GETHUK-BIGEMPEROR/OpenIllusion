import { useQueryClient } from "@tanstack/react-query";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState } from "react";
import { ABPlayer, typing } from "../components/ABPlayer";
import { EngineDropdown, useEngine } from "../components/Engine";
import { Brush, Close, External, Motion as MotionIcon, Refresh, Sliders as SettingsIcon, Upload } from "../components/Icons";
import { RefTray, useUploader } from "../components/Refs";
import {
  ActionBar, EmptyStage, EngineCard, invalidFields, OutcomeBar, PromptCard, RawRequest, RunCard, RunStatus, SessionStrip, StageBar, StageError,
  StageRunning, StudioLayout, useCompose, useCurrent, useStudio, type Fix,
} from "../components/Studio";
import { Badge, Button, IconButton, Kbd, Section, Segmented, Spinner, TextInput, cx } from "../components/ui";
import { Trimmer } from "../components/Trimmer";
import { api, fileUrl } from "../lib/api";
import { errMsg, ROLES } from "../lib/format";
import { go } from "../lib/route";
import { newKey, useApp, type VideoSlot } from "../lib/store";

export function MotionStudio() {
  const [s, set] = useStudio("motion");
  const engine = useEngine("motion", s.engine);
  const { spec, compose, estimate } = useCompose("motion", s, engine);
  const { generation: m, job, elapsed } = useCurrent(s.current);
  const invalid = invalidFields(compose, job?.error);
  const toast = useApp((st) => st.toast);
  const share = useApp((st) => st.share);
  const loadGeneration = useApp((st) => st.loadGeneration);
  const setStudio = useApp((st) => st.setStudio);
  const qc = useQueryClient();
  const { upload, busy } = useUploader();
  const file = useRef<HTMLInputElement>(null);
  const [swapOpen, setSwapOpen] = useState(false);
  const win = engine?.video_window ?? null;
  const noVideo = engine?.kind === "local" && !engine.needs_video;

  const setVideo = async (files: File[]) => {
    const [a] = await upload(files.slice(0, 1), "video");
    if (!a) return;
    const d = a.duration ?? 0;
    const end = win ? Math.min(d, win[1]) : d;
    set({ video: { ...a, trim: [0, end], license: "own-footage", contains_person: true, consent: false } as VideoSlot, current: null });
  };

  const editFrame = async () => {
    if (!s.video) return;
    try {
      const a = await api.frame(s.video.asset, s.video.trim[0] + 0.04);
      setStudio("edit", (e) => ({
        refs: [{ ...a, key: newKey(), role: "base", license: "own-footage", contains_person: s.video!.contains_person, consent: s.video!.consent }, ...e.refs.filter((r) => r.role !== "base")].slice(0, 10),
        current: null, boxes: [], chain: [], forked_from: null, title: "",
        returnRole: "style",
      }));
      go({ name: "edit" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };

  const rerun = async (id: string) => {
    try {
      const { ids } = await api.rerun(id);
      set((st) => ({ current: ids[0], session: [...ids, ...st.session] }));
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };

  // Stage: the current generation's driving video against its result, or the clip on its own.
  const done = m?.status === "done" && m.result?.file;
  const srcSide = m?.inputs.some((i) => i.slot === "video:1" && i.file)
    ? { kind: "video" as const, src: fileUrl(m.id, "driving/driving.mp4"), poster: fileUrl(m.id, "driving/poster.webp"), label: "Source" }
    : s.video && !noVideo ? { kind: "video" as const, src: s.video.url, poster: s.video.poster, label: "Source" }
    : m?.inputs.find((i) => i.slot === "image:1" && i.file) ? { kind: "image" as const, src: fileUrl(m.id, m.inputs.find((i) => i.slot === "image:1")!.file!), poster: null, label: "Image 1" }
    : noVideo && s.refs[0] && !s.refs[0].missing ? { kind: "image" as const, src: s.refs[0].url, poster: null, label: "Image 1" } : null;
  const running = !!job && !["done", "failed", "moderated", "cancelled"].includes(job.state);
  const failedState = job && ["failed", "moderated", "cancelled"].includes(job.state) ? job.state : m && ["failed", "moderated", "cancelled"].includes(m.status) ? m.status : null;
  const resSide = done
    ? { kind: (m!.result!.kind ?? "video") as "video" | "image", src: fileUrl(m!.id, m!.result!.file!), poster: m!.result!.poster ? fileUrl(m!.id, m!.result!.poster) : null, label: "Result",
        badge: m!.result!.seed != null ? <Badge tone="glass" className="font-mono">seed {m!.result!.seed}</Badge> : undefined }
    : running || failedState ? { kind: "image" as const, src: null, poster: null, label: "Result" } : null;

  const fixes: Fix[] = [];
  if (failedState && m) {
    const f = job?.fixes ?? [];
    if (f.includes("trim") && s.video) fixes.push({ label: "Trim to 10 s", run: () => set({ video: { ...s.video!, trim: [s.video!.trim[0], s.video!.trim[0] + Math.min(10, s.video!.trim[1] - s.video!.trim[0])] } }) });
    if (f.includes("downscale") && s.video) fixes.push({ label: "Downscale to 720p", run: () => { set({ video: { ...s.video!, maxHeight: 720 } }); toast({ text: "The driving clip is re-encoded at 720p on the next run.", tone: "ok" }); } });
    if (f.includes("edit") || f.includes("check")) fixes.push({ label: "Settings", run: () => go({ name: "settings" }), icon: <SettingsIcon size={13} /> });
    if (failedState !== "moderated") fixes.push({ label: "Try again", run: () => rerun(m.id), primary: true, icon: <Refresh size={13} /> });
  }

  const overlay = running && job ? <StageRunning job={job} t={elapsed} />
    : failedState ? <div className="absolute inset-0 flex items-center justify-center p-4 bg-deep/70"><StageError state={failedState} error={job?.error ?? m?.result?.error} detail={job?.detail} fixes={fixes} /></div>
    : undefined;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (typing(e) || e.metaKey || e.ctrlKey) return;
      if (e.key.toLowerCase() === "e" && done) { e.preventDefault(); share(m!.id); }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [done, m, share]);

  const swapMode = (s.params.motion_mode as string) ?? "recast";
  const stage = srcSide || resSide ? (
    <ABPlayer a={srcSide} b={resSide} overlay={overlay} />
  ) : noVideo ? (
    <EmptyStage icon={<MotionIcon size={20} />} title="Add Image 1">
      {engine?.label} turns one image into a clip on your own GPU. Add it under References, describe the motion, then Run.
    </EmptyStage>
  ) : (
    <EmptyStage icon={<MotionIcon size={20} />} title="Drop a driving video" onPick={() => file.current?.click()} onDrop={setVideo} busy={!!busy}
      meta={win ? `${win[0]}–${win[1]} s · 24–60 fps · re-encoded to H.264 under Router's 100 MiB limit` : undefined}>
      Its motion, camera and timing are kept. Add 1–{engine?.max_images ?? 9} references for the new cast, location or look.
    </EmptyStage>
  );

  return (
    <StudioLayout
      left={
        <>
          {noVideo ? (
            <Section title="Driving video">
              <p className="m-0 text-sm text-muted">{engine?.label} animates Image 1 from your prompt. Pick a cloud engine to drive motion from a clip.</p>
            </Section>
          ) : (
            <Section title="Driving video" meta={s.video ? <span className="font-mono">{s.video.duration ? `${s.video.duration.toFixed(1)} s` : ""}</span> : undefined}
              data-own-drop onDragOver={(e) => e.preventDefault()} onDrop={(e) => { if (e.dataTransfer.files.length) { e.preventDefault(); setVideo([...e.dataTransfer.files]); } }}>
              {s.video ? (
                <div className="flex flex-col gap-2.5">
                  <div className="group relative aspect-video rounded-md overflow-hidden bg-raised">
                    {s.video.poster && <img src={s.video.poster} alt="Driving video frame" className="w-full h-full object-cover block" />}
                    {s.video.missing && <span className="absolute inset-0 flex items-center justify-center text-sm text-orange-text bg-deep/60">Add your own clip</span>}
                    <span className="glass absolute left-1.5 bottom-1.5 h-5 px-1.5 rounded text-xs2 font-mono leading-5 max-w-[70%] truncate">{s.video.name}</span>
                    <div className="absolute right-1.5 top-1.5 flex gap-1">
                      <IconButton label="Edit this frame in Edit" tone="glass" size={24} onClick={editFrame}><Brush size={12} /></IconButton>
                      <IconButton label="Remove video" tone="glass" size={24} onClick={() => set({ video: null })}><Close size={9} /></IconButton>
                    </div>
                  </div>
                  <Trimmer src={s.video.url} duration={s.video.duration ?? 0} trim={s.video.trim} onChange={(trim) => set({ video: { ...s.video!, trim } })}
                    window={win} fps={s.video.fps} height={s.video.height} />
                  <label className="flex items-center gap-2 text-sm text-soft cursor-pointer">
                    <input type="checkbox" checked={s.video.contains_person} onChange={(e) => set({ video: { ...s.video!, contains_person: e.target.checked } })} className="accent-[#9A86F0] w-3.5 h-3.5" />
                    A real person is on camera
                  </label>
                  {engine?.url_only && (
                    <TextInput aria-label="Public URL for the driving video" aria-invalid={(!!s.video.publicUrl && !/^https?:\/\//i.test(s.video.publicUrl)) || undefined} placeholder="https:// public URL (this engine takes URLs only)" value={s.video.publicUrl ?? ""}
                      onChange={(e) => set({ video: { ...s.video!, publicUrl: e.target.value } })} className="h-7 text-xs font-mono" />
                  )}
                </div>
              ) : (
                <button type="button" onClick={() => file.current?.click()}
                  className={cx("mk-btn w-full aspect-video rounded-md border border-dashed bg-transparent text-muted hover:text-text hover:bg-white/[0.02] flex flex-col items-center justify-center gap-1.5", job?.error && invalid.has("video") ? "border-rose/60" : "border-line2 hover:border-white/25")}>
                  {busy ? <Spinner size={16} /> : <MotionIcon size={18} />}
                  <span className="text-sm">{busy ? "Uploading and reading the clip…" : "Drop or pick a clip"}</span>
                  {win && !busy && <span className="text-xs text-faint">{win[0]}–{win[1]} s for {engine?.label}</span>}
                </button>
              )}
              <input ref={file} type="file" accept="video/mp4,video/quicktime,video/webm,.m4v" hidden onChange={(e) => { setVideo([...(e.target.files ?? [])]); e.target.value = ""; }} />
            </Section>
          )}
          <Section title="References" meta={`${s.refs.length} / ${engine?.max_images ?? 9}`} data-own-drop>
            <RefTray refs={s.refs} max={engine?.max_images ?? 9} roles={ROLES} onChange={(refs) => set({ refs })} urlOnly={engine?.url_only} />
          </Section>
          <PromptCard mode="motion" s={s} set={set} label={engine?.prompt?.label} hint={engine?.prompt?.hint} roleSentences={compose?.role_sentences} invalid={invalid.has("prompt")} />
        </>
      }
      center={
        <>
          <StageBar s={s} set={set}><RunStatus m={m} job={job} t={elapsed} /></StageBar>
          <div className="flex-1 min-h-0 p-3 flex flex-col">{stage}</div>
          {m && ["done", "failed", "moderated"].includes(m.status) && (
            <ActionBar>
              {m.status === "done" && <><OutcomeBar m={m} /><span className="w-px h-5 bg-line mx-1 max-md:hidden" aria-hidden /></>}
              <Button size="sm" onClick={() => rerun(m.id)}><Refresh size={13} />New seed</Button>
              <Popover.Root open={swapOpen} onOpenChange={setSwapOpen}>
                <Popover.Trigger asChild><Button size="sm">Swap engine</Button></Popover.Trigger>
                <Popover.Portal>
                  <Popover.Content side="top" align="start" sideOffset={6} className="z-50 w-[320px] p-2 rounded-xl bg-surface shadow-float animate-pop">
                    <p className="m-0 px-1 pb-2 text-xs text-muted">Same inputs, another engine.</p>
                    <EngineDropdown mode="motion" value={m.engine.model} onChange={(id) => { loadGeneration(m, { engine: id }); setSwapOpen(false); toast({ text: `Same inputs loaded on ${id.split("/").pop()}. Press Run.`, tone: "ok" }); }} />
                  </Popover.Content>
                </Popover.Portal>
              </Popover.Root>
              <Button size="sm" onClick={() => { loadGeneration(m); set({ current: null }); toast({ text: "Loaded into a new draft. Change anything, then Run.", tone: "ok" }); }}>Remix</Button>
              <Button size="sm" tone="ghost" onClick={() => go({ name: "generation", id: m.id })}><External size={13} />Open</Button>
              {m.status === "done" && <Button size="sm" tone="contrast" onClick={() => share(m.id)} aria-keyshortcuts="E"><Upload size={13} />Export<Kbd className="ml-0.5">E</Kbd></Button>}
            </ActionBar>
          )}
          <SessionStrip mode="motion" s={s} set={set} />
        </>
      }
      right={
        <>
          <EngineCard
            mode="motion" s={s} set={set} engine={engine} invalid={invalid}
            extra={s.engine === "minimax/minimax-h3" && (
              <Segmented label="Mode" value={swapMode === "swap" ? "Swap" : "Recast"} options={["Recast", "Swap"] as const}
                onChange={(v) => set((st) => ({ params: { ...st.params, motion_mode: v === "Swap" ? "swap" : "recast" }, raw: null }))} cols={2} />
            )}
          />
          <RawRequest s={s} set={set} spec={spec} compose={compose} />
        </>
      }
      run={<RunCard mode="motion" s={s} set={set} spec={spec} compose={compose} estimate={estimate} label="Run motion" />}
    />
  );
}
