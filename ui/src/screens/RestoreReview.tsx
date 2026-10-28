import * as Dialog from "@radix-ui/react-dialog";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type CSSProperties } from "react";
import { Badge, Button, IconButton, Spinner } from "../components/ui";
import { I } from "../components/oi";
import { api } from "../lib/api";
import { bytes, errMsg } from "../lib/format";
import { useProgress } from "../lib/live";
import { useApp } from "../lib/store";

export const isBackup = (f: File) => /\.illusionbackup$/i.test(f.name);

/** Send a backup to the server to be checked, then show what restoring it would add. */
export async function openBackup(f: File) {
  const { setRestoring, toast } = useApp.getState();
  setRestoring({ name: f.name });
  try {
    const review = await api.inspectBackup(f);
    if (useApp.getState().restoring?.name === f.name) setRestoring({ name: f.name, review });
  } catch (e) {
    setRestoring(null);
    toast({ text: errMsg(e), tone: "error" });
  }
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

export function RestoreReview() {
  const restoring = useApp((s) => s.restoring);
  const setRestoring = useApp((s) => s.setRestoring);
  const toast = useApp((s) => s.toast);
  const qc = useQueryClient();
  const progress = useProgress("restore").data;
  const [busy, setBusy] = useState(false);
  const r = restoring?.review;

  const restore = async () => {
    if (!r) return;
    setBusy(true);
    qc.setQueryData(["progress", "restore"], null);
    try {
      const res = await api.restoreBackup(r.token);
      qc.invalidateQueries();
      setRestoring(null);
      const added = [
        res.generations && plural(res.generations, "generation"),
        res.trash && `${res.trash} in trash`,
        res.templates && plural(res.templates, "template"),
        res.characters && plural(res.characters, "character"),
        res.refmods && plural(res.refmods, "RefMod"),
        res.covers && plural(res.covers, "cover"),
        res.settings.length && plural(res.settings.length, "setting"),
      ].filter(Boolean);
      toast(res.damaged.length
        ? { text: `Restored ${added.join(", ") || "nothing new"}. ${plural(res.damaged.length, "generation")} failed its checks and was left out.`, tone: "warn" }
        : { text: added.length ? `Restored ${added.join(", ")}.` : "Nothing new to restore: you already have all of it.", tone: "ok" });
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  const nothing = r && !r.generations.new && !r.trash.new && !r.templates.new && !r.characters?.new && !r.refmods?.new && !r.covers;
  const pct = busy && progress?.total ? progress.done / progress.total : 0;
  return (
    <Dialog.Root open={!!restoring} onOpenChange={(o) => !o && !busy && setRestoring(null)}>
      <Dialog.Portal>
        <Dialog.Overlay className="dlg-bg" />
        <Dialog.Content className="dlg" style={{ "--w": "480px" } as CSSProperties} onInteractOutside={(e) => busy && e.preventDefault()}>
          {restoring && (
            <>
              <div className="dlg-h">
                <div>
                  <Dialog.Title>Restore a backup</Dialog.Title>
                  <Dialog.Description>
                    From <span className="mono">{restoring.name}</span>
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild><IconButton label="Close" disabled={busy}><I n="x" size={11} /></IconButton></Dialog.Close>
              </div>

              <div className="dlg-b">
                {!r ? (
                  <p className="dlg-note"><Spinner size={12} />Checking the backup…</p>
                ) : (
                  <>
                    <section aria-labelledby="rst-h" className="dlg-sec">
                      <div className="dlg-sec-h">
                        <h3 id="rst-h" className="eyebrow">Adds</h3>
                        <span>{nothing ? "You already have all of it" : "Only what you don't have"}</span>
                      </div>
                      <div>
                        <Row label="Generations" n={r.generations.new} desc={`${r.generations.total} in the backup`} />
                        {r.trash.total > 0 && <Row label="In trash" n={r.trash.new} desc={`${r.trash.total} in the backup's trash`} />}
                        <Row label="Templates" n={r.templates.new} desc={`${r.templates.total} of your own in the backup`} />
                        {!!r.characters?.total && <Row label="Characters" n={r.characters.new} desc={`${r.characters.total} in the backup, with their photos`} />}
                        {!!r.refmods?.total && <Row label="RefMods" n={r.refmods.new} desc={`${r.refmods.total} in the backup, into your RefMod folder`} />}
                        {r.covers > 0 && <Row label="Covers" n={r.covers} desc="Covers you set that this install doesn't have" />}
                      </div>
                    </section>
                    {r.templates.conflicts.length > 0 && (
                      <p className="dlg-note"><I n="info" size={12} />{plural(r.templates.conflicts.length, "template")} you've changed since stay as you have them.</p>
                    )}
                    <p className="dlg-note"><I n="lock" size={12} />Nothing you have is changed or removed. Your Comfy Router key isn't in backups.</p>
                    {busy && <div className="bar" style={{ "--p": pct } as CSSProperties} role="progressbar" aria-valuenow={Math.round(pct * 100)}><i /></div>}
                  </>
                )}
              </div>

              <div className="dlg-f">
                <span className="note">{r && `Made ${new Date(r.created * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} · ${bytes(r.size)}`}</span>
                <Dialog.Close asChild><Button tone="ghost" disabled={busy}>Cancel</Button></Dialog.Close>
                <Button tone="primary" disabled={!r || busy || !!nothing} onClick={restore}>{busy ? <Spinner size={12} /> : <I n="undo" size={13} />}Restore</Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ label, n, desc }: { label: string; n: number; desc: string }) {
  return (
    <div className="dlg-orow">
      <span><b>{label}</b><small>{desc}</small></span>
      <Badge tone={n ? "mint" : undefined} className="mono">{n} new</Badge>
    </div>
  );
}
