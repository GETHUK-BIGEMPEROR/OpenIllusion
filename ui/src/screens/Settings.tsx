import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EngineDropdown } from "../components/Engine";
import { Check, Cloud, Cpu, Folder, Info, Trash } from "../components/Icons";
import { gpuName } from "../components/Shell";
import { UpstreamWarning } from "../components/Studio";
import { Button, Dot, Notice, Spinner, TextInput, Toggle, cx } from "../components/ui";
import { api, type Settings as S } from "../lib/api";
import { errMsg } from "../lib/format";
import { useApp } from "../lib/store";

const NAV = [
  { id: "local", label: "Local" },
  { id: "cloud", label: "Cloud" },
  { id: "engines", label: "Default engines" },
  { id: "runs", label: "Runs and storage" },
  { id: "community", label: "Community" },
  { id: "privacy", label: "Privacy" },
] as const;

const isUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v.trim());

type Save = (p: Partial<S> & { api_key?: string; local_token?: string; clear_local_token?: boolean }) => Promise<boolean>;

export function Settings() {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const [active, setActive] = useState<string>("local");
  const scroller = useRef<HTMLDivElement>(null);

  // Highlight the section in view.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !settings.data) return;
    const io = new IntersectionObserver((es) => {
      const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (v) setActive(v.target.id.replace("set-", ""));
    }, { root, rootMargin: "0px 0px -70% 0px" });
    NAV.forEach((n) => { const el = document.getElementById(`set-${n.id}`); if (el) io.observe(el); });
    return () => io.disconnect();
  }, [settings.data]);

  const save: Save = async (p) => {
    try {
      qc.setQueryData(["settings"], await api.saveSettings(p));
      qc.invalidateQueries({ queryKey: ["status"] });
      return true;
    } catch (e) {
      toast({ text: `Couldn't save: ${errMsg(e)}`, tone: "error" });
      return false;
    }
  };

  if (settings.isError) return <div className="p-5 max-w-[760px]"><Notice tone="error" title="Couldn't load settings" actions={<Button size="sm" onClick={() => settings.refetch()}>Try again</Button>}>{errMsg(settings.error)}</Notice></div>;
  const s = settings.data;
  if (!s) return <div className="flex-1 flex items-center justify-center text-muted"><Spinner size={18} /></div>;

  return (
    <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto scroll-y">
      <div className="max-w-[1040px] mx-auto px-5 py-6 flex gap-10">
        <nav aria-label="Settings sections" className="w-[168px] shrink-0 max-lg:hidden">
          <ul className="sticky top-0 m-0 p-0 list-none flex flex-col gap-px">
            {NAV.map((n) => (
              <li key={n.id}>
                <a href={`#set-${n.id}`} onClick={(e) => { e.preventDefault(); document.getElementById(`set-${n.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); setActive(n.id); }}
                  aria-current={active === n.id ? "true" : undefined}
                  className={cx("h-8 px-2.5 rounded-md flex items-center text-sm", active === n.id ? "bg-active text-text font-medium" : "text-muted hover:text-text hover:bg-white/[0.04]")}>{n.label}</a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="flex-1 min-w-0 flex flex-col gap-10 pb-24">
          <LocalSection s={s} save={save} status={status.data} />
          <CloudSection s={s} />
          <Group id="engines" title="Default engines" desc="What each studio opens with: a cloud model or a local template.">
            {(["motion", "edit"] as const).map((mode) => {
              const k = mode === "motion" ? "default_motion_engine" : "default_edit_engine";
              return (
                <Row key={mode} label={mode === "motion" ? "Motion" : "Edit"} stack>
                  <EngineDropdown mode={mode} value={s[k]} onChange={(id) => { save({ [k]: id }); useApp.getState().setStudio(mode, { engine: id }); }} />
                </Row>
              );
            })}
          </Group>
          <Group id="runs" title="Runs and storage" desc="Results download the moment they finish. Router links expire within a day.">
            <TextSetting id="out" label="Output folder" icon={<Folder size={14} />} desc="Leave empty for the default." value={s.output_folder} placeholder="~/.openillusion/outputs" mono onSave={(v) => save({ output_folder: v })} />
            <Row label="Max parallel runs" desc="Keeps you under Router's per-caller limit.">
              <Stepper value={s.max_parallel} min={1} max={8} onChange={(v) => save({ max_parallel: v })} label="Max parallel runs" />
            </Row>
            <Row label="Ask before unpriced runs" desc="When Router returns no estimate for a cloud run." htmlFor="t-confirm">
              <Toggle id="t-confirm" label="Ask before unpriced runs" checked={s.confirm_unknown_cost} onChange={(v) => save({ confirm_unknown_cost: v })} />
            </Row>
          </Group>
          <CommunitySection s={s} save={save} />
          <Group id="privacy" title="Privacy" desc="Applied to everything you run and export.">
            <Row label="Strip EXIF and GPS" desc="From references and exports." htmlFor="t-exif">
              <Toggle id="t-exif" label="Strip EXIF and GPS" checked={s.strip_exif} onChange={(v) => save({ strip_exif: v })} />
            </Row>
            <Row label="Web grounding on by default" desc="Lets supported edit engines look things up on the web." htmlFor="t-ground">
              <Toggle id="t-ground" label="Web grounding on by default" checked={s.grounding_default} onChange={(v) => { save({ grounding_default: v }); useApp.getState().setStudio("edit", (e) => ({ params: { ...e.params, grounding: v } })); }} />
            </Row>
          </Group>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- sections */

function LocalSection({ s, save, status }: { s: S; save: Save; status?: import("../lib/api").Status }) {
  const qc = useQueryClient();
  const toast = useApp((st) => st.toast);
  const [starting, setStarting] = useState(false);
  const l = status?.local;
  const startProxy = async () => {
    setStarting(true);
    try {
      const r = await api.startProxy();
      qc.setQueryData(["status"], (old: any) => (old ? { ...old, local: r.local } : old));
      toast({ text: r.ok ? "Comfy API v2 is up." : r.reason === "proxy_not_installed" ? "comfy-api-proxy isn't installed. Run: pip install comfy-api-proxy" : "comfy-api-proxy didn't start. See proxy.log in OpenIllusion's home folder.", tone: r.ok ? "ok" : "error" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setStarting(false);
    }
  };
  const gpu = gpuName(l?.gpu);
  return (
    <Group id="local" icon={<Cpu size={15} />} title="Local · your ComfyUI" desc="Local templates run on your GPU through Comfy API v2. No key, no credits.">
      <div className="px-4 py-3 flex flex-col gap-2">
        <StatusLine tone={!l ? "off" : l.comfyui ? "ok" : "bad"}>
          {!l ? "Checking ComfyUI…" : l.comfyui ? <>ComfyUI {l.comfyui_version ?? ""} is up{gpu ? <span className="text-muted"> · {gpu}</span> : null}</> : <>ComfyUI isn't answering at <span className="font-mono text-xs">{l.comfyui_url}</span></>}
        </StatusLine>
        <StatusLine tone={!l ? "off" : l.v2 ? "ok" : "warn"}
          action={l && !l.v2 && l.proxy_installed && <Button size="xs" onClick={startProxy} disabled={starting}>{starting ? <Spinner size={11} /> : null}Start proxy</Button>}>
          {!l ? "Checking Comfy API v2…" : l.v2 ? <>Comfy API v2 is up{l.managed ? <span className="text-muted"> · started by OpenIllusion</span> : null}</> : l.reason === "bad_token" ? "Comfy API v2 refused the token" : <>Comfy API v2 isn't running{!l.proxy_installed && <span className="text-muted"> · pip install comfy-api-proxy</span>}</>}
        </StatusLine>
        {l && <UpstreamWarning local={l} />}
      </div>
      <TextSetting id="comfy-url" label="ComfyUI address" desc="Where nodes and models are checked." value={s.local_comfyui_url} placeholder="http://127.0.0.1:8188" mono validate={(v) => (isUrl(v) ? null : "Use a full address, like http://127.0.0.1:8188")} onSave={(v) => save({ local_comfyui_url: v })} />
      <TextSetting id="v2-url" label="Comfy API v2 address" desc="Where comfy-api-proxy listens." value={s.local_v2_url} placeholder="http://127.0.0.1:8189" mono validate={(v) => (isUrl(v) ? null : "Use a full address, like http://127.0.0.1:8189")} onSave={(v) => save({ local_v2_url: v })} />
      <SecretSetting id="v2-token" label="Proxy token" desc="Only if the proxy was started with --token." saved={s.has_local_token} placeholder={s.has_local_token ? "Saved · paste to replace" : "None"}
        onSave={(v) => save({ local_token: v })} onClear={() => save({ local_token: "", clear_local_token: true })} />
      <Row label="Start comfy-api-proxy for me" desc="When the v2 address is on this machine and nothing answers there." htmlFor="t-auto">
        <Toggle id="t-auto" label="Start comfy-api-proxy for me" checked={s.local_autostart_proxy} onChange={(v) => save({ local_autostart_proxy: v })} />
      </Row>
    </Group>
  );
}

function CloudSection({ s }: { s: S }) {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const r = status.data?.router;
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      const res = await api.testKey(key.trim(), !!key.trim());
      setResult({ ok: !!res.ok, text: res.ok ? "Key works. Router is reachable." : `Router said no: ${res.message ?? res.reason}` });
      if (res.ok) setKey("");
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.setQueryData(["status"], await api.status(true));
    } catch (e) {
      setResult({ ok: false, text: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };
  const forget = async () => {
    qc.setQueryData(["settings"], await api.forgetKey());
    qc.invalidateQueries({ queryKey: ["status"] });
    setResult(null);
  };
  return (
    <Group id="cloud" icon={<Cloud size={15} />} title="Cloud · Comfy Router" desc="Your Comfy key pays for Router runs. It stays on this machine and never reaches the browser.">
      <div className="px-4 py-3">
        <StatusLine tone={!s.has_key ? "off" : r?.ok ? "ok" : r?.ok === false ? "bad" : "off"}
          action={s.has_key && s.key_source === "settings" && <Button size="xs" tone="ghost" onClick={forget}><Trash size={12} />Forget key</Button>}>
          {!s.has_key ? "No key yet" : r?.ok ? <>Connected <span className="text-muted">· key {s.key_hint}{s.key_source === "env" ? " from COMFY_API_KEY" : ""}</span></> : r?.message ?? r?.reason ?? "Key saved, not tested"}
        </StatusLine>
      </div>
      <Row label="Comfy API key" desc={s.has_key ? "Paste a new key to replace the saved one." : "Create one in your Comfy account settings."} stack htmlFor="api-key">
        <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); test(); }}>
          <div className="flex gap-2">
            <TextInput id="api-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => { setKey(e.target.value); setResult(null); }}
              placeholder={s.has_key ? `Saved ${s.key_hint}` : "comfyui-…"} aria-invalid={result?.ok === false || undefined} aria-describedby="api-key-result" className="flex-1 h-8 font-mono text-sm" />
            <Button type="submit" size="md" disabled={testing || (!key.trim() && !s.has_key)}>{testing ? <Spinner size={12} /> : null}{key.trim() ? "Save and test" : "Test"}</Button>
          </div>
          <span id="api-key-result" role="status" className={cx("text-xs min-h-[16px] flex items-center gap-1", result ? (result.ok ? "text-mint-text" : "text-rose-text") : "text-transparent")}>
            {result && (result.ok ? <Check size={12} /> : <Info size={12} />)}{result?.text}
          </span>
        </form>
      </Row>
    </Group>
  );
}

function CommunitySection({ s, save }: { s: S; save: Save }) {
  const [idx, setIdx] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    const u = idx.trim();
    if (!isUrl(u)) return setErr("Use a full http(s) URL to an index.json.");
    if (s.community_indexes.includes(u)) return setErr("That index is already added.");
    if (await save({ community_indexes: [...s.community_indexes, u] })) setIdx("");
  };
  return (
    <Group id="community" title="Community indexes" desc={<>Any public <span className="font-mono">index.json</span> of generation links, shown under Library → Community. Read-only.</>}>
      {s.community_indexes.length > 0 && (
        <ul className="m-0 p-0 list-none">
          {s.community_indexes.map((u) => (
            <li key={u} className="h-11 px-4 flex items-center gap-2 border-b border-line">
              <span className="flex-1 font-mono text-xs text-soft truncate" title={u}>{u}</span>
              <Button size="xs" tone="ghost" onClick={() => save({ community_indexes: s.community_indexes.filter((x) => x !== u) })}>Remove</Button>
            </li>
          ))}
        </ul>
      )}
      <form className="px-4 py-3 flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <label htmlFor="idx-url" className="text-sm font-medium text-soft">Add index</label>
        <div className="flex gap-2">
          <TextInput id="idx-url" value={idx} aria-invalid={!!err || undefined} onChange={(e) => { setIdx(e.target.value); setErr(null); }} placeholder="https://raw.githubusercontent.com/…/index.json" className="flex-1 h-8 font-mono text-xs" />
          <Button type="submit" size="md" disabled={!idx.trim()}>Add</Button>
        </div>
        {err && <span role="alert" className="text-xs text-rose-text">{err}</span>}
      </form>
    </Group>
  );
}

/* ------------------------------------------------------------------- parts */

function Group({ id, title, desc, icon, children }: { id: string; title: string; desc: ReactNode; icon?: ReactNode; children: ReactNode }) {
  return (
    <section id={`set-${id}`} aria-labelledby={`set-${id}-h`} className="scroll-mt-6 flex flex-col gap-3">
      <div>
        <h2 id={`set-${id}-h`} className="m-0 text-md font-semibold flex items-center gap-2">{icon && <span className="text-muted">{icon}</span>}{title}</h2>
        <p className="m-0 mt-0.5 text-sm text-muted">{desc}</p>
      </div>
      <div className="rounded-xl border border-line bg-panel overflow-hidden [&>*:last-child]:border-b-0">{children}</div>
    </section>
  );
}

function Row({ label, desc, children, stack, htmlFor }: { label: ReactNode; desc?: ReactNode; children: ReactNode; stack?: boolean; htmlFor?: string }) {
  return (
    <div className={cx("px-4 py-3 border-b border-line flex gap-x-6 gap-y-2", stack ? "flex-col" : "items-center justify-between max-sm:flex-col max-sm:items-stretch")}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm font-medium text-text">{label}</label>
        {desc && <span className="block text-xs text-muted mt-0.5">{desc}</span>}
      </div>
      <div className={cx(stack ? "w-full" : "shrink-0")}>{children}</div>
    </div>
  );
}

function StatusLine({ tone, children, action }: { tone: "ok" | "warn" | "bad" | "off"; children: ReactNode; action?: ReactNode }) {
  return (
    <p className="m-0 min-h-[24px] flex items-center gap-2 text-sm text-soft">
      <Dot tone={tone} /><span className="flex-1 min-w-0">{children}</span>{action}
    </p>
  );
}

/** A text field that saves on Save or Enter, validates first, and confirms with a check. */
function TextSetting({ id, label, desc, value, placeholder, mono, icon, validate, onSave }: {
  id: string; label: string; desc?: ReactNode; value: string; placeholder?: string; mono?: boolean; icon?: ReactNode; validate?: (v: string) => string | null; onSave: (v: string) => Promise<boolean>;
}) {
  const [v, setV] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => setV(value), [value]);
  const dirty = v.trim() !== value;
  const submit = async () => {
    const e = v.trim() && validate ? validate(v) : null;
    setErr(e);
    if (e || !dirty) return;
    setBusy(true);
    const ok = await onSave(v.trim());
    setBusy(false);
    if (ok) { setSaved(true); setTimeout(() => setSaved(false), 1600); }
  };
  return (
    <Row label={<span className="inline-flex items-center gap-1.5">{icon && <span className="text-muted">{icon}</span>}{label}</span>} desc={desc} stack htmlFor={id}>
      <form className="flex flex-col gap-1.5" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <div className="flex gap-2">
          <TextInput id={id} value={v} placeholder={placeholder} spellCheck={false} aria-invalid={!!err || undefined} aria-describedby={err ? `${id}-err` : undefined}
            onChange={(e) => { setV(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === "Escape") { setV(value); setErr(null); } }}
            className={cx("flex-1 h-8 text-sm", mono && "font-mono text-xs")} />
          <Button type="submit" size="md" disabled={!dirty || busy} className="min-w-[64px]">{busy ? <Spinner size={12} /> : saved ? <><Check size={13} className="text-mint" />Saved</> : "Save"}</Button>
        </div>
        {err && <span id={`${id}-err`} role="alert" className="text-xs text-rose-text">{err}</span>}
      </form>
    </Row>
  );
}

function SecretSetting({ id, label, desc, saved, placeholder, onSave, onClear }: { id: string; label: string; desc: string; saved: boolean; placeholder: string; onSave: (v: string) => Promise<boolean>; onClear: () => void }) {
  const [v, setV] = useState("");
  return (
    <Row label={label} desc={desc} stack htmlFor={id}>
      <form className="flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (v.trim() && (await onSave(v.trim()))) setV(""); }}>
        <TextInput id={id} type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="flex-1 h-8 font-mono text-xs" />
        <Button type="submit" size="md" disabled={!v.trim()}>Save</Button>
        {saved && <Button size="md" tone="ghost" onClick={onClear}>Clear</Button>}
      </form>
    </Row>
  );
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  const btn = "mk-btn w-7 h-7 rounded-md border-0 bg-transparent text-soft hover:bg-raised hover:text-text disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center text-md";
  return (
    <div role="group" aria-label={label} className="inline-flex items-center p-0.5 rounded-lg bg-bg border border-line">
      <button type="button" aria-label="Fewer" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))} className={btn}>−</button>
      <output aria-live="polite" className="w-8 text-center font-mono text-sm tabular">{value}</output>
      <button type="button" aria-label="More" disabled={value >= max} onClick={() => onChange(Math.min(max, value + 1))} className={btn}>+</button>
    </div>
  );
}
