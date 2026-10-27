import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx, EmptyBox, gpuName, I, PageHead } from "../components/oi";
import { UpstreamWarning } from "../components/Studio";
import { api, type Settings as S, type Status, type StorageBucket } from "../lib/api";
import { confirm } from "../lib/confirm";
import { bytes, errMsg } from "../lib/format";
import { useApp } from "../lib/store";

const NAV = [
  { id: "gpu", label: "Your GPU" },
  { id: "limits", label: "Output limits" },
  { id: "storage", label: "Storage" },
  { id: "cloud", label: "Cloud" },
] as const;

const isUrl = (v: string) => /^https?:\/\/[^\s/]+/i.test(v.trim());

type Save = (p: Partial<S> & { api_key?: string; local_token?: string; clear_local_token?: boolean }) => Promise<boolean>;

export function Settings() {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const [active, setActive] = useState<string>("gpu");
  const scroller = useRef<HTMLDivElement>(null);

  // Highlight the section in view; the last one wins once the page bottoms out.
  useEffect(() => {
    const root = scroller.current;
    if (!root || !settings.data) return;
    const on = () => {
      const top = root.getBoundingClientRect().top;
      let cur: string = NAV[0].id;
      for (const n of NAV) {
        const el = document.getElementById(`set-${n.id}`);
        if (el && el.getBoundingClientRect().top - top < 140) cur = n.id;
      }
      if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4) cur = NAV[NAV.length - 1].id;
      setActive(cur);
    };
    on();
    root.addEventListener("scroll", on, { passive: true });
    return () => root.removeEventListener("scroll", on);
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
          <div className="set-wrap" aria-busy="true"><div /><div className="set-body"><div className="media" style={{ height: 300, borderRadius: 18 }} /><div className="media" style={{ height: 160, borderRadius: 18 }} /></div></div>
        ) : (
          <div className="set-wrap">
            <nav className="set-nav" aria-label="Settings sections">
              {NAV.map((n) => (
                <button key={n.id} type="button" aria-current={active === n.id ? "true" : undefined}
                  onClick={() => { document.getElementById(`set-${n.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }); setActive(n.id); }}>{n.label}</button>
              ))}
            </nav>
            <div className="set-body">
              <Sec id="gpu" title="Your GPU" desc="Templates run on the ComfyUI on this machine. OpenIllusion talks to it through Comfy API v2 and can start that for you.">
                <LocalCard s={s} save={save} status={status.data} />
              </Sec>

              <Sec id="limits" title="Output limits" desc="Bigger outputs take longer and can run out of GPU memory. These caps keep runs safe on most cards.">
                <div className="set-card">
                  <div className={cx("caps", s.uncap_size && "off")}>
                    <div className="cap-tile"><span><I n="image" />Photos up to</span><b>3 MP</b><small>about 2000 × 1500 at 4:3</small></div>
                    <div className="cap-tile"><span><I n="film" />Videos up to</span><b>1.5 MP</b><small>about 1632 × 912 at 16:9</small></div>
                  </div>
                  <Toggle title="Remove the caps" desc="Original runs at full size and bigger steps appear. Big runs may fail on smaller GPUs."
                    checked={s.uncap_size} onChange={(v) => { save({ uncap_size: v }).then((ok) => { if (ok) qc.invalidateQueries({ queryKey: ["engines"] }); }); }} />
                </div>
              </Sec>

              <StorageSection s={s} save={save} />

              <Sec id="cloud" title="Cloud" desc="Optional. Cloud templates run on Comfy Router and bill your Comfy account. Local templates never need this." later={!s.has_key}>
                <CloudCard s={s} save={save} />
              </Sec>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- sections */

const BUCKETS: { id: StorageBucket; label: string; desc: string; color: string }[] = [
  { id: "generations", label: "Generations", desc: "Your library: inputs, previews and recipes.", color: "var(--violet)" },
  { id: "trash", label: "Trash", desc: "Deleted generations, kept 7 days.", color: "var(--rose)" },
  { id: "uploads", label: "Uploads", desc: "Files dropped into forms. Runs copy what they use, so these are working copies.", color: "var(--orange)" },
  { id: "exports", label: "Exports", desc: ".illusion packages you exported, in your output folder.", color: "var(--mint)" },
  { id: "cache", label: "Cache", desc: "Thumbnails and schemas. Rebuilt when needed.", color: "var(--text-3)" },
];

/** Where the disk goes, and a way to take back what's only working copies. */
function StorageSection({ s, save }: { s: S; save: Save }) {
  const qc = useQueryClient();
  const toast = useApp((st) => st.toast);
  const q = useQuery({ queryKey: ["storage"], queryFn: api.storage });
  const [busy, setBusy] = useState<StorageBucket | null>(null);
  const u = q.data;
  const total = u ? BUCKETS.reduce((a, b) => a + u[b.id].bytes, 0) : 0;

  const ASK: Partial<Record<StorageBucket, { hold?: boolean; title: string; body: string; action: string }>> = {
    trash: { hold: true, title: "Empty the trash?", body: "Deleted generations go for good. This can't be undone.", action: "Hold to empty" },
    uploads: { title: "Clean up uploads?", body: "Files dropped into forms go, except anything from the last hour. Generations keep their own copies.", action: "Clean up" },
    exports: { hold: true, title: "Delete exports?", body: "Every .illusion package in your output folder goes. Export again from any generation.", action: "Hold to delete" },
  };
  const clean = async (b: StorageBucket) => {
    const ask = ASK[b];
    if (ask && u) {
      const res = await confirm({
        hold: ask.hold, icon: "trash",
        view: () => ({ title: ask.title, body: ask.body, facts: [`${bytes(u[b].bytes)} freed`, `${u[b].items} item${u[b].items === 1 ? "" : "s"}`], action: ask.action }),
      });
      if (!res.ok) return;
    }
    setBusy(b);
    try {
      const r = await api.cleanStorage(b);
      toast({ text: `${bytes(r.bytes)} freed.`, tone: "ok" });
      for (const k of ["storage", ...(b === "trash" ? ["trash"] : [])]) qc.invalidateQueries({ queryKey: [k] });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sec id="storage" title="Storage" desc="Every result is saved the moment it finishes. Full-size results in your output folder aren't counted here.">
      <div className="set-card storage">
        {q.isError ? (
          <p className="help" style={{ color: "var(--rose)", margin: 0 }}>Couldn't measure storage: {errMsg(q.error)}</p>
        ) : (
          <>
            <div className="st-top">
              <b className="mono">{u ? bytes(total) : "…"}</b><span>in use</span>
              <button className="icon-btn sm" type="button" aria-label="Measure again" title="Measure again" onClick={() => q.refetch()}><I n="refresh" /></button>
            </div>
            <div className="st-bar" role="img" aria-label={u ? BUCKETS.map((b) => `${b.label} ${bytes(u[b.id].bytes)}`).join(", ") : "Measuring"}>
              {u && BUCKETS.map((b) => u[b.id].bytes > 0 && <i key={b.id} style={{ flexGrow: u[b.id].bytes, background: b.color }} />)}
            </div>
            <div className="st-rows">
              {BUCKETS.map((b) => {
                const x = u?.[b.id];
                return (
                  <div key={b.id} className="st-row">
                    <i className="sw" style={{ background: b.color }} />
                    <div><b>{b.label}</b><span>{b.desc}</span></div>
                    <span className="mono sz" title={x?.path}>{x ? bytes(x.bytes) : "…"}</span>
                    {b.id === "generations" ? <a className="btn sm ghost" href="#/library">Open</a>
                      : <button className={cx("btn sm", b.id !== "cache" && "danger")} type="button" disabled={!x?.items || busy !== null} onClick={() => void clean(b.id)}>
                        {b.id === "trash" ? "Empty" : b.id === "cache" ? "Clear" : b.id === "uploads" ? "Clean up" : "Delete"}
                      </button>}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
      <div className="set-card">
        <TextSetting id="out" label="Output folder" help="Leave empty for the default." value={s.output_folder} placeholder="~/.openillusion/outputs" mono onSave={(v) => save({ output_folder: v })} />
        <Toggle title="Strip EXIF and GPS" desc="From your photos and from everything you export."
          checked={s.strip_exif} onChange={(v) => save({ strip_exif: v })} />
      </div>
    </Sec>
  );
}

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
  const vram = l?.vram_total ? `${Math.round(l.vram_total / 2 ** 30)} GB` : null;
  const ok = !!l?.comfyui && !!l.v2;
  const host = (u?: string) => u?.replace(/^https?:\/\//, "");
  return (
    <div className={cx("set-card", ok && "on")}>
      <div className="ech">
        <span className="ic"><I n="cpu" /></span>
        <div><b>ComfyUI on this machine</b><span>{[gpu ?? (l ? "No GPU reported" : "Looking…"), vram].filter(Boolean).join(" · ")}</span></div>
        <span className="state">{!l ? <span className="pill">Checking…</span> : ok ? <span className="pill mint"><I n="check" />Ready</span> : <span className="pill rose">Not ready</span>}</span>
      </div>
      <div className="checks">
        <SRow ok={!!l?.comfyui} pending={!l} label={!l ? "Checking ComfyUI" : l.comfyui ? `ComfyUI ${l.comfyui_version ?? ""} answers` : "ComfyUI isn't answering"} meta={host(l?.comfyui_url)} />
        <SRow ok={!!l?.v2} pending={!l} label={!l ? "Checking Comfy API v2" : l.v2 ? `Comfy API v2 ${l.managed ? "started by OpenIllusion" : "is up"}` : l.reason === "bad_token" ? "Comfy API v2 refused the token" : "Comfy API v2 isn't running"}
          meta={l?.v2 ? host(l.v2_url) : l && !l.proxy_installed ? "pip install comfy-api-proxy" : undefined}
          action={l && !l.v2 && l.proxy_installed ? <button className="btn sm" type="button" onClick={startProxy} disabled={starting} style={{ marginLeft: "auto" }}>{starting ? "Starting…" : "Start it"}</button> : undefined} />
      </div>
      {l && <UpstreamWarning local={l} />}
      <TextSetting id="comfy-url" label="ComfyUI address" help="Change it if ComfyUI runs in Docker on another port, or on another machine." action="Test"
        value={s.local_comfyui_url} placeholder="http://127.0.0.1:8188" mono validate={(v) => (isUrl(v) ? null : "Use a full address, like http://127.0.0.1:8188")}
        onSave={async (v) => {
          if (v !== s.local_comfyui_url && !(await save({ local_comfyui_url: v }))) return false;
          try {
            const st = await api.status(true);
            qc.setQueryData(["status"], st);
            qc.invalidateQueries({ queryKey: ["local-check"] });
            toast(st.local.comfyui ? { text: `ComfyUI ${st.local.comfyui_version ?? ""} answers.`, tone: "ok" } : { text: "Nothing answers at that address.", tone: "warn" });
            return st.local.comfyui;
          } catch (e) {
            toast({ text: errMsg(e), tone: "error" });
            return false;
          }
        }} />
      <details className="adv">
        <summary><I n="sliders" />Advanced<span className="mono">{host(s.local_v2_url)}</span><I n="down" className="chev" /></summary>
        <div className="adv-body">
          <TextSetting id="v2-url" label="Comfy API v2 address" help="Where comfy-api-proxy listens." value={s.local_v2_url} placeholder="http://127.0.0.1:8189" mono validate={(v) => (isUrl(v) ? null : "Use a full address, like http://127.0.0.1:8189")} onSave={(v) => save({ local_v2_url: v })} />
          <SecretSetting id="v2-token" label="Proxy token" help="Only if the proxy was started with --token." saved={s.has_local_token} placeholder={s.has_local_token ? "Saved · paste to replace" : "None"}
            onSave={(v) => save({ local_token: v })} onClear={() => save({ local_token: "", clear_local_token: true })} />
          <Toggle title="Start comfy-api-proxy for me" desc="When the v2 address is on this machine and nothing answers there." checked={s.local_autostart_proxy} onChange={(v) => save({ local_autostart_proxy: v })} />
        </div>
      </details>
    </div>
  );
}

function CloudCard({ s, save }: { s: S; save: Save }) {
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
        <div><b>Comfy Router</b><span>{s.has_key ? `Key ${s.key_hint}${s.key_source === "env" ? " · from COMFY_API_KEY" : ""}` : "No key yet"}</span></div>
        <span className="state">{on ? <span className="pill mint"><I n="check" />Connected</span> : s.has_key ? <span className="pill">{r?.ok === false ? "Key rejected" : "Not tested"}</span> : <span className="pill">Off</span>}</span>
      </div>
      {s.has_key && r?.ok === false && <div className="checks"><SRow ok={false} pending={false} label={r.message ?? r.reason ?? "Router said no"} /></div>}
      <form className="ofield" onSubmit={(e) => { e.preventDefault(); test(); }}>
        <label htmlFor="api-key">Comfy API key</label>
        <div className="irow">
          <input id="api-key" className="input mono" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => { setKey(e.target.value); setResult(null); }}
            placeholder={s.has_key ? `Saved ${s.key_hint}` : "comfyui-…"} aria-invalid={result?.ok === false || undefined} aria-describedby="api-key-result" style={{ fontSize: 12 }} />
          <button className="btn" type="submit" disabled={testing || (!key.trim() && !s.has_key)}>{testing ? "Testing…" : key.trim() ? "Save and test" : "Test"}</button>
        </div>
        <p id="api-key-result" role="status" className="help" style={result ? { color: result.ok ? "var(--mint)" : "#FFB3BD", display: "flex", gap: 6, alignItems: "center" } : undefined}>
          {result ? <><I n={result.ok ? "check" : "info"} />{result.text}</> : "The key stays on this machine and never reaches the browser."}
        </p>
      </form>
      {s.has_key && (
        <details className="adv">
          <summary><I n="sliders" />Cloud runs<span className="mono">{s.max_parallel} at once</span><I n="down" className="chev" /></summary>
          <div className="adv-body">
            <Toggle title="Max parallel runs" desc="Keeps you under Router's per-caller limit.">
              <Stepper value={s.max_parallel} min={1} max={8} onChange={(v) => save({ max_parallel: v })} label="Max parallel runs" />
            </Toggle>
            <Toggle title="Ask before unpriced runs" desc="When Router returns no estimate for a run." checked={s.confirm_unknown_cost} onChange={(v) => save({ confirm_unknown_cost: v })} />
            <Toggle title="Web grounding on by default" desc="Lets supported cloud models look things up on the web." checked={s.grounding_default}
              onChange={(v) => { save({ grounding_default: v }); useApp.getState().setStudio("edit", (e) => ({ params: { ...e.params, grounding: v } })); }} />
            {s.key_source === "settings" && <button className="btn ghost sm" type="button" onClick={forget} style={{ justifySelf: "start" }}><I n="trash" />Forget key</button>}
          </div>
        </details>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- parts */

function Sec({ id, title, desc, later, children }: { id: string; title: string; desc: ReactNode; later?: boolean; children: ReactNode }) {
  return (
    <section id={`set-${id}`} aria-labelledby={`set-${id}-h`} className={cx("set-sec", later && "later")}>
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

/** A labelled row with a switch, or with whatever control it's given. */
function Toggle({ title, desc, checked, onChange, children }: { title: string; desc: string; checked?: boolean; onChange?: (v: boolean) => void; children?: ReactNode }) {
  return (
    <div className="toggle-row">
      <div><b>{title}</b><span>{desc}</span></div>
      {children ?? <Switch label={title} checked={!!checked} onChange={(v) => onChange?.(v)} />}
    </div>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" role="switch" className="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} />;
}

/** A text field that saves on Save or Enter, validates first, and confirms with a check. */
function TextSetting({ id, label, help, value, placeholder, mono, validate, onSave, action }: {
  id: string; label: string; help?: ReactNode; value: string; placeholder?: string; mono?: boolean; validate?: (v: string) => string | null; onSave: (v: string) => Promise<boolean>;
  /** A label other than Save. The button then works on an unchanged value too. */
  action?: string;
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
    if (e || (!dirty && !action)) return;
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
        <button className="btn" type="submit" disabled={(!dirty && !action) || busy} style={{ minWidth: 72 }}>{busy ? (action ? "Testing…" : "Saving…") : saved ? <><I n="check" style={{ color: "var(--mint)" }} />{action ? "OK" : "Saved"}</> : action ?? "Save"}</button>
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
