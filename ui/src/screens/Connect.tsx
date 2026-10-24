import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ArrowRight, Check, Chevron, Cloud, Cpu, External } from "../components/Icons";
import { Wordmark } from "../components/Logo";
import { gpuName } from "../components/Shell";
import { UpstreamWarning } from "../components/Studio";
import { Button, Dot, Spinner, TextInput, cx } from "../components/ui";
import { api } from "../lib/api";
import { errMsg } from "../lib/format";
import { go } from "../lib/route";

/** First run: connect a Comfy key (cloud), your ComfyUI (local), or both. */
export function Connect() {
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status(), refetchInterval: 5000 });
  const l = status.data?.local;
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ ok: boolean | null; reason?: string | null; message?: string; ms?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const [addr, setAddr] = useState<string | null>(null);
  const [v2Addr, setV2Addr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [addrErr, setAddrErr] = useState<string | null>(null);

  const runTest = async () => {
    setBusy(true);
    const t0 = performance.now();
    try {
      const r = await api.testKey(key.trim(), true);
      setTest({ ...r, ms: (performance.now() - t0) / 1000 });
      if (r.ok) setKey("");
      qc.invalidateQueries({ queryKey: ["status"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
    } catch (e) {
      setTest({ ok: false, message: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };
  const saveAddr = async () => {
    const bad = [addr, v2Addr].find((v) => v != null && v.trim() && !/^https?:\/\/[^\s/]+/i.test(v.trim()));
    if (bad) return setAddrErr("Use a full address, like http://127.0.0.1:8188");
    setAddrErr(null);
    setSaving(true);
    try {
      await api.saveSettings({
        ...(addr != null ? { local_comfyui_url: addr.trim() } : {}),
        ...(v2Addr != null ? { local_v2_url: v2Addr.trim() } : {}),
      });
      setAddr(null);
      setV2Addr(null);
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
  const finish = async (to: "templates" | "mine") => {
    await api.onboarded().catch(() => {});
    qc.invalidateQueries({ queryKey: ["status"] });
    go({ name: "library", shelf: to });
  };

  const cloudOk = !!test?.ok || !!status.data?.router.ok;
  const localOk = !!l?.comfyui;
  const ready = cloudOk || localOk;
  const reason = (r?: string | null) =>
    r === "unauthorized" || r === "invalid_api_key" ? "Router refused this key." : r === "unreachable" ? "Couldn't reach api.comfy.org." : r === "insufficient_credits" ? "Key works, but the workspace has no credits." : r ?? "Router said no.";
  const dirty = addr != null || v2Addr != null;

  return (
    <div className="h-full overflow-y-auto scroll-y bg-deep">
      <div className="min-h-full flex flex-col items-center justify-center px-4 py-10 gap-5">
        <div className="w-full max-w-[460px] flex flex-col gap-5">
          <div className="flex flex-col gap-3">
            <Wordmark />
            <div>
              <h1 className="m-0 text-lg font-semibold">Connect an engine</h1>
              <p className="m-0 mt-1 text-sm text-muted">Run in the cloud with your Comfy API key, on your own GPU through ComfyUI, or both. You can change this later in Settings.</p>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-panel overflow-hidden">
            <Block icon={<Cloud size={15} />} title="Cloud" sub="Comfy Router · your API key" done={cloudOk}>
              <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) runTest(); }}>
                <label className="sr-only" htmlFor="key">Comfy API key</label>
                <TextInput id="key" type="password" autoComplete="off" spellCheck={false} placeholder={cloudOk ? "Key saved · paste to replace" : "comfyui-…"} value={key}
                  aria-invalid={test?.ok === false || undefined} aria-describedby="key-help" onChange={(e) => { setKey(e.target.value); setTest(null); }} className="flex-1 h-8 font-mono text-sm" />
                <Button type="submit" size="md" disabled={!key.trim() || busy}>{busy ? <Spinner size={12} /> : null}Connect</Button>
              </form>
              {test && test.ok === false ? (
                <p id="key-help" role="alert" className="m-0 text-xs text-rose-text">{reason(test.reason)}{test.message && test.message !== test.reason ? <span className="text-muted"> {test.message}</span> : null}</p>
              ) : test?.ok ? (
                <p id="key-help" role="status" className="m-0 text-xs text-mint-text flex items-center gap-1"><Check size={12} />Connected in {test.ms?.toFixed(1)} s. Cloud templates are ready.</p>
              ) : (
                <p id="key-help" className="m-0 text-xs text-muted">Kept in OpenIllusion's home folder; never sent to the browser or written into a generation. <a href="https://platform.comfy.org/profile/api-keys?onboarding=router" target="_blank" rel="noreferrer" className="text-violet-light hover:underline inline-flex items-center gap-0.5">Get a key<External size={11} /></a></p>
              )}
            </Block>

            <Block icon={<Cpu size={15} />} title="Local" sub="Your ComfyUI · Comfy API v2" done={localOk && !dirty}>
              <form className="flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); saveAddr(); }}>
                <label htmlFor="comfy-addr" className="text-xs text-muted">ComfyUI address</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <TextInput id="comfy-addr" spellCheck={false} placeholder="http://127.0.0.1:8188" value={addr ?? l?.comfyui_url ?? ""} aria-invalid={!!addrErr || undefined}
                      onChange={(e) => { setAddr(e.target.value); setAddrErr(null); }} className="w-full h-8 pr-[84px] font-mono text-xs" />
                    {addr == null && l && (
                      <span className={cx("absolute right-2 top-1/2 -translate-y-1/2 text-xs2 font-medium inline-flex items-center gap-1", l.comfyui ? "text-mint-text" : "text-rose-text")}>
                        <Dot tone={l.comfyui ? "ok" : "bad"} />{l.comfyui ? "Found" : "Not found"}
                      </span>
                    )}
                  </div>
                  {dirty && <Button type="submit" size="md" disabled={saving}>{saving ? <Spinner size={12} /> : null}Save</Button>}
                </div>
                {addrErr && <span role="alert" className="text-xs text-rose-text">{addrErr}</span>}
                <details className="group">
                  <summary className="h-6 inline-flex items-center gap-1 text-xs text-muted hover:text-soft cursor-pointer select-none">
                    <Chevron size={11} className="-rotate-90 group-open:rotate-0 transition-transform" />Comfy API v2 runs somewhere else
                  </summary>
                  <div className="mt-1.5 flex flex-col gap-1.5">
                    <label className="sr-only" htmlFor="v2-addr">Comfy API v2 address</label>
                    <TextInput id="v2-addr" spellCheck={false} placeholder="http://127.0.0.1:8189" value={v2Addr ?? l?.v2_url ?? ""} onChange={(e) => { setV2Addr(e.target.value); setAddrErr(null); }} className="h-8 font-mono text-xs" />
                    <span className="text-xs text-faint">Runs go there. OpenIllusion reads which ComfyUI it forwards to.</span>
                  </div>
                </details>
              </form>
              {l?.comfyui && (
                <p className="m-0 flex items-center gap-2 text-xs text-muted">
                  <Dot tone={l.v2 ? "ok" : "warn"} />
                  <span className="flex-1">
                    {l.v2 ? "Comfy API v2 is up. Local templates are ready." : l.proxy_installed ? "Comfy API v2 starts on your first local run." : <>Install <span className="font-mono">comfy-api-proxy</span> for local runs.</>}
                    {gpuName(l.gpu) ? <span className="text-faint"> · {gpuName(l.gpu)}</span> : null}
                  </span>
                  {!l.v2 && l.proxy_installed && <Button size="xs" onClick={startProxy} disabled={starting}>{starting ? <Spinner size={11} /> : null}Start now</Button>}
                </p>
              )}
              {l && <UpstreamWarning local={l} />}
            </Block>
          </div>

          <div className="flex items-center gap-2">
            <Button tone="primary" size="lg" disabled={!ready} onClick={() => finish("templates")} title={ready ? undefined : "Connect cloud or local first"}>Browse templates<ArrowRight size={14} /></Button>
            <Button tone="ghost" size="lg" onClick={() => finish("mine")}>Skip for now</Button>
          </div>
          <p className="m-0 text-xs text-faint">Runs on your machine. Hosts nothing. No account. Missing ComfyUI nodes and models are listed before each run; nothing is installed for you.</p>
        </div>
      </div>
    </div>
  );
}

function Block({ icon, title, sub, done, children }: { icon: ReactNode; title: string; sub: string; done?: boolean; children: ReactNode }) {
  return (
    <section className="p-4 border-b border-line last:border-b-0 flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <span className={cx("w-7 h-7 rounded-md flex items-center justify-center", done ? "bg-mint/15 text-mint" : "bg-raised text-muted")}>{done ? <Check size={14} /> : icon}</span>
        <div className="flex-1 min-w-0">
          <h2 className="m-0 text-base font-semibold leading-[18px]">{title}</h2>
          <span className="block text-xs text-muted">{sub}</span>
        </div>
        <span className="text-xs text-faint">{done ? "Connected" : "Optional"}</span>
      </div>
      {children}
    </section>
  );
}
