// Build: turn a ComfyUI workflow or a Router model into a template. The page and its two steps.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyBox, I, PageHead } from "../../components/oi";
import { tplName } from "../../components/TemplateCard";
import { cx, Spinner } from "../../components/ui";
import { api, type BuildSpec, type CloudPreset, type RouterAdapter } from "../../lib/api";
import { confirm } from "../../lib/confirm";
import { errMsg } from "../../lib/format";
import { go, useNavigationGuard } from "../../lib/route";
import { autorun, useApp } from "../../lib/store";
import { type Check, Rail, type RailSetting, shownValue } from "./Rail";
import { CloudInputs, InputsSection, JobSection, PromptSection, ResultSection, slotNames, SourceBar, SourceCheck, TitleField } from "./Sections";
import { CloudSettings, type CloudSettingState, ControlsSection, SizeSection } from "./Settings";
import { Start, Tabs, type Track } from "./Start";
import { type Details, fromWorkflow, type MediaRow, type OutputState, type ParamRow, type PromptState, type Source } from "./model";
import { adapterProblems, fromAdapter, routerJobs, settingsFor, settingValue, toJob } from "./modes";

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
export function Builder({ from, edit, cloud }: { from?: string; edit?: string; cloud?: boolean }) {
  const toast = useApp((s) => s.toast);
  const openTemplate = useApp((s) => s.openTemplate);
  const lastStudio = useApp((s) => s.lastStudio);
  const qc = useQueryClient();
  const [src, setSrc] = useState<Source | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [prompt, setPrompt] = useState<PromptState>({ pick: "", label: "", hint: "", def: "", required: true });
  const [params, setParams] = useState<ParamRow[]>([]);
  const [details, setDetails] = useState<Details>({ label: "", blurb: "", mode: "edit" });
  const [output, setOutput] = useState<OutputState>({ result: "", size: "" });
  const [csets, setCsets] = useState<CloudSettingState>({});
  const [saving, setSaving] = useState<"save" | "copy" | "try" | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const initial = useRef<string | null>(null);
  const allowLeave = useRef(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [track, setTrack] = useState<Track>(cloud ? "cloud" : "local");
  const [compact, setCompact] = useState(() => window.innerWidth <= 1100);
  useEffect(() => {
    const app = document.getElementById("app");
    if (!app) return;
    const observer = new ResizeObserver(() => setCompact(app.clientWidth <= 1100));
    observer.observe(app);
    return () => observer.disconnect();
  }, []);
  // A cloud template this one is built from: it keeps that one's model hints and the multiple its inputs are trimmed to.
  const [base, setBase] = useState<string | undefined>(undefined);
  const snapshot = JSON.stringify({ media, prompt, params, details, output, csets });
  const dirty = !!src && initial.current !== null && initial.current !== snapshot;
  useEffect(() => { if (src && initial.current === null) initial.current = snapshot; }, [src, snapshot]);
  useNavigationGuard(!!edit && dirty, async () => {
    if (allowLeave.current) return true;
    if (saving) return false;
    const answer = await confirm({ tone: "neutral", icon: "pencil", view: () => ({ title: "Discard template edits?", body: "Your changes haven't been saved. The original template and your generations are unchanged.", action: "Discard changes" }) });
    return answer.ok;
  });
  useEffect(() => {
    if (!edit || !dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { if (!allowLeave.current) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [edit, dirty]);

  const load = (s: Source) => {
    const init = s.kind === "local" ? fromWorkflow(s.a) : fromAdapter(s.a);
    setSrc(s);
    setMedia(init.media);
    setPrompt(init.prompt);
    setParams(init.params);
    setDetails(init.details);
    setOutput(init.output);
    setCsets({});
    setBase(undefined);
    setSaveErr(null);
    setTried(false);
  };

  // A cloud template's model with its files in the inputs they fill, its prompt and settings.
  const loadCloud = (a: RouterAdapter, p: CloudPreset) => {
    load({ kind: "cloud", a });
    let rows = a.inputs.map((x, i) => ({ key: `${i}:0`, on: true, kind: x.type, label: x.role, hint: "", required: false, sample: null as CloudPreset["media"][number]["sample"], where: x.role, slot: i, max: x.max }));
    p.media.forEach((m, n) => {
      const free = rows.find((r) => r.slot === m.input && !r.sample);
      if (free) rows = rows.map((r) => (r === free ? { ...r, sample: m.sample } : r));
      else {
        const at = rows.map((r) => r.slot).lastIndexOf(m.input);
        rows = [...rows.slice(0, at + 1), { ...rows[at], key: `${m.input}:${n + 1}`, sample: m.sample }, ...rows.slice(at + 1)];
      }
    });
    const used = p.media.map((m) => m.input);
    const jobs = routerJobs(a);
    setMedia(toJob(jobs.find((j) => used.every((i) => j.inputs.includes(i))) ?? jobs[0], rows));
    setPrompt((x) => ({ ...x, def: p.prompt.default }));
    setDetails({ label: p.label, blurb: p.blurb, mode: a.mode });
    setCsets(p.settings);
    setBase(p.base);
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

  // Editing and copying share the same prefill, but only Edit can replace the source.
  useEffect(() => {
    const source = edit ?? from;
    if (!source) return;
    let live = true;
    setReading(source.split("/").pop() ?? source);
    setReadErr(null);
    api.buildFromTemplate(source, !!edit)
      .then(async (r) => {
        if (!("kind" in r)) return void (live && load({ kind: "local", a: r }));
        const a = r;
        const models = await qc.fetchQuery({ queryKey: ["builder-models"], queryFn: api.builderModels, staleTime: Infinity });
        const m = models.find((x) => x.model === a.model);
        if (!m) throw new Error(`${a.model} isn't one of the Router models here.`);
        if (live) { setTrack("cloud"); loadCloud(m, a); }
      })
      .catch((e) => { if (live) setReadErr(errMsg(e)); })
      .finally(() => { if (live) setReading(null); });
    return () => { live = false; };
  }, [from, edit, readAttempt]);

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

  // What the first run needs, met or not: the side panel lists them, Run waits for all.
  const checks = useMemo(() => {
    const c: Check[] = [];
    const named = !!details.label.trim();
    c.push({ ok: named, text: named ? "Named" : "Give the template a name" });
    if (!src) return c;
    if (!media.some((m) => m.on) && !prompt.pick) c.push({ ok: false, text: "Ask for at least one input or a prompt" });
    if (src.kind === "cloud") {
      const bad = adapterProblems(src.a, media);
      c.push(...(bad.length ? bad.map((text) => ({ ok: false, text })) : [{ ok: true, text: `Inputs fit ${src.a.name}` }]));
    }
    if (params.some((r) => r.on)) {
      const ok = !params.some((r) => r.on && !r.label.trim());
      c.push({ ok, text: ok ? "Every asked setting named" : "Name every control" });
    }
    if (src.kind === "local") c.push({ ok: !!output.result, text: output.result ? "Result picked" : "Pick the node the result comes from" });
    if (prompt.pick && prompt.required) {
      const ok = !!prompt.def.trim();
      c.push({ ok, text: ok ? "Prompt written" : "Write the prompt the first run uses", runOnly: true });
    }
    return c;
  }, [details.label, media, prompt.pick, prompt.required, prompt.def, params, src, output.result]);
  const problems = checks.filter((c) => !c.ok).map((c) => c.text);
  const saveProblems = checks.filter((c) => !c.ok && !c.runOnly).map((c) => c.text);

  // Width and height on the output size's node belong to it, not to the controls.
  const sizeOwns = (r: ParamRow) => !!output.size && r.node === output.size && (r.input === "width" || r.input === "height");

  // The template this one is built from, by name.
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const fromId = src?.kind === "cloud" ? base : src?.a.preset?.base;
  const fromTpl = fromId ? engines.data?.find((e) => e.id === fromId) : undefined;
  const canReplace = !!edit && fromTpl?.id === edit;
  const saveWhy = saveProblems[0] ?? (edit && !fromTpl ? "Wait for the original template to load" : "");

  const spec = (): BuildSpec | null => {
    if (!src) return null;
    // A Router template is frozen to the inputs its first run fills: empty ones aren't in it.
    const on = media.filter((m) => m.on && (src.kind === "local" || m.sample));
    const shown = params.filter((r) => r.on && !sizeOwns(r));
    const shared = {
      label: details.label.trim(), blurb: details.blurb.trim(), mode: details.mode,  // mode: the server reads it off the result node for workflows
      media: on.map((m) => ({
        node: m.node, input: src.kind === "cloud" ? m.slot : m.input, kind: m.kind, label: src.kind === "local" ? m.label : "", hint: m.hint, required: src.kind === "cloud" || m.required, sample: m.sample?.asset ?? null,
        ...(m.window ? { window: m.window } : {}), ...(m.fps ? { fps: m.fps } : {}),
      })),
      prompt: prompt.pick ? {
        label: prompt.label || "Prompt", hint: prompt.hint, default: prompt.def, required: prompt.required,
        ...(src.kind === "local" ? { node: prompt.pick.split("|")[0], input: prompt.pick.split("|")[1] } : {}),
      } : null,
      params: shown.map((r) => ({ node: r.node, input: r.input, key: r.key ?? r.name.split(".").pop(), type: r.type, label: r.label.trim(), min: r.min, max: r.max, step: r.step, options: r.options, unit: r.unit, default: r.value, help: r.help })),
    };
    if (src.kind === "local") {
      const fixed = params.filter((r) => !r.on && !sizeOwns(r) && JSON.stringify(r.value) !== JSON.stringify(r.orig)).map((r) => ({ node: r.node!, input: r.input!, value: r.value }));
      const size = output.size ? { node: output.size, ...(output.keep ?? {}) } : null;
      return { kind: "local", token: src.a.token, base: src.a.preset?.base, ...shared, model_name: details.model_name?.trim() ?? "", fixed, outputs: [output.result], size };
    }
    // The adapter writes the request: the files go where it says, the settings at the values picked here.
    const settings = settingsFor(src.a, on).map((x) => ({ key: x.key, value: settingValue(x, csets[x.key]?.value), locked: !!csets[x.key]?.locked }));
    return { kind: "cloud", model: src.a.model, base, ...shared, settings };
  };

  // A first run needs something in every input it asks for.
  const noSample = media.find((m) => m.on && m.required && !m.sample);
  const sampleCheck: Check[] = noSample
    ? [{ ok: false, text: `Drop a sample into ${slotNames(media.filter((m) => m.on))[media.filter((m) => m.on).indexOf(noSample)]}` }]
    : media.some((m) => m.on && m.required) ? [{ ok: true, text: "Every input has a sample" }] : [];
  const why = problems[0] ?? sampleCheck.find((c) => !c.ok)?.text ?? "";

  // Settings as Create shows them: asked there with the value it opens at, or locked at what every run uses.
  const railSets: RailSetting[] = !src ? [] : src.kind === "cloud"
    ? settingsFor(src.a, media.filter((m) => m.on)).map((s) => ({ label: s.label, value: shownValue(settingValue(s, csets[s.key]?.value), s), asked: !csets[s.key]?.locked }))
    : [
      ...(output.size ? [{ label: "Shape and size", value: output.keep?.aspect ? shownValue({ aspect: output.keep.aspect, size: output.keep.default }) : "Picked on Create", asked: true }] : []),
      ...params.filter((r) => r.on && !sizeOwns(r)).map((r) => ({ label: r.label.trim() || "Unnamed", value: shownValue(r.value, { unit: r.unit ?? undefined }), asked: true })),
    ];

  const save = async (then: "save" | "copy" | "try") => {
    setTried(true);
    if (saving || saveWhy || (then === "try" && why)) return;
    const s = spec();
    if (!s) return;
    const replacing = canReplace && then !== "copy";
    if (replacing) s.replace = edit;
    else if (canReplace && s.label === fromTpl?.label) s.label += " (copy)";
    setSaving(then);
    setSaveErr(null);
    try {
      const e = await api.saveTemplate(s);
      await qc.invalidateQueries({ queryKey: ["engines"] });
      allowLeave.current = true;
      // Return with the saved defaults; historical generations keep their own recipe snapshots.
      openTemplate(e.mode, e.id);
      if (then === "try") Object.assign(autorun, { engine: e.id, until: Date.now() + 30_000 });
      go({ name: e.mode });
      toast({ text: replacing ? `${e.label} updated.${then === "try" ? " Running a test with its saved defaults." : " No run started."}` : then === "try" ? `${e.label} is saved as a draft and running once. Publish it when the result looks right.`
        : `${e.label} is saved as a draft. Run it once, then publish it.`, tone: "ok" });
    } catch (e) {
      setSaveErr(errMsg(e));
    } finally {
      setSaving(null);
    }
  };

  // Back to step 1. Asks first only when there's something of yours to lose.
  const reset = async () => {
    if (src && (details.label.trim() || media.some((m) => m.own))) {
      const res = await confirm({ tone: "neutral", icon: "undo", view: () => ({ title: "Start over?", body: "What you set up for this template is lost. Nothing is saved yet.", action: "Start over" }) });
      if (!res.ok) return;
    }
    setSrc(null);
    setReadErr(null);
    if (from) go({ name: "build" });
  };

  const sidebar = src && <Rail key="sidebar" src={src} name={details.label.trim()} model={src.kind === "cloud" ? src.a.name : details.model_name?.trim() || "Your GPU"}
    media={media} prompt={prompt} settings={railSets} checks={[...checks, ...sampleCheck]} why={why} tried={tried} saving={!!saving} saveErr={saveErr}
    saveWhy={saveWhy} onSave={() => void save("save")} onRun={() => void save("try")} compact={compact}
    editing={edit ? { canReplace, onCopy: () => void save("copy") } : undefined} />;

  return (
    <div className="page">
      <div className="scroll">
        <PageHead title={edit ? "Edit template" : "Build a template"} />
        <div className={cx("build", src && "wide")}>
          {!src && (
            <div className="build-h">
              <div>
                <span className="beyebrow">{edit ? "Template editor" : "Template builder"}</span>
                <h2>{edit ? "Edit template" : "Make it reusable."}</h2>
                <p>{edit ? "Loading the saved inputs, defaults and settings—not your current Create draft."
                  : "Start with a workflow or cloud model. Set the defaults once, then create with it anytime."}</p>
              </div>
              {!edit && <Tabs track={track} setTrack={(t) => { setTrack(t); setReadErr(null); }} />}
            </div>
          )}
          {!src ? (
            <>
              {edit ? readErr ? <EmptyBox icon="alert" title="Couldn't open the template" action={<><button className="btn" type="button" onClick={() => setReadAttempt(x => x + 1)}>Try again</button><button className="btn" type="button" onClick={() => go({ name: lastStudio })}>Back to Create</button></>}>{readErr}</EmptyBox> : <div className="bedit-loading" role="status"><Spinner />Loading template…</div> : <><Steps cloud={track === "cloud"} /><Start track={track} reading={reading} error={readErr} onFile={readFile} onModel={pickModel} /></>}
            </>
          ) : (
            <>
              <div className="bld-top">
                {edit ? <button className="btn sm ghost" type="button" onClick={() => go({ name: fromTpl?.mode ?? details.mode })}><I n="left" />Back to Create</button> : <><button className="btn sm ghost" type="button" onClick={() => void reset()}><I n="left" />{src.kind === "cloud" ? "Models" : "Workflows"}</button><MiniSteps cloud={src.kind === "cloud"} onBack={() => void reset()} /></>}
                <SourceBar src={src} />
              </div>
              <section className="bcontext" aria-label={edit ? "Template editing" : "Template setup"}>
                <div><h2>{edit ? "Edit template" : "Set up your template"}{dirty && <span className="pill">Unsaved changes</span>}</h2>
                  <p>{edit ? "Change the saved defaults. Past generation recipes stay unchanged." : "Choose what people fill in and what stays fixed. Save without starting a run."}</p></div>
              </section>
              <div className="bld-main">
              {compact && sidebar}
              <div className="bform" key="form">
                <section className="bidentity" aria-label="Template details"><h3><I n="pencil" size={15} />Template details</h3>
                  <TitleField d={details} setD={setDetails} invalid={tried && !details.label.trim()} from={!edit && fromTpl ? tplName(fromTpl) : undefined} model={src.kind === "cloud" ? src.a.name : null} />
                </section>
                <SourceCheck src={src} />
              {src.kind === "cloud" ? (
                <>
                  <JobSection a={src.a} rows={media} setRows={setMedia} />
                  <CloudInputs a={src.a} rows={media} setRows={setMedia} />
                  <PromptSection src={src} p={prompt} setP={setPrompt}
                    files={media.filter((m) => m.on && m.sample).map((m) => ({ key: m.key, kind: m.kind, label: m.label, thumb: m.kind === "audio" ? null : m.sample!.poster ?? m.sample!.url }))} />
                  <CloudSettings list={settingsFor(src.a, media.filter((m) => m.on))} st={csets} setSt={setCsets} />
                </>
              ) : (
                <>
                  <InputsSection rows={media} setRows={setMedia} />
                  <PromptSection src={src} p={prompt} setP={setPrompt} />
                  <SizeSection a={src.a} mode={src.a.results.find((r) => r.node === output.result)?.kind === "video" ? "motion" : "edit"} o={output} setO={setOutput} />
                  <ControlsSection rows={params} setRows={setParams} owned={sizeOwns} />
                  {src.a.results.length !== 1 && <ResultSection a={src.a} o={output} setO={setOutput} />}
                </>
              )}
              </div>
              {!compact && sidebar}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const STEPS = {
  cloud: [["Pick a model", "On Comfy Router"], ["Set defaults", "Inputs, prompt and settings"], ["Save template", "Test when you're ready"]],
  local: [["Bring a workflow", "From your ComfyUI"], ["Set defaults", "Inputs, prompt and settings"], ["Save template", "Test when you're ready"]],
};

/** Step 1's three steps, the first one current. */
function Steps({ cloud }: { cloud: boolean }) {
  return (
    <ol className="steps" aria-label="Steps">
      {STEPS[cloud ? "cloud" : "local"].map(([t, sub], i) => (
        <li key={t} className={cx(i === 0 && "on")} aria-current={i === 0 ? "step" : undefined}>
          <span className="n">{i + 1}</span><span><b>{t}</b><span>{sub}</span></span>
        </li>
      ))}
    </ol>
  );
}

/** Step 2's steps in a line: the first one done (back to it), this one, then the run. */
function MiniSteps({ cloud, onBack }: { cloud: boolean; onBack: () => void }) {
  const [first, now, last] = STEPS[cloud ? "cloud" : "local"].map(([t]) => t);
  return (
    <ol className="msteps" aria-label="Steps">
      <li className="done"><button type="button" onClick={onBack} title={`Back to ${first.toLowerCase()}`}><span className="n"><I n="check" /></span>{first}</button></li>
      <li className="on" aria-current="step"><span className="n">2</span>{now}</li>
      <li><span className="n">3</span>{last}</li>
    </ol>
  );
}
