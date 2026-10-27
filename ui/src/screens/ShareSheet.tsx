import * as Dialog from "@radix-ui/react-dialog";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Badge, Button, IconButton, Notice, Spinner, Toggle, cx } from "../components/ui";
import { I } from "../components/oi";
import { api, type InputItem } from "../lib/api";
import { bytes, errMsg, LICENSES, shortModel } from "../lib/format";
import { useApp } from "../lib/store";

type Variant = "full" | "light" | "recipe";

export function ShareSheet() {
  const id = useApp((s) => s.shareFor);
  const close = useApp((s) => s.share);
  return (
    <Dialog.Root open={!!id} onOpenChange={(o) => !o && close(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 animate-fade" />
        <Dialog.Content className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(540px,calc(100vw-32px))] max-h-[calc(100vh-48px)] flex flex-col rounded-xl border border-line bg-panel shadow-float outline-none animate-pop">
          {id && <Sheet id={id} onClose={() => close(null)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Sheet({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useApp((s) => s.toast);
  const m = useQuery({ queryKey: ["generation", id], queryFn: () => api.generation(id) });
  const sizes = useQuery({ queryKey: ["export-sizes", id], queryFn: () => api.exportSizes(id) });
  const [variant, setVariant] = useState<Variant>("light");
  const [strip, setStrip] = useState(false);
  const [embed, setEmbed] = useState(true);
  const [sfw, setSfw] = useState(false);
  const [rights, setRights] = useState(false);
  const [consent, setConsent] = useState<Record<string, boolean>>({});
  const [licenses, setLicenses] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ name: string; bytes: number; path: string; download: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!m.data) return;
    setConsent(Object.fromEntries(m.data.inputs.map((i) => [i.slot, i.consent])));
    setLicenses(Object.fromEntries(m.data.inputs.map((i) => [i.slot, i.license])));
    setSfw(m.data.attest.sfw);
    setRights(m.data.attest.rights);
  }, [m.data]);

  if (m.error || sizes.error) {
    return (
      <div className="p-4 flex flex-col gap-3">
        <Dialog.Title className="m-0 text-md font-semibold">Export generation</Dialog.Title>
        <Notice tone="error" title="Couldn't prepare the export" actions={<Button size="xs" onClick={() => { m.refetch(); sizes.refetch(); }}>Try again</Button>}>{errMsg(m.error ?? sizes.error)}</Notice>
      </div>
    );
  }
  if (!m.data || !sizes.data) {
    return (
      <div className="p-10 flex justify-center text-muted" aria-busy>
        <Dialog.Title className="sr-only">Export generation</Dialog.Title>
        <Spinner size={18} />
      </div>
    );
  }
  const s = m.data;
  const dropsVideo = variant !== "full" || strip;
  const people = s.inputs.filter((i) => i.contains_person && !(dropsVideo && i.slot.startsWith("video:")));
  const ready = sfw && rights && people.every((i) => consent[i.slot]);
  const attest = { sfw, rights, consent, licenses };
  const missing = [!sfw && "safe for work", !rights && "rights", people.some((i) => !consent[i.slot]) && "consent"].filter(Boolean) as string[];

  const options: { id: Variant; name: string; desc: string; size: number }[] = [
    { id: "light", name: "Light", desc: "References at 768 px, poster, 480p preview. No driving video.", size: sizes.data.light },
    { id: "full", name: "Full", desc: "Original references, driving video, result, ComfyUI workflow.", size: sizes.data.full },
    { id: "recipe", name: "Recipe only", desc: "generation.json with references as hashes and thumbnails.", size: sizes.data.recipe },
  ];

  const save = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const out = await api.exportGeneration(id, { variant, strip_driving: strip, embed_recipe: embed, attest });
      setDone(out);
      const a = document.createElement("a");
      a.href = out.download;
      a.download = out.name;
      a.click();
      qc.invalidateQueries({ queryKey: ["generation", id] });
      qc.invalidateQueries({ queryKey: ["generations"] });
    } catch (e) {
      setProblem(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const copyLink = async () => {
    try {
      const r = await api.recipe(id);
      const url = `${location.origin}/${r.link}`;
      await navigator.clipboard.writeText(url);
      toast({ text: `Link copied (${bytes(url.length)}). The recipe rides in the #fragment and never reaches a server.`, tone: "ok" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };
  const copyJson = async () => {
    try {
      const r = await api.recipe(id);
      await navigator.clipboard.writeText(JSON.stringify(r.recipe, null, 2));
      toast({ text: "Recipe JSON copied.", tone: "ok" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };

  const head = (
    <div className="shrink-0 h-12 flex items-center gap-2 pl-4 pr-2 border-b border-line">
      <div className="flex-1 min-w-0 flex items-baseline gap-2">
        <Dialog.Title className="m-0 text-md font-semibold shrink-0">{done ? "Exported" : "Export generation"}</Dialog.Title>
        <Dialog.Description className="m-0 text-xs text-muted truncate">{s.title} · <span className="font-mono">{shortModel(s.engine.model)}</span></Dialog.Description>
      </div>
      <Dialog.Close asChild><IconButton label="Close"><I n="x" size={11} /></IconButton></Dialog.Close>
    </div>
  );

  if (done) {
    return (
      <>
        {head}
        <div className="p-4 flex flex-col gap-3">
          <div className="flex items-center gap-3 p-3 rounded-lg border border-line bg-surface">
            <span className="w-8 h-8 shrink-0 rounded-md bg-mint/15 text-mint flex items-center justify-center"><I n="check" size={15} /></span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium font-mono truncate">{done.name}</div>
              <div className="text-xs text-muted">{bytes(done.bytes)} · download started</div>
            </div>
          </div>
          <div className="flex items-center gap-2 h-8 pl-2.5 pr-1 rounded-md bg-deep border border-line">
            <span className="flex-1 min-w-0 font-mono text-xs text-soft truncate" title={done.path}>{done.path}</span>
            <IconButton label="Copy path" size={24} onClick={() => navigator.clipboard?.writeText(done.path).then(() => toast({ text: "Path copied.", tone: "ok" }))}><I n="copy" size={12} /></IconButton>
          </div>
        </div>
        <Footer>
          <Button tone="ghost" onClick={() => setDone(null)}>Export another size</Button>
          <span className="flex-1" />
          <Button onClick={() => { const a = document.createElement("a"); a.href = done.download; a.download = done.name; a.click(); }}><I n="download" size={13} />Download again</Button>
          <Button tone="primary" onClick={onClose}>Done</Button>
        </Footer>
      </>
    );
  }

  const assets = s.inputs.filter((i) => !(dropsVideo && i.slot.startsWith("video:")));
  return (
    <>
      {head}
      <div className="flex-1 min-h-0 overflow-y-auto scroll-y p-4 flex flex-col gap-4">
        <fieldset className="m-0 p-0 border-0">
          <legend className="eyebrow mb-2">Package</legend>
          <div role="radiogroup" className="rounded-lg border border-line overflow-hidden">
            {options.map((o) => (
              <label key={o.id} className={cx("flex items-center gap-3 px-3 py-2.5 cursor-pointer border-b border-line last:border-b-0 transition-colors", variant === o.id ? "bg-active" : "hover:bg-white/[0.03]")}>
                <input type="radio" name="variant" checked={variant === o.id} onChange={() => setVariant(o.id)} className="accent-[#F2FF59] w-3.5 h-3.5" />
                <span className="flex-1 min-w-0">
                  <span className="block text-sm font-medium">{o.name}{o.id === "light" && <span className="ml-1.5 text-xs2 text-faint font-normal">Recommended</span>}</span>
                  <span className="block text-xs text-muted">{o.desc}</span>
                </span>
                <span className="font-mono text-xs text-soft tabular whitespace-nowrap">~{bytes(o.size)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col">
          <span className="eyebrow mb-1">Options</span>
          <OptionRow title="Strip driving video" desc={variant !== "full" ? "Already left out of this package" : sizes.data.has_driving ? "Others bring their own clip" : "No driving video in this generation"}>
            <Toggle label="Strip driving video" checked={dropsVideo} disabled={variant !== "full" || !sizes.data.has_driving} onChange={setStrip} />
          </OptionRow>
          <OptionRow title="Embed recipe in output" desc="PNG text chunk or MP4 metadata tag">
            <Toggle label="Embed recipe in output" checked={embed} onChange={setEmbed} />
          </OptionRow>
        </div>

        {assets.length > 0 && (
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Licence per asset</span>
            <ul className="m-0 p-0 list-none rounded-lg border border-line overflow-hidden">
              {assets.map((i: InputItem) => (
                <li key={i.slot} className="h-10 flex items-center gap-2 px-3 border-b border-line last:border-b-0">
                  <span className="font-mono text-xs text-soft flex-1 truncate" title={i.file ?? i.slot}>{i.file?.split("/").pop() ?? i.slot}</span>
                  {i.contains_person && <Badge tone="violet">Person</Badge>}
                  <select aria-label={`Licence for ${i.slot}`} value={licenses[i.slot] ?? i.license} onChange={(e) => setLicenses({ ...licenses, [i.slot]: e.target.value })} className="field h-7 w-[150px] py-0 text-xs">
                    {LICENSES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          </div>
        )}

        <fieldset className="m-0 p-0 border-0 flex flex-col gap-2">
          <legend className="eyebrow mb-2">Before it leaves this machine</legend>
          <div className="rounded-lg border border-line overflow-hidden">
            <Tick checked={sfw} onChange={setSfw}>Safe for work</Tick>
            <Tick checked={rights} onChange={setRights}>I have the rights to every asset in this generation</Tick>
            {people.map((i) => (
              <Tick key={i.slot} checked={!!consent[i.slot]} onChange={(v) => setConsent({ ...consent, [i.slot]: v })}>
                Everyone on camera in <span className="font-mono text-xs">{i.file?.split("/").pop() ?? i.slot}</span> consented
              </Tick>
            ))}
          </div>
        </fieldset>
        {problem && <Notice tone="error" title="Export failed">{problem}</Notice>}
      </div>

      <Footer>
        <span className="flex-1 text-xs text-muted min-w-0">{ready ? "Links carry the recipe only." : `Confirm ${missing.join(", ")} to export.`}</span>
        <Button tone="ghost" disabled={!ready} onClick={copyJson} title="Copy recipe JSON"><I n="copy" size={13} />JSON</Button>
        <Button disabled={!ready || !sizes.data.link_ok} onClick={copyLink} title={!sizes.data.link_ok ? "Too large for a link; save a file instead" : "Copy a shareable link"}><I n="link" size={13} />Link</Button>
        <Button tone="primary" disabled={!ready || busy} onClick={save}>{busy ? <Spinner size={12} /> : <I n="download" size={13} />}{variant === "recipe" ? "Save JSON" : "Save .illusion"}</Button>
      </Footer>
    </>
  );
}

function Footer({ children }: { children: ReactNode }) {
  return <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-t border-line bg-surface/40 rounded-b-xl">{children}</div>;
}

function OptionRow({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-line last:border-b-0">
      <span className="min-w-0"><span className="block text-sm">{title}</span><span className="block text-xs text-muted">{desc}</span></span>
      {children}
    </div>
  );
}

function Tick({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className={cx("flex items-center gap-2.5 px-3 h-10 cursor-pointer text-sm border-b border-line last:border-b-0 transition-colors", checked ? "bg-white/[0.02]" : "hover:bg-white/[0.03]")}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="w-3.5 h-3.5 accent-[#F2FF59]" />
      <span className={cx("min-w-0 truncate", checked ? "text-text" : "text-soft")}>{children}</span>
    </label>
  );
}
