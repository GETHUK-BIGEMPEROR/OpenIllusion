import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx, EmptyBox, gpuName, I, PageHead } from "../components/oi";
import { UpstreamWarning } from "../components/Studio";
import { api, type Settings as S, type Status } from "../lib/api";
import { errMsg } from "../lib/format";
import { useApp } from "../lib/store";

const NAV = [
  { id: "engines", label: "Engines" },
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
  const [active, setActive] = useState<string>("engines");
  const scroller = useRef<HTMLDivElement>(null);

  // Highlight the section in view.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !settings.data) return;
    const io = new IntersectionObserver((es) => {
      const v = es.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (v) setActive(v.target.id.replace("set-", ""));
    }, { root, rootMargin: "-80px 0px -65% 0px" });
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

  const s = settings.data;
  return (
    <div className="page">
      <div ref={scroller} className="scroll">
        <PageHead title="Settings" />
        {settings.isError ? (
          <EmptyBox icon="alert" title="Couldn't load settings" style={{ marginTop: 60 }} action={<button className="btn" type="button" onClick={() => settings.refetch()}>Try again</button>}>{errMsg(settings.error)}</EmptyBox>
        ) : !s ? (
          <div className="set-wrap" aria-busy="true"><div /><div className="set-body"><div className="engines"><div className="media" style={{ height: 320, borderRadius: 18 }} /><div className="media" style={{ height: 320, borderRadius: 18 }} /></div></div></div>
        ) : (
          <div className="set-wrap">
            <nav className="set-nav" aria-label="Settings sections">
              {NAV.map((n) => (
                <button key={n.id} type="button" aria-current={active === n.id ? "true" : undefined}
                  style={active === n.id ? { background: "var(--raised)", color: "var(--text)", fontWeight: 500 } : undefined}
                  onClick={() => { document.getElementById(`set-${n.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); setActive(n.id); }}>{n.label}</button>
              ))}
            </nav>
            <div className="set-body">
              <Sec id="engines" title="Engines" desc="Local templates run on your GPU through Comfy API v2. Cloud templates run on Comfy Router with your key.">
                <div className="engines">
                  <LocalCard s={s} save={save} status={status.data} />
                  <CloudCard s={s} />
                </div>
              </Sec>

              <Sec id="runs" title="Runs and storage" desc="Results download the moment they finish. Router links expire within a day.">
                <div className="set-card">
                  <TextSetting id="out" label="Output folder" help="Leave empty for the default." value={s.output_folder} placeholder="~/.openillusion/outputs" mono onSave={(v) => save({ output_folder: v })} />
                </div>
                <div className="set-card set-list">
                  <Trow title="Max parallel runs" desc="Keeps you under Router's per-caller limit.">
                    <Stepper value={s.max_parallel} min={1} max={8} onChange={(v) => save({ max_parallel: v })} label="Max parallel runs" />
                  </Trow>
                  <Trow title="Ask before unpriced runs" desc="When Router returns no estimate for a cloud run.">
                    <Switch label="Ask before unpriced runs" checked={s.confirm_unknown_cost} onChange={(v) => save({ confirm_unknown_cost: v })} />
                  </Trow>
                </div>
              </Sec>

              <CommunitySection s={s} save={save} />

              <Sec id="privacy" title="Privacy" desc="Applied to everything you run and export.">
                <div className="set-card set-list">
                  <Trow title="Strip EXIF and GPS" desc="From your photos and from exports.">
                    <Switch label="Strip EXIF and GPS" checked={s.strip_exif} onChange={(v) => save({ strip_exif: v })} />
                  </Trow>
                  <Trow title="Web grounding on by default" desc="Lets supported cloud edit models look things up on the web.">
                    <Switch label="Web grounding on by default" checked={s.grounding_default} onChange={(v) => { save({ grounding_default: v }); useApp.getState().setStudio("edit", (e) => ({ params: { ...e.params, grounding: v } })); }} />
                  </Trow>
                </div>
              </Sec>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- sections */

function LocalCard({ s, save, status }: { s: S; save: Save; status?: Status }) {
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
  const ok = !!l?.comfyui && !!l.v2;
  return (
    <div className={cx("set-card", ok && "on")}>
      <div className="ech">
        <span className="ic"><I n="monitor" /></span>
        <div><b>Your ComfyUI</b><span>{gpu ?? "Local GPU"} · no key, no credits</span></div>
        <span className="state">{!l ? <span className="pill">Checking…</span> : ok ? <span className="pill" style={{ background: "rgba(95,211,154,.14)", color: "var(--mint)" }}><i className="dot" />Ready</span> : <span className="pill rose">Not ready</span>}</span>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <SRow ok={!!l?.comfyui} pending={!l} label={!l ? "Checking ComfyUI" : l.comfyui ? `ComfyUI ${l.comfyui_version ?? ""} is up` : "ComfyUI isn't answering"} meta={l?.comfyui_url} />
        <SRow ok={!!l?.v2} pending={!l} label={!l ? "Checking Comfy API v2" : l.v2 ? `Comfy API v2 is up${l.managed ? " · started here" : ""}` : l.reason === "bad_token" ? "Comfy API v2 refused the token" : "Comfy API v2 isn't running"}
          meta={l && !l.v2 && l.proxy_installed ? undefined : l && !l.v2 ? "pip install comfy-api-proxy" : undefined}
          action={l && !l.v2 && l.proxy_installed ? <button className="btn sm" type="button" onClick={startProxy} disabled={starting} style={{ marginLeft: "auto" }}>{starting ? "Starting…" : "Start proxy"}</button> : undefined} />
      </div>
      {l && <UpstreamWarning local={l} />}
      <TextSetting id="comfy-url" label="ComfyUI address" help="Where nodes and models are checked." value={s.local_comfyui_url} placeholder="http://127.0.0.1:8188" mono validate={(v) => (isUrl(v) ? null : "Use a full address, like http://127.0.0.1:8188")} onSave={(v) => save({ local_comfyui_url: v })} />
      <TextSetting id="v2-url" label="Comfy API v2 address" help="Where comfy-api-proxy listens." value={s.local_v2_url} placeholder="http://127.0.0.1:8189" mono validate={(v) => (isUrl(v) ? null : "Use a full address, like http://127.0.0.1:8189")} onSave={(v) => save({ local_v2_url: v })} />
      <SecretSetting id="v2-token" label="Proxy token" help="Only if the proxy was started with --token." saved={s.has_local_token} placeholder={s.has_local_token ? "Saved · paste to replace" : "None"}
        onSave={(v) => save({ local_token: v })} onClear={() => save({ local_token: "", clear_local_token: true })} />
      <div className="optrow">
        <div><b>Start comfy-api-proxy for me</b><span>When the v2 address is on this machine and nothing answers there.</span></div>
        <Switch label="Start comfy-api-proxy for me" checked={s.local_autostart_proxy} onChange={(v) => save({ local_autostart_proxy: v })} />
      </div>
    </div>
  );
}

function CloudCard({ s }: { s: S }) {
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
  const on = s.has_key && !!r?.ok;
  return (
    <div className={cx("set-card", on && "on")}>
      <div className="ech">
        <span className="ic"><I n="cloud" /></span>
        <div><b>Comfy Router</b><span>Cloud models · billed to your Comfy key</span></div>
        <span className="state">{on ? <span className="pill" style={{ background: "rgba(95,211,154,.14)", color: "var(--mint)" }}><i className="dot" />Connected</span> : s.has_key ? <span className="pill">{r?.ok === false ? "Key rejected" : "Not tested"}</span> : <span className="pill"><i className="dot off" />No key</span>}</span>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        <SRow ok={on} pending={false} label={!s.has_key ? "No key yet" : r?.ok ? "Router is reachable" : r?.message ?? r?.reason ?? "Key saved, not tested"}
          meta={s.has_key ? `${s.key_hint}${s.key_source === "env" ? " · COMFY_API_KEY" : ""}` : undefined} />
        <div className="srow"><I n="shield" style={{ color: "var(--violet)" }} />The key stays on this machine and never reaches the browser.</div>
      </div>
      <form className="ofield" onSubmit={(e) => { e.preventDefault(); test(); }}>
        <label htmlFor="api-key">Comfy API key</label>
        <div className="irow">
          <input id="api-key" className="input mono" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => { setKey(e.target.value); setResult(null); }}
            placeholder={s.has_key ? `Saved ${s.key_hint}` : "comfyui-…"} aria-invalid={result?.ok === false || undefined} aria-describedby="api-key-result" style={{ fontSize: 12 }} />
          <button className="btn" type="submit" disabled={testing || (!key.trim() && !s.has_key)}>{testing ? "Testing…" : key.trim() ? "Save and test" : "Test"}</button>
        </div>
        <p id="api-key-result" role="status" className="help" style={result ? { color: result.ok ? "var(--mint)" : "#FFB3BD", display: "flex", gap: 6, alignItems: "center" } : undefined}>
          {result ? <><I n={result.ok ? "check" : "info"} />{result.text}</> : s.has_key ? "Paste a new key to replace the saved one." : "Create one in your Comfy account settings."}
        </p>
      </form>
      {s.has_key && s.key_source === "settings" && <button className="btn ghost sm" type="button" onClick={forget} style={{ justifySelf: "start" }}><I n="trash" />Forget key</button>}
    </div>
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
    <Sec id="community" title="Community indexes" desc={<>Any public <span className="mono">index.json</span> of generation links, shown under Library → Community. Read-only.</>}>
      {s.community_indexes.length > 0 && (
        <div className="set-card set-list">
          {s.community_indexes.map((u) => (
            <div key={u} className="trow">
              <I n="globe" style={{ color: "var(--text-3)" }} />
              <div><b className="mono" style={{ fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={u}>{u}</b></div>
              <button className="btn sm ghost" type="button" onClick={() => save({ community_indexes: s.community_indexes.filter((x) => x !== u) })}>Remove</button>
            </div>
          ))}
        </div>
      )}
      <form className="set-card" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <div className="ofield">
          <label htmlFor="idx-url">Add index</label>
          <div className="irow">
            <input id="idx-url" className="input mono" value={idx} aria-invalid={!!err || undefined} onChange={(e) => { setIdx(e.target.value); setErr(null); }} placeholder="https://raw.githubusercontent.com/…/index.json" style={{ fontSize: 12 }} />
            <button className="btn" type="submit" disabled={!idx.trim()}>Add</button>
          </div>
          {err && <p role="alert" className="help" style={{ color: "#FFB3BD" }}>{err}</p>}
        </div>
      </form>
    </Sec>
  );
}

/* ------------------------------------------------------------------- parts */

function Sec({ id, title, desc, children }: { id: string; title: string; desc: ReactNode; children: ReactNode }) {
  return (
    <section id={`set-${id}`} aria-labelledby={`set-${id}-h`} className="set-sec">
      <h2 id={`set-${id}-h`}>{title}</h2>
      <p>{desc}</p>
      {children}
    </section>
  );
}

function SRow({ ok, pending, label, meta, action }: { ok: boolean; pending: boolean; label: string; meta?: string; action?: ReactNode }) {
  return (
    <div className="srow">
      {pending ? <i className="dot off" /> : ok ? <I n="check" /> : <I n="alert" style={{ color: "var(--rose)" }} />}
      <span>{label}</span>
      {meta && <span className="mono" title={meta} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{meta}</span>}
      {action}
    </div>
  );
}

function Trow({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return <div className="trow"><div><b>{title}</b><span>{desc}</span></div>{children}</div>;
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

/** A text field that saves on Save or Enter, validates first, and confirms with a check. */
function TextSetting({ id, label, help, value, placeholder, mono, validate, onSave }: {
  id: string; label: string; help?: ReactNode; value: string; placeholder?: string; mono?: boolean; validate?: (v: string) => string | null; onSave: (v: string) => Promise<boolean>;
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
    <form className="ofield" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label htmlFor={id}>{label}</label>
      <div className="irow">
        <input id={id} className={cx("input", mono && "mono")} style={mono ? { fontSize: 12 } : undefined} value={v} placeholder={placeholder} spellCheck={false}
          aria-invalid={!!err || undefined} aria-describedby={`${id}-help`}
          onChange={(e) => { setV(e.target.value); setErr(null); }} onKeyDown={(e) => { if (e.key === "Escape") { setV(value); setErr(null); } }} />
        <button className="btn" type="submit" disabled={!dirty || busy} style={{ minWidth: 72 }}>{busy ? "Saving…" : saved ? <><I n="check" style={{ color: "var(--mint)" }} />Saved</> : "Save"}</button>
      </div>
      <p id={`${id}-help`} role={err ? "alert" : undefined} className="help" style={err ? { color: "#FFB3BD" } : undefined}>{err ?? help}</p>
    </form>
  );
}

function SecretSetting({ id, label, help, saved, placeholder, onSave, onClear }: { id: string; label: string; help: string; saved: boolean; placeholder: string; onSave: (v: string) => Promise<boolean>; onClear: () => void }) {
  const [v, setV] = useState("");
  return (
    <form className="ofield" onSubmit={async (e) => { e.preventDefault(); if (v.trim() && (await onSave(v.trim()))) setV(""); }}>
      <label htmlFor={id}>{label}</label>
      <div className="irow">
        <input id={id} className="input mono" style={{ fontSize: 12 }} type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-describedby={`${id}-help`} />
        <button className="btn" type="submit" disabled={!v.trim()}>Save</button>
        {saved && <button className="btn ghost" type="button" onClick={onClear}>Clear</button>}
      </div>
      <p id={`${id}-help`} className="help">{help}</p>
    </form>
  );
}

function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    <div role="group" aria-label={label} className="stepper">
      <button type="button" aria-label="Fewer" disabled={value <= min} style={value <= min ? { opacity: 0.3 } : undefined} onClick={() => onChange(Math.max(min, value - 1))}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label="More" disabled={value >= max} style={value >= max ? { opacity: 0.3 } : undefined} onClick={() => onChange(Math.min(max, value + 1))}>+</button>
    </div>
  );
}
