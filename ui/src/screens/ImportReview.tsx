import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ModeBadge, ValidationRow } from "../components/bits";
import { Badge, Button, IconButton, Spinner } from "../components/ui";
import { I } from "../components/oi";
import { bytes, errMsg, shortModel } from "../lib/format";
import { api } from "../lib/api";
import { go } from "../lib/route";
import { useApp } from "../lib/store";

const SOURCE: Record<string, string> = { generation: "Bundle", png: "PNG text chunk", mp4: "MP4 metadata", link: "Link", json: "Generation JSON" };

export function ImportReview() {
  const review = useApp((s) => s.review);
  const setReview = useApp((s) => s.setReview);
  const loadGeneration = useApp((s) => s.loadGeneration);
  const setStudio = useApp((s) => s.setStudio);
  const toast = useApp((s) => s.toast);
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"add" | "remix" | null>(null);

  const commit = async (then: "add" | "remix") => {
    if (!review) return;
    setBusy(then);
    try {
      const m = await api.commitImport(review.token);
      qc.invalidateQueries({ queryKey: ["generations"] });
      qc.invalidateQueries({ queryKey: ["facets"] });
      setReview(null);
      if (then === "remix") {
        const mode = loadGeneration(m);
        setStudio(mode, { current: null, group: [] });
        go({ name: mode });
      } else {
        toast({ text: `Added to Imported${review.exists ? " as a fork (you already had this generation)" : ""}.`, tone: "ok", action: { label: "Open", run: () => go({ name: "generation", id: m.id }) } });
      }
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(null);
    }
  };

  const m = review?.manifest;
  const refs = m?.inputs.filter((i) => i.slot.startsWith("image:")).length ?? 0;
  const thumb = review?.poster ?? m?.inputs.find((i) => i.thumb)?.thumb ?? null;
  const pkg = !m ? "" : m.variant === "recipe" || !review?.size ? "Recipe only" : m.variant === "full" ? "Full" : m.variant === "light" ? "Light" : "Generation";
  const bad = review?.checks.filter((c) => c.level === "warn").length ?? 0;
  return (
    <Dialog.Root open={!!review} onOpenChange={(o) => !o && setReview(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/55 animate-fade" />
        <Dialog.Content className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(560px,calc(100vw-32px))] max-h-[calc(100vh-48px)] flex flex-col rounded-xl border border-line bg-panel shadow-float outline-none animate-pop">
          {review && m && (
            <>
              <div className="shrink-0 h-12 flex items-center gap-2 pl-4 pr-2 border-b border-line">
                <div className="flex-1 min-w-0 flex items-baseline gap-2">
                  <Dialog.Title className="m-0 text-md font-semibold shrink-0">Review import</Dialog.Title>
                  <Dialog.Description className="m-0 text-xs text-muted truncate">
                    {review.source.kind === "link" ? "From a link" : <>From <span className="font-mono">{review.source.name || "the file"}</span></>} · {SOURCE[review.source.kind]}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild><IconButton label="Close"><I n="x" size={11} /></IconButton></Dialog.Close>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto scroll-y p-4 flex flex-col gap-4">
                <div className="flex gap-3 max-sm:flex-col">
                  <div className="relative shrink-0 w-[168px] aspect-[16/10] rounded-lg overflow-hidden bg-raised flex items-center justify-center text-faint max-sm:w-full">
                    {thumb ? <img src={thumb} alt="" className={review.poster ? "w-full h-full object-cover" : "w-full h-full object-cover opacity-70"} /> : <I n="image" size={20} />}
                    <span className="absolute left-1.5 top-1.5"><ModeBadge mode={m.mode} glass /></span>
                  </div>
                  <div className="flex-1 min-w-0 flex flex-col justify-center gap-1.5">
                    <span className="text-md font-semibold leading-tight line-clamp-2">{m.title}</span>
                    <span className="flex flex-wrap gap-1">
                      <Badge><span className="font-mono">{shortModel(m.engine.model)}</span></Badge>
                      <Badge>{pkg}</Badge>
                      <Badge><span className="tabular">{bytes(review.size || JSON.stringify(m).length)}</span></Badge>
                      {review.exists && <Badge tone="orange">Already in library</Badge>}
                    </span>
                    <span className="text-xs text-muted">{refs} reference{refs === 1 ? "" : "s"} · {review.has_driving ? "driving video included" : "no driving video"}</span>
                  </div>
                </div>

                <section aria-labelledby="checks-h" className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <h3 id="checks-h" className="eyebrow m-0">Checks</h3>
                    <span className="text-xs text-muted">{bad ? `${bad} to review` : "All clear"}</span>
                  </div>
                  <ul aria-label="Validation" className="m-0 p-0 list-none flex flex-col gap-1">
                    {review.checks.map((c, i) => <ValidationRow key={i} {...c} />)}
                  </ul>
                </section>
                <p className="m-0 flex items-center gap-2 text-xs text-muted"><I n="lock" size={12} />Nothing runs on import. Missing nodes and models are listed, never installed.</p>
              </div>

              <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-3 border-t border-line bg-surface/40 rounded-b-xl">
                <span className="flex-1 text-xs text-muted">Saved to the Imported shelf.</span>
                <Button disabled={!!busy} onClick={() => commit("add")}>{busy === "add" ? <Spinner size={12} /> : null}Add to library</Button>
                <Button tone="primary" disabled={!!busy} onClick={() => commit("remix")}>{busy === "remix" ? <Spinner size={12} /> : null}{review.has_driving ? "Open in studio" : "Remix with my video"}</Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
