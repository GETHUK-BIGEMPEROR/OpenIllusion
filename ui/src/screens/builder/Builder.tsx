// Build: turn a ComfyUI workflow or a Router model into a template. The page and its two steps.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { I, PageHead } from "../../components/oi";
import { cx, Spinner } from "../../components/ui";
import { api, type BuildSpec, type RouterAdapter } from "../../lib/api";
import { confirm } from "../../lib/confirm";
import { errMsg } from "../../lib/format";
import { go } from "../../lib/route";
import { autorun, useApp } from "../../lib/store";
import { CloudInputs, InputsSection, JobSection, PromptSection, ResultSection, slotNames, SourceBar, TitleField } from "./Sections";
import { Start, Tabs, type Track } from "./Start";
import { type Details, fromWorkflow, type MediaRow, type OutputState, type ParamRow, type PromptState, type Source } from "./model";
import { adapterProblems, fromAdapter } from "./modes";

// A workflow handed over from elsewhere (Import, a drop on another page).
let pending: File | null = null;

export function openInBuilder(file: File) {
  pending = file;
  go({ name: "build" });
}

/** A dropped or imported file that is a ComfyUI workflow goes to the builder. Returns true when it did. */
export async function workflowToBuilder(f: File): Promise<boolean> {
  if (!/\.json$/i.test(f.name) && f.type !== "application/json") return false;
  if (f.size > 50 * 1024 * 1024 || !looksLikeWorkflow(await f.text())) return false;
  openInBuilder(f);
  return true;
}

/** Media ComfyUI saved carries its workflow; offer to build from it when it isn't a generation. */
export const buildAction = (f: File) =>
  /\.(png|webp|mp4|webm|mov)$/i.test(f.name) ? { label: "Make a template from it", run: () => openInBuilder(f) } : undefined;

/** Does this text look like a ComfyUI workflow rather than a generation? */
export function looksLikeWorkflow(text: string): boolean {
  try {
    const d = JSON.parse(text);
    if (!d || typeof d !== "object" || Array.isArray(d)) return false;
    if (Array.isArray(d.nodes) && "links" in d) return true;
    const vals = Object.values(d);
    return vals.length > 0 && vals.every((v) => !!v && typeof v === "object" && "class_type" in (v as object));
  } catch {
    return false;
  }
}

