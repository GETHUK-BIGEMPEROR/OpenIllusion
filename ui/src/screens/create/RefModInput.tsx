// Create's RefMod inputs: a card in the inputs list, and the picker it opens on the stage.
// The picker lists the RefMod folder (Settings), where Character Lab saves what it makes. A RefMod a Lab character
// was made into also puts their face in the photo input the template pairs with it.
import { useQuery } from "@tanstack/react-query";
import { cx, EmptyBox, I } from "../../components/oi";
import { Spinner } from "../../components/ui";
import { api, type EngineInfo, type RefModFile } from "../../lib/api";
import { withRefmod } from "../../lib/characters";
import { ago, bytes } from "../../lib/format";
import type { RefModField } from "../../lib/fields";
import type { StudioState } from "../../lib/store";
import type { SetS } from "./shared";

/** What's in the RefMod folder. Character Lab refreshes it when it makes one. */
export const useRefmods = () => useQuery({ queryKey: ["refmods"], queryFn: api.refmods, refetchOnWindowFocus: true });

const whoOf = (r: RefModFile) => r.character?.name ?? r.label;

/** One RefMod input as a card: which RefMod it runs with. Pick it to choose on the stage. */
export function RefModCard({ e, f, s, set, on, onPick }: { e: EngineInfo; f: RefModField; s: StudioState; set: SetS; on: boolean; onPick: () => void }) {
  const q = useRefmods();
  const pick = s.mods?.[f.key];
  const r = pick?.file ? q.data?.refmods.find((x) => x.name === pick.file) : undefined;
  const gone = !!pick?.file && !!q.data && !r;
  const face = r?.character?.face;
  return (
    <div className={cx("fcard", on && "on", !pick && "vacant", gone && "missing")}>
      <button className="fcard-main" type="button" aria-current={on || undefined} onClick={onPick} title={pick ? `Change ${f.label}` : `Pick ${f.label}`}>
        {face ? <span className="thumb"><img src={face} alt="" /></span> : <span className={cx("thumb", !pick && "vacant")}><I n="person" /></span>}
        <span className="fcard-b">
          <span className="fcard-l1"><b>{f.label}</b><small>{pick ? pick.name : "Needed to run"}</small></span>
          {gone ? <span className="fline bad"><i className="dot" /><span>Not in your RefMod folder: pick another</span></span>
            : r ? <span className="fline char-st ok"><i className="dot" /><span className="mono">{r.name}</span></span>
            : pick ? <span className="fline char-st ok"><i className="dot" /><span>This run's RefMod, kept with it</span></span>
            : <span className="fline"><span>Pick one from your RefMod folder</span></span>}
        </span>
      </button>
      {pick && (
        <span className="fcard-acts">
          <button className="icon-btn sm" type="button" onClick={() => set((st) => withRefmod(st, e, f.key, null))} aria-label={`Clear ${f.label}`} title="Clear"><I n="x" /></button>
        </span>
      )}
    </div>
  );
}

/** The stage while a RefMod input is picked: every RefMod in the folder, to choose from. */
export function RefModStage({ e, f, s, set }: { e: EngineInfo; f: RefModField; s: StudioState; set: SetS }) {
  const q = useRefmods();
  const list = q.data?.refmods ?? [];
  const pick = s.mods?.[f.key];
  if (q.isLoading) return <div className="ed-empty"><Spinner size={18} /></div>;
  if (!list.length) {
    return (
      <div className="ed-empty">
        <EmptyBox icon="person" title="No RefMods yet" action={<a className="btn primary" href="#/characters"><I n="plus" />Open Character Lab</a>}>
          Character Lab makes one from a few photos and saves it to your RefMod folder, <span className="mono">{q.data?.folder}</span>. RefMods you put there yourself show up too.
        </EmptyBox>
      </div>
    );
  }
  return (
    <div className="cpick">
      <div className="cpick-h">
        <h3>{f.label}</h3>
        <p>{f.help ?? f.hint ?? "Who goes into the clip. RefMods from your RefMod folder; one made in Character Lab also puts its face in the photo input."}</p>
        <a className="btn sm ghost" href="#/characters"><I n="plus" />Character Lab</a>
      </div>
      <div className="cpick-grid" role="listbox" aria-label={f.label}>
        {list.map((r) => {
          const on = pick?.file === r.name;
          return (
            <div key={r.name} className={cx("cpick-c", on && "on")}>
              <button type="button" role="option" aria-selected={on} onClick={() => set((st) => withRefmod(st, e, f.key, r))} title={r.name}>
                {r.character?.face ? <img src={r.character.face} alt="" loading="lazy" /> : <span className="cpick-ph"><I n="person" /></span>}
                <b>{whoOf(r)}</b>
                <small className="mono">{r.character ? r.name : `${bytes(r.bytes)} · ${ago(r.modified).toLowerCase()}`}</small>
              </button>
            </div>
          );
        })}
      </div>
      <p className="char-hint">From <span className="mono">{q.data?.folder}</span>. Change the folder in Settings.</p>
    </div>
  );
}
