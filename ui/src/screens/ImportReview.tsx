import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { ValidationRow } from "../components/bits";
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
        <Dialog.Overlay className="dlg-bg" />
        <Dialog.Content className="dlg" style={{ "--w": "560px" } as CSSProperties}>
          {review && m && (
            <>
              <div className="dlg-h">
                <div>
                  <Dialog.Title>Review import</Dialog.Title>
                  <Dialog.Description>
                    {review.source.kind === "link" ? "From a link" : <>From <span className="mono">{review.source.name || "the file"}</span></>} · {SOURCE[review.source.kind]}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild><IconButton label="Close"><I n="x" size={11} /></IconButton></Dialog.Close>
              </div>

              <div className="dlg-b scroll-y">
                <div className="imp-top">
                  <div className="imp-thumb">
                    {thumb ? <img src={thumb} alt="" className={review.poster ? undefined : "dim"} /> : <I n="image" size={20} />}
                    <Badge tone="glass">{m.mode.toUpperCase()}</Badge>
                  </div>
                  <div className="imp-info">
                    <b>{m.title}</b>
                    <span className="imp-badges">
                      <Badge className="mono">{shortModel(m.engine.model)}</Badge>
                      <Badge>{pkg}</Badge>
                      <Badge className="mono">{bytes(review.size || JSON.stringify(m).length)}</Badge>
                      {review.exists && <Badge tone="orange">Already in library</Badge>}
                    </span>
                    <small>{refs} reference{refs === 1 ? "" : "s"} · {review.has_driving ? "driving video included" : "no driving video"}</small>
                  </div>
                </div>

                <section aria-labelledby="checks-h" className="dlg-sec">
                  <div className="dlg-sec-h">
                    <h3 id="checks-h" className="eyebrow">Checks</h3>
                    <span>{bad ? `${bad} to review` : "All clear"}</span>
                  </div>
                  <ul aria-label="Validation" className="vlist">
                    {review.checks.map((c, i) => <ValidationRow key={i} {...c} />)}
                  </ul>
                </section>
                <p className="dlg-note"><I n="lock" size={12} />Nothing runs on import. Missing nodes and models are listed, never installed.</p>
              </div>

              <div className="dlg-f">
                <span className="note">Saved to the Imported shelf.</span>
                <Button disabled={!!busy} onClick={() => commit("add")}>{busy === "add" ? <Spinner size={12} /> : null}Add to library</Button>
                <Button tone="primary" disabled={!!busy} onClick={() => commit("remix")}>{busy === "remix" ? <Spinner size={12} /> : null}{review.has_driving ? "Open in Create" : "Open in Create with my video"}</Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