/** Build a template: drop a ComfyUI workflow (local) or pick a Router model (cloud), choose what people fill in, name it. */
export function Builder({ from }: { from?: string }) {
  const toast = useApp((s) => s.toast);
  const openTemplate = useApp((s) => s.openTemplate);
  const qc = useQueryClient();
  const [src, setSrc] = useState<Source | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [prompt, setPrompt] = useState<PromptState>({ pick: "", label: "", hint: "", def: "", required: true });
  const [params, setParams] = useState<ParamRow[]>([]);
  const [details, setDetails] = useState<Details>({ label: "", blurb: "", mode: "edit", tags: "" });
  const [output, setOutput] = useState<OutputState>({ result: "", size: "" });
  const [saving, setSaving] = useState<"save" | "try" | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [track, setTrack] = useState<Track>("local");

  const load = (s: Source) => {
    const init = s.kind === "local" ? fromWorkflow(s.a) : fromAdapter(s.a);
    setSrc(s);
    setMedia(init.media);
    setPrompt(init.prompt);
    setParams(init.params);
    setDetails(init.details);
    setOutput(init.output);
    setSaveErr(null);
    setTried(false);
  };

  const readFile = async (f: File) => {
    setTrack("local");
    setReading(f.name);
    setReadErr(null);
    try {
      load({ kind: "local", a: await api.buildFromFile(f) });
    } catch (e) {
      setReadErr(errMsg(e));
    } finally {
      setReading(null);
    }
  };
  const readText = async (text: string) => {
    setReading("pasted workflow");
    setReadErr(null);
    try {
      load({ kind: "local", a: await api.buildFromText(text) });
    } catch (e) {
      setReadErr(errMsg(e));
    } finally {
      setReading(null);
    }
  };
  const pickModel = (a: RouterAdapter) => {
    setReadErr(null);
    load({ kind: "cloud", a });
  };

  useEffect(() => {
    if (pending) {
      const f = pending;
      pending = null;
      void readFile(f);
    }
  }, []);

  // #/build?from=<template>: its workflow, set up the way that template has it.
  useEffect(() => {
    if (!from) return;
    let live = true;
    setReading(from.split("/").pop() ?? from);
    setReadErr(null);
    api.buildFromTemplate(from)
      .then((a) => { if (live) load({ kind: "local", a }); })
      .catch((e) => { if (live) setReadErr(errMsg(e)); })
      .finally(() => { if (live) setReading(null); });
    return () => { live = false; };
  }, [from]);

  // Pasting a workflow anywhere on the start screen reads it.
  useEffect(() => {
    if (src || track !== "local") return;
    const on = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (looksLikeWorkflow(text)) {
        e.preventDefault();
        void readText(text);
      }
    };
    window.addEventListener("paste", on);
    return () => window.removeEventListener("paste", on);
  }, [src, track]);

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!details.label.split(" · ")[0].trim()) p.push("Give the template a name");
    if (src && !media.some((m) => m.on) && !prompt.pick) p.push("Ask for at least one input or a prompt");
    if (params.some((r) => r.on && !r.label.trim())) p.push("Name every control");
    if (src?.kind === "local" && !output.result) p.push("Pick the node the result comes from");
    if (src && prompt.pick && prompt.required && !prompt.def.trim()) p.push("Write the prompt the first run uses");
    if (src?.kind === "cloud") p.push(...adapterProblems(src.a, media));
    return p;
  }, [details.label, media, prompt.pick, prompt.required, prompt.def, params, src, output.result]);

  // Width and height on the output size's node belong to it, not to the controls.
  const sizeOwns = (r: ParamRow) => !!output.size && r.node === output.size && (r.input === "width" || r.input === "height");

  const spec = (): BuildSpec | null => {
    if (!src) return null;
    // A Router template is frozen to the inputs its first run fills: empty ones aren't in it.
    const on = media.filter((m) => m.on && (src.kind === "local" || m.sample));
    const shown = params.filter((r) => r.on && !sizeOwns(r));
    const base = {
      label: details.label.trim(), blurb: details.blurb.trim(), mode: details.mode,  // mode: the server reads it off the result node for workflows
      tags: details.tags.split(",").map((t) => t.trim()).filter(Boolean),
      media: on.map((m) => ({
        node: m.node, input: src.kind === "cloud" ? m.slot : m.input, kind: m.kind, label: "", hint: "", required: src.kind === "cloud" || m.required, sample: m.sample?.asset ?? null,
      })),
      prompt: prompt.pick ? {
        label: "Prompt", hint: "", default: prompt.def, required: prompt.required,
        ...(src.kind === "local" ? { node: prompt.pick.split("|")[0], input: prompt.pick.split("|")[1] } : {}),
      } : null,
      params: shown.map((r) => ({ node: r.node, input: r.input, key: r.key ?? r.name.split(".").pop(), type: r.type, label: r.label.trim(), min: r.min, max: r.max, step: r.step, options: r.options, default: r.value, help: r.help })),
    };
    if (src.kind === "local") {
      const fixed = params.filter((r) => !r.on && !sizeOwns(r) && JSON.stringify(r.value) !== JSON.stringify(r.orig)).map((r) => ({ node: r.node!, input: r.input!, value: r.value }));
      const size = output.size ? { node: output.size, ...(output.keep ?? {}) } : null;
      return { kind: "local", token: src.a.token, base: src.a.preset?.base, ...base, fixed, outputs: [output.result], size };
    }
    // The adapter writes the request: the files go where it says, the rest is the model's defaults.
    return { kind: "cloud", model: src.a.model, ...base };
  };

  // A first run needs something in every input it asks for.
  const noSample = media.find((m) => m.on && m.required && !m.sample);
  const why = problems[0] ?? (noSample ? `Drop a sample into ${slotNames(media.filter((m) => m.on))[media.filter((m) => m.on).indexOf(noSample)]} first.` : "");

  const save = async (then: "save" | "try") => {
    setTried(true);
    if (problems.length || (then === "try" && why)) return;
    const s = spec();
    if (!s) return;
    setSaving(then);
    setSaveErr(null);
    try {
      const e = await api.saveTemplate(s);
      await qc.invalidateQueries({ queryKey: ["engines"] });
      if (then === "try") {
        openTemplate(e.mode, e.id);
        autorun.engine = e.id;
        go({ name: e.mode });
        toast({ text: `${e.label} saved as a draft and running once. Publish the result you like: it becomes the cover.`, tone: "ok" });
      } else {
        go({ name: "explore", t: e.id });
        toast({ text: `${e.label} saved to your drafts. It goes on Explore once you publish a result.`, tone: "ok" });
      }
    } catch (e) {
      setSaveErr(errMsg(e));
    } finally {
      setSaving(null);
    }
  };

  // Back to step 1. Asks first only when there's something of yours to lose.
  const reset = async () => {
    if (src && (details.label.split(" · ")[0].trim() || media.some((m) => m.own))) {
      const res = await confirm({ tone: "neutral", icon: "undo", view: () => ({ title: "Start over?", body: "What you set up for this template is lost. Nothing is saved yet.", action: "Start over" }) });
      if (!res.ok) return;
    }
    setSrc(null);
    setReadErr(null);
    if (from) go({ name: "build" });
  };

  return (
    <div className="page">
      <div className="scroll">
        <PageHead title="Build a template" />
        <div className={cx("build", src && "wide")}>
          {!src && (
            <div className="build-h">
              <Tabs track={track} setTrack={(t) => { setTrack(t); setReadErr(null); }} />
              <h2>{track === "cloud" ? "Turn a Comfy Router model into a template." : "Turn a ComfyUI workflow into a template."}</h2>
              <p>{track === "cloud"
                ? "Pick a model and what it does, fill its inputs, run it once. The result becomes its cover on Explore."
                : "Bring a workflow that already works, drop in samples, run it once. The result becomes its cover on Explore."}</p>
            </div>
          )}
          <Steps at={src ? 2 : 1} cloud={src ? src.kind === "cloud" : track === "cloud"} onBack={() => void reset()} />
          {!src ? (
            <Start track={track} reading={reading} error={readErr} onFile={readFile} onModel={pickModel} />
          ) : (
            <>
              <button className="btn sm ghost bld-back" type="button" onClick={() => void reset()}><I n="left" />{src.kind === "cloud" ? "Back to models" : "Back to workflows"}</button>
              <TitleField d={details} setD={setDetails} invalid={tried && !details.label.split(" · ")[0].trim()} />
              <SourceBar src={src} />
              {src.kind === "cloud" ? (
                <div className="bform">
                  <JobSection a={src.a} rows={media} setRows={setMedia} />
                  <CloudInputs a={src.a} rows={media} setRows={setMedia} />
                  <PromptSection src={src} p={prompt} setP={setPrompt} />
                </div>
              ) : (
                <div className="bform">
                  <InputsSection rows={media} setRows={setMedia} />
                  <PromptSection src={src} p={prompt} setP={setPrompt} />
                  {src.a.results.length !== 1 && <ResultSection a={src.a} o={output} setO={setOutput} />}
                </div>
              )}
              <div className="build-foot">
                {saveErr && <div className="errbox" role="alert"><b>Couldn't save</b><p>{saveErr}</p></div>}
                <div className="bf-row">
                  <button className="btn ghost" type="button" onClick={() => void reset()}><I n="left" /><span className="lbl">Back</span></button>
                  <p className={cx("help", why && "why")} role={tried && why ? "alert" : undefined}>{why || "Runs it with these samples. Publish the result you like: it becomes the cover."}</p>
                  <button className="btn primary" type="button" disabled={!!saving || !!why} onClick={() => save("try")} title={why || undefined}>{saving ? <Spinner size={13} /> : <I n="zap" />}Run</button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Steps({ at, cloud, onBack }: { at: 1 | 2; cloud?: boolean; onBack: () => void }) {
  const steps = cloud
    ? [["Pick a model", "On Comfy Router"], ["Fill inputs", "Only what you fill is kept"], ["Run and publish", "The result is the cover"]]
    : [["Bring a workflow", "Saved or exported from ComfyUI"], ["Check inputs", "Found in the workflow"], ["Run and publish", "The result is the cover"]];
  return (
    <ol className="steps" aria-label="Steps">
      {steps.map(([t, sub], i) => (
        <li key={t} className={cx(at === i + 1 && "on", at > i + 1 && "done")} aria-current={at === i + 1 ? "step" : undefined}>
          {at > i + 1 ? (
            <button type="button" className="steps-back" onClick={onBack} title={`Back to ${t.toLowerCase()}`}>
              <span className="n"><I n="check" /></span><span><b>{t}</b><span>Back to this step</span></span>
            </button>
          ) : (
            <><span className="n">{i + 1}</span><span><b>{t}</b><span>{sub}</span></span></>
          )}
        </li>
      ))}
    </ol>
  );
}
