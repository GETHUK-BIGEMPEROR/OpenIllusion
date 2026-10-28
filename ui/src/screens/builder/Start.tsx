// Step 1: drop a workflow (local) or pick a Router model (cloud).
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { I, useStatus } from "../../components/oi";
import { tplName } from "../../components/TemplateCard";
import { cx, Spinner } from "../../components/ui";
import { api, type RouterAdapter } from "../../lib/api";
import { errMsg } from "../../lib/format";
import { go } from "../../lib/route";
import { KIND_ICON, KIND_NOUN } from "./model";
import { routerJobs } from "./modes";

export type Track = "local" | "cloud";

export function Tabs({ track, setTrack }: { track: Track; setTrack: (t: Track) => void }) {
  return (
    <div className="seg bld-tabs" role="tablist" aria-label="Build from">
      {([["local", "cpu", "Local workflow"], ["cloud", "cloud", "Comfy Router"]] as const).map(([t, icon, label]) => (
        <button key={t} type="button" role="tab" aria-selected={track === t} aria-pressed={track === t} onClick={() => setTrack(t)}>
          <I n={icon} />{label}
        </button>
      ))}
    </div>
  );
}

export function Start({ track, reading, error, onFile, onModel }: { track: Track; reading: string | null; error: string | null; onFile: (f: File) => void; onModel: (a: RouterAdapter) => void }) {
  const [over, setOver] = useState(false);
  return (
    <div className="bld-start" data-own-drop
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(false); }}
      onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); }}>
      {error && <div className="errbox bld-err" role="alert"><b>{track === "cloud" ? "Couldn't read that model" : "Couldn't read that"}</b><p>{error}</p></div>}
      {track === "local" ? <LocalStart reading={reading} over={over} onFile={onFile} /> : <RouterStart onModel={onModel} />}
    </div>
  );
}

function LocalStart({ reading, over, onFile }: { reading: string | null; over: boolean; onFile: (f: File) => void }) {
  const status = useStatus();
  const input = useRef<HTMLInputElement>(null);
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  const comfyUp = !!status.data?.local.comfyui;
  const sample = engines.data?.find((e) => e.id === "local/qwen21-add-hat");
  const busy = !!reading && !reading.includes("/");
  return (
    <>
      <button type="button" className={cx("dropwf", over && "drag")} onClick={() => input.current?.click()} disabled={busy}>
        <span className="ic">{busy ? <Spinner size={20} /> : <I n="upload" />}</span>
        <b>{busy ? `Reading ${reading}…` : over ? "Drop it" : "Drop a ComfyUI workflow"}</b>
        <p>The .json you saved or exported from ComfyUI, or a .png, .webp or .mp4 ComfyUI made: they carry the workflow inside. Pasting the JSON works too.</p>
      </button>
      <input ref={input} type="file" hidden accept=".json,.png,.webp,.mp4,.webm,.mov,application/json" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }} />
      {!comfyUp && status.data && <p className="bc-warn"><I n="alert" />ComfyUI isn't running. The builder reads node definitions from it, so start it first.</p>}
      {sample && (
        <div className="try-wf"><button className="btn ghost" type="button" disabled={!!reading} onClick={() => go({ name: "build", from: sample.id })}>
          {reading === sample.id.split("/").pop() ? <Spinner size={13} /> : <I n="play" />}Try it with the {tplName(sample)} workflow
        </button></div>
      )}
    </>
  );
}

