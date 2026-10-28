import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { cx, gpuName, I } from "../components/oi";
import { LogoMark } from "../components/Shell";
import { UpstreamWarning } from "../components/Studio";
import { api } from "../lib/api";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";

type St = "todo" | "wait" | "ok" | "warn" | "bad";

/** First run: check the ComfyUI on this machine, then open Explore. No account, no key. */
export function Connect() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 5000 });
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines() });
  const l = status.data?.local;
  const [addr, setAddr] = useState<string | null>(null);
  const [addrErr, setAddrErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);

  const host = (u?: string) => (u ?? "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const port = (u?: string) => { try { return new URL(u ?? "").port || "80"; } catch { return "?"; } };
  const local = (engines.data ?? []).filter((e) => e.kind === "local").length;
  const vram = l?.vram_total ? ` · ${Math.round(l.vram_total / 1024 ** 3)} GB` : "";

  const steps: { name: string; st: St; note: string }[] = !l
    ? ["ComfyUI", "Comfy API v2", "GPU", "Templates"].map((name, i) => ({ name, st: i ? "todo" : "wait", note: i ? "" : "looking" }))
    : [
        { name: "ComfyUI", st: l.comfyui ? "ok" : "bad", note: l.comfyui ? `${l.comfyui_version ?? ""} at ${host(l.comfyui_url)}`.trim() : `nothing at ${host(l.comfyui_url)}` },
        {
          name: "Comfy API v2",
          st: !l.comfyui ? "todo" : l.v2 ? "ok" : l.proxy_installed ? "warn" : "bad",
          note: !l.comfyui ? "" : l.v2 ? `${l.managed ? "started" : "running"} on :${port(l.v2_url)}` : l.proxy_installed ? (l.autostart ? "starts on your first run" : "not running") : "comfy-api-proxy not installed",
        },
        { name: "GPU", st: !l.comfyui ? "todo" : l.gpu ? "ok" : "warn", note: !l.comfyui ? "" : l.gpu ? `${gpuName(l.gpu)}${vram}` : "ComfyUI didn't say" },
        { name: "Templates", st: !l.comfyui ? "todo" : engines.isLoading ? "wait" : local ? "ok" : "warn", note: !l.comfyui ? "" : engines.isLoading ? "" : `${local} ready to open` },
      ];
  const ready = !!l?.comfyui;
  const head = !l ? "Looking for your ComfyUI" : ready ? (l.ok ? "Your GPU is ready." : "Almost there.") : "No ComfyUI found yet.";
  const sub = !l
    ? "OpenIllusion runs templates on the ComfyUI already on this machine. No account, no key."
    : ready
      ? `${local || "Every"} template${local === 1 ? "" : "s"} can run right now. Each one opens with a sample, so you can press Run first and change things after.`
      : "Start ComfyUI and this page picks it up on its own. Running it on another port or machine? Put its address below.";

  const finish = async () => {
    await api.onboarded().catch(() => {});
    qc.invalidateQueries({ queryKey: ["status"] });
    go({ name: "explore" });
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
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="welcome">
      <div className="wbox">
        <span className="wlogo"><LogoMark size={64} /></span>
        <div className="wtext">
          <h1 aria-live="polite">{head}</h1>
          <p>{sub}</p>
        </div>
        <ul className="wlist">
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
        {l && !ready && (
          <form className="waddr" onSubmit={(e) => { e.preventDefault(); void saveAddr(); }}>
            <label className="sr" htmlFor="wAddr">ComfyUI address</label>
            <input className="input mono" id="wAddr" spellCheck={false} placeholder="http://127.0.0.1:8188" value={addr ?? l.comfyui_url}
              aria-invalid={!!addrErr || undefined} onChange={(e) => { setAddr(e.target.value); setAddrErr(null); }} />
            <button className="btn" type="submit" disabled={saving || addr == null}>{saving ? "Checking" : "Check"}</button>
            {addrErr && <span role="alert" className="werr">{addrErr}</span>}
          </form>
        )}
        <div className="wgo">
          <button className="btn primary" type="button" disabled={!ready} onClick={finish}><I n="compass" />Open Explore</button>
          {l && !ready && <button className="btn ghost" type="button" onClick={finish}>Look around first</button>}
        </div>
        {ready && <a className="whelp" href="#/settings">ComfyUI somewhere else? Set the address</a>}
        <p className="wfoot">Runs on your machine. Nothing is installed for you: missing nodes and models are listed before a run.</p>
      </div>
    </div>
  );
}
