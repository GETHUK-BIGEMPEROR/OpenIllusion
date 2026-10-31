import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { CPU_NOTE, cx, gpuName, I, onCpu } from "../components/oi";
import { LogoMark } from "../components/Shell";
import { UpstreamWarning } from "../components/Studio";
import { api } from "../lib/api";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";
import { useLocalReadiness } from "../lib/readiness";

type St = "todo" | "wait" | "ok" | "warn" | "bad";

/** First run: choose local hardware or cloud. Either path can be skipped to browse. */
export function Connect() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 5000 });
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines() });
  const l = status.data?.local;
  const [addr, setAddr] = useState<string | null>(null);
  const [addrErr, setAddrErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [path, setPath] = useState<"local" | "cloud" | null>(null);
  const [key, setKey] = useState("");
  const [testing, setTesting] = useState(false);
  const [keyResult, setKeyResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);

  const host = (u?: string) => (u ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const port = (u?: string) => { try { return new URL(u ?? "").port || "80"; } catch { return "?"; } };
  const locals = (engines.data ?? []).filter((e) => e.kind === "local" && !e.draft && !e.hidden);
  const local = locals.length;
  // How many have their nodes and models in this ComfyUI: a fresh one has none of the models yet.
  const runnable = useLocalReadiness(engines.data ?? [], status.data, path === "local");
  const can = local ? runnable.data?.reachable ? Object.values(runnable.data.templates).filter(c => c.ok).length : undefined : 0;
  const vram = l?.vram_total ? ` · ${Math.round(l.vram_total / 1024 ** 3)} GB` : "";
  const cpu = onCpu(l?.gpu);

  const steps: { name: string; st: St; note: string }[] = !l
    ? ["ComfyUI", "Comfy API v2", "GPU", "Templates"].map((name, i) => ({ name, st: i ? "todo" : "wait", note: i ? "" : "looking" }))
    : [
        { name: "ComfyUI", st: l.comfyui ? "ok" : "bad", note: l.comfyui ? `${l.comfyui_version ?? ""} at ${host(l.comfyui_url)}`.trim() : `nothing at ${host(l.comfyui_url)}` },
        {
          name: "Comfy API v2",
          st: !l.comfyui ? "todo" : l.v2 ? "ok" : l.proxy_installed ? "warn" : "bad",
          note: !l.comfyui ? "" : l.v2 ? `${l.managed ? "started" : "running"} on :${port(l.v2_url)}` : l.proxy_installed ? (l.autostart ? "starts on your first run" : "not running") : "comfy-api-proxy not installed",
        },
        {
          name: "GPU",
          st: !l.comfyui ? "todo" : l.gpu && !cpu ? "ok" : "warn",
          note: !l.comfyui ? "" : cpu ? "none: ComfyUI runs on CPU" : l.gpu ? `${gpuName(l.gpu)}${vram}` : "ComfyUI didn't say",
        },
        {
          name: "Templates",
          st: !l.comfyui ? "todo" : runnable.isError || runnable.data?.reachable === false ? "warn" : can == null ? "wait" : can ? "ok" : "warn",
          note: !l.comfyui ? "" : runnable.isError || runnable.data?.reachable === false ? "couldn't check" : can == null ? "" : `${can} of ${local} have their models`,
        },
      ];
  const ready = !!l?.comfyui;
  const head = !l ? "Looking for your ComfyUI" : ready ? (cpu ? "Your ComfyUI runs on CPU." : l.ok ? "Your ComfyUI is ready." : "Almost there.") : "No ComfyUI found yet.";
  const sub = !l
    ? "OpenIllusion runs templates on the ComfyUI already on this machine. No account, no key."
    : !ready
      ? "Start ComfyUI and this page picks it up on its own. Running it on another port or machine? Put its address below."
      : cpu
        ? CPU_NOTE
      : runnable.isError || runnable.data?.reachable === false
        ? "ComfyUI answered, but its template requirements couldn't be checked. You can still explore and review them before a run."
      : can == null
        ? "Checking which templates have their models in this ComfyUI."
        : can === local
          ? "Every local template's nodes and models are installed. Open one to review its sample and settings before running."
          : can
            ? `${can} of ${local} templates have their nodes and models. The others list what they still need, with folders and download links where available.`
            : "No template's models are in this ComfyUI yet. Open one and it lists the models it needs, each with its folder and a download link. Cloud templates need only a Comfy key.";

  const finish = async (browse = false) => {
    setFinishing(true);
    setFinishError(null);
    try {
      await api.onboarded();
      qc.setQueryData(["status"], (old: typeof status.data) => old ? { ...old, onboarded: true } : old);
      go({ name: "explore", source: browse ? undefined : path ?? undefined });
    } catch (e) {
      setFinishError(`Couldn't finish setup: ${errMsg(e)}`);
    } finally {
      setFinishing(false);
    }
  };
  const testKey = async () => {
    setTesting(true);
    setKeyResult(null);
    try {
      const result = await api.testKey(key.trim(), !!key.trim());
      setKeyResult({ ok: !!result.ok, text: result.ok ? "Connected. You're ready to explore cloud templates." : result.message || "Couldn't connect. Check your key and try again." });
      if (result.ok) {
        setKey("");
        qc.setQueryData(["status"], (old: typeof status.data) => old ? { ...old, has_key: true, router: result } : old);
        qc.invalidateQueries({ queryKey: ["settings"] });
      }
    } catch (e) {
      setKeyResult({ ok: false, text: errMsg(e) });
    } finally {
      setTesting(false);
    }
  };
  const saveAddr = async () => {
    const v = (addr ?? "").trim();
    if (!/^https?:\/\/[^\s/]+/i.test(v)) return setAddrErr("Use a full address, like http://127.0.0.1:8188");
    setAddrErr(null);
    setSaving(true);
    try {
      await api.saveSettings({ local_comfyui_url: v });
      setAddr(null);
      qc.setQueryData(["status"], await api.status(true));
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      setAddrErr(errMsg(e));
    } finally {
      setSaving(false);
    }
  };
  const startProxy = async () => {
    setStarting(true);
    try {
      const r = await api.startProxy();
      qc.setQueryData(["status"], (old: any) => (old ? { ...old, local: r.local } : old));
      if (!r.ok) setAddrErr("The proxy couldn't start. Review your local connection in Settings.");
    } catch (e) {
      setAddrErr(errMsg(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="welcome">
      <div className="wbox">
        <span className="wlogo"><LogoMark size={64} /></span>
        <div className="wtext">
          <h1 aria-live="polite">{path === "local" ? head : path === "cloud" ? "Create without a local GPU." : "Where would you like to create?"}</h1>
          <p>{path === "local" ? sub : path === "cloud" ? "Use cloud models through Comfy Router. Add your Comfy API key; no ComfyUI installation needed." : "Use your own ComfyUI or connect to cloud models. You can use both, and change your setup anytime."}</p>
        </div>
        <div className="wpaths" role="group" aria-label="Where to run">
          <button type="button" className={cx("wpath", path === "local" && "on")} aria-pressed={path === "local"} onClick={() => setPath("local")}><I n="cpu" /><b>Use my GPU</b><span>Your ComfyUI, your models.<br />No cloud key needed.</span></button>
          <button type="button" className={cx("wpath", path === "cloud" && "on")} aria-pressed={path === "cloud"} onClick={() => setPath("cloud")}><I n="cloud" /><b>Use cloud</b><span>No local setup.<br />Runs billed by the provider.</span></button>
        </div>
        {path === "local" && <><ul className="wlist">
          {steps.map((x, i) => (
            <li key={x.name} className={cx("witem", x.st)} style={{ "--d": `${i * 90}ms` } as CSSProperties}>
              <span className="st" aria-hidden>{x.st === "ok" ? <I n="check" /> : x.st === "bad" ? <I n="x" /> : x.st === "warn" ? <I n="alert" /> : null}</span>
              <span className="nm">{x.name}</span>
              <span className="mono">{x.note}</span>
              {x.name === "Comfy API v2" && x.st === "warn" && (
                <button className="btn sm" type="button" onClick={startProxy} disabled={starting}>{starting ? "Starting" : "Start it"}</button>
              )}
            </li>
          ))}
        </ul>
        {l && <UpstreamWarning local={l} />}
        {(runnable.isError || runnable.data?.reachable === false) && <p className="werr" role="status">Couldn't check the templates' models yet. You can still explore; check your ComfyUI connection before running.</p>}
        {l && !ready && (
          <form className="waddr" onSubmit={(e) => { e.preventDefault(); void saveAddr(); }}>
            <label className="sr" htmlFor="wAddr">ComfyUI address</label>
            <input className="input mono" id="wAddr" spellCheck={false} placeholder="http://127.0.0.1:8188" value={addr ?? l.comfyui_url}
              aria-invalid={!!addrErr || undefined} onChange={(e) => { setAddr(e.target.value); setAddrErr(null); }} />
            <button className="btn" type="submit" disabled={saving || addr == null}>{saving ? "Checking" : "Check"}</button>
          </form>
        )}
        {addrErr && <p role="alert" className="werr">{addrErr}</p>}
        </>}
        {path === "cloud" && <form className="wcloud" onSubmit={ev => { ev.preventDefault(); void testKey(); }}>
          {status.data?.router.ok && <p className="wconnected"><I n="check" />Cloud connection is ready</p>}
          <label htmlFor="welcome-key">Comfy API key</label>
          <div className="wkey-row"><input id="welcome-key" className="input mono" type="password" autoComplete="off" spellCheck={false} value={key}
            placeholder={status.data?.has_key ? "Paste a key to replace yours" : "comfyui-…"} onChange={ev => { setKey(ev.target.value); setKeyResult(null); }}
            aria-describedby="welcome-key-help welcome-key-result" aria-invalid={keyResult?.ok === false || undefined} />
          <button className="btn" type="submit" disabled={testing || (!key.trim() && !status.data?.has_key)}>{testing ? "Connecting…" : key.trim() ? "Connect" : "Test connection"}</button></div>
          <p id="welcome-key-help">Your key stays in this browser and the server's memory, never its disk. Pricing depends on the model and settings; this app cannot quote a cost yet.</p>
          <p id="welcome-key-result" role="status" className={cx("wkey-result", keyResult?.ok ? "ok" : "bad")}>{keyResult?.text}</p>
        </form>}
        <div className="wgo">
          {path && <button className="btn primary" type="button" disabled={finishing || (path === "local" ? !ready : !status.data?.router.ok || testing || !!key.trim())} onClick={() => void finish()}><I n="compass" />{finishing ? "Opening…" : path === "cloud" ? "Explore cloud templates" : "Explore local templates"}</button>}
          <button className="btn ghost" type="button" disabled={finishing} onClick={() => void finish(true)}>Look around first</button>
        </div>
        {finishError && <p role="alert" className="werr">{finishError}</p>}
        {path === "local" && ready && <a className="whelp" href="#/settings">ComfyUI somewhere else? Set the address</a>}
        <p className="wfoot">Your library stays on this machine. Local runs use your ComfyUI; cloud runs send their inputs to the provider.</p>
      </div>
    </div>
  );
}