function RouterStart({ onModel }: { onModel: (a: RouterAdapter) => void }) {
  const status = useStatus();
  const hasKey = !!status.data?.has_key;
  const models = useQuery({ queryKey: ["builder-models"], queryFn: api.builderModels, staleTime: Infinity });
  return (
    <>
      {!hasKey ? (
        <div className="dropwf bc-gate">
          <span className="ic"><I n="key" /></span>
          <b>Add a Comfy API key</b>
          <p>Router models are paid and run on your Comfy account. The key pays for the first run.</p>
          <a className="btn primary" href="#/settings">Add a key in Settings</a>
        </div>
      ) : (
        models.isLoading ? <div className="bc-empty"><Spinner size={14} />Loading models</div>
          : models.isError ? <div className="bc-empty">{errMsg(models.error)}</div>
          : (["motion", "edit"] as const).map((mode) => {
            const list = (models.data ?? []).filter((m) => m.mode === mode);
            return list.length > 0 && (
              <section key={mode} className="bc-group" aria-label={mode === "motion" ? "Video models" : "Photo models"}>
                <h3><I n={mode === "motion" ? "film" : "image"} />{mode === "motion" ? "Make video" : "Make photos"}<span className="mono">{list.length}</span></h3>
                <div className="bc-grid">{list.map((m) => <ModelCard key={m.model} m={m} onPick={() => onModel(m)} />)}</div>
              </section>
            );
          })
      )}
    </>
  );
}

const MAKER: Record<string, string> = { kling: "Kuaishou", byteplus: "ByteDance", veo: "Google", vertexai: "Google", wan: "Alibaba", openai: "OpenAI", bfl: "Black Forest Labs", xai: "xAI" };

/** How a model reads a file named in the prompt: Kling's "<<<image_1>>>", Seedance's "@Image 1", or the name as written.
 *  Null when it takes no files. */
function readsAs(m: RouterAdapter): { name: string; token: string | null } | null {
  const kind = m.inputs[0]?.type;
  if (!kind) return null;
  const name = `${KIND_NOUN[kind]} 1`;
  const form = m.mentions?.[kind];
  return { name, token: form ? form.replace("{n}", "1") : null };
}

/** What a Router model can do: its jobs, in the words the Builder's job cards use. */
const modeNames = (a: RouterAdapter) => routerJobs(a).map((j) => j.label);

/** One Router model on the start screen: who makes it, what it does, what it takes. */
function ModelCard({ m, onPick }: { m: RouterAdapter; onPick: () => void }) {
  const provider = m.model.split("/")[0];
  const video = m.mode === "motion";
  const reads = readsAs(m);
  return (
    <button type="button" className={cx("bc-card", video ? "v" : "p")} onClick={onPick} aria-label={`${m.name}: ${modeNames(m).join(", ")}`}>
      <span className="bc-top">
        <span className="bc-mono" aria-hidden>{m.name.slice(0, 2)}</span>
        <span className="bc-mt"><b>{m.name}</b><span>{MAKER[provider] ?? provider}<i className="mono">{m.model.split("/")[1]}</i></span></span>
        <I n="arrow" className="bc-go" />
      </span>
      <span className="bc-row"><span className="bc-lab">Does</span>
        <span className="bc-chips">{modeNames(m).map((n) => <span key={n} className="bc-mode">{n}</span>)}</span>
      </span>
      <span className="bc-row takes"><span className="bc-lab">Takes</span>
        <span className="bc-chips">
          {m.inputs.length ? m.inputs.map((x) => (
            <span key={x.role} className="bc-role" title={[x.needs && `Needs a ${x.needs}`, x.max_with && `${x.max_with.max} with a ${x.max_with.roles.join(" or ").toLowerCase()}`].filter(Boolean).join(". ") || undefined}>
              <I n={KIND_ICON[x.type]} />{x.role}{x.max > 1 && <span className="mono">×{x.max}</span>}
            </span>
          )) : <span className="bc-role none">Prompt only</span>}
        </span>
      </span>
      {reads && (
        <span className="bc-row reads" title={reads.token ? `Write ${reads.name} in the prompt; ${m.name} gets ${reads.token}` : `${m.name} has no names for its files`}>
          <span className="bc-lab">Reads</span>
          <span className="bc-chips">
            {!reads.token ? <span className="bc-role none">No file names: describe each in words</span>
              : reads.token === reads.name ? <span className="bc-role">{reads.name}, as written</span>
              : <span className="bc-tok">{reads.name}<I n="arrow" /><code>{reads.token}</code></span>}
          </span>
        </span>
      )}
    </button>
  );
}
