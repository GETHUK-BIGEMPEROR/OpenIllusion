import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, fileUrl } from "../lib/api";
import { ago } from "../lib/format";
import { go, href, type Route } from "../lib/route";
import { useApp } from "../lib/store";
import { appRoot, cx, I } from "./oi";
import type { IconName } from "./sprite";
import { tplModel, tplName } from "./TemplateCard";

type Row = { key: string; group: string; label: string; small?: string; img?: string | null; icon?: IconName; run: () => void };

const PAGES: { route: Route; icon: IconName; label: string }[] = [
  { route: { name: "explore" }, icon: "compass", label: "Explore templates" },
  { route: { name: "edit" }, icon: "wand", label: "Create" },
  { route: { name: "library" }, icon: "library", label: "Library" },
  { route: { name: "trash" }, icon: "trash", label: "Trash" },
  { route: { name: "settings" }, icon: "sliders", label: "Settings" },
];

/** Ctrl K: templates, past prompts and pages in one list. */
export function Palette() {
  const open = useApp((s) => s.palette);
  const setOpen = useApp((s) => s.setPalette);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useApp.getState().palette);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [setOpen]);

  if (!open) return null;
  return createPortal(<PaletteBody close={() => setOpen(false)} />, appRoot());
}

function PaletteBody({ close }: { close: () => void }) {
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const [dq, setDq] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const openTemplate = useApp((s) => s.openTemplate);
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 200); return () => clearTimeout(t); }, [q]);
  const gens = useQuery({ queryKey: ["generations", "palette", dq], queryFn: () => api.generations({ q: dq }), enabled: dq.length > 1, staleTime: 10_000 });
  useEffect(() => { input.current?.focus(); }, []);

  const rows = useMemo<Row[]>(() => {
    const s = q.trim().toLowerCase();
    const tpl = (engines.data ?? [])
      .filter((e) => !s || `${e.label} ${(e.tags ?? []).join(" ")} ${e.blurb}`.toLowerCase().includes(s))
      .slice(0, s ? 8 : 5)
      .map<Row>((e) => ({ key: `t:${e.id}`, group: "Templates", label: tplName(e), small: tplModel(e), img: e.cover, run: () => { openTemplate(e.mode, e.id); go({ name: e.mode }); } }));
    const gs = (s.length > 1 ? gens.data ?? [] : [])
      .slice(0, 6)
      .map<Row>((g) => ({ key: `g:${g.id}`, group: "Generations", label: g.prompt || g.title, small: ago(g.created), img: g.poster ? fileUrl(g.id, g.poster) : null, icon: "image", run: () => go({ name: "generation", id: g.id }) }));
    const pages = PAGES.filter((p) => !s || p.label.toLowerCase().includes(s))
      .map<Row>((p) => ({ key: `p:${p.label}`, group: "Go to", label: p.label, icon: p.icon, run: () => { location.hash = href(p.route.name === "edit" ? { name: useApp.getState().lastStudio } : p.route); } }));
    return [...tpl, ...gs, ...pages];
  }, [q, engines.data, gens.data, openTemplate]);

  useEffect(() => setHi(0), [q]);
  const pick = (r?: Row) => { if (!r) return; close(); r.run(); };

  let last = "";
  return (
    <div>
      <div className="overlay" onClick={close} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="pin">
          <I n="search" />
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates, prompts and pages" autoComplete="off"
            role="combobox" aria-expanded="true" aria-controls="pres" aria-activedescendant={rows[hi] ? `pr-${hi}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape") { e.preventDefault(); close(); }
              else if (e.key === "ArrowDown") { e.preventDefault(); setHi((h) => Math.min(rows.length - 1, h + 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
              else if (e.key === "Enter") { e.preventDefault(); pick(rows[hi]); }
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="res" id="pres" role="listbox">
          {rows.length ? rows.map((r, i) => {
            const head = r.group !== last ? <h6>{r.group}</h6> : null;
            last = r.group;
            return (
              <div key={r.key}>
                {head}
                <button id={`pr-${i}`} role="option" aria-selected={i === hi} className={cx("r", i === hi && "hi")} type="button" onMouseEnter={() => setHi(i)} onClick={() => pick(r)}>
                  {r.img ? <img src={r.img} alt="" /> : <span className="ic"><I n={r.icon ?? "image"} /></span>}
                  <span>{r.label}</span>
                  {r.small && <small>{r.small}</small>}
                </button>
              </div>
            );
          }) : (
            <div className="empty" style={{ padding: 30 }}><h3>No matches</h3><p>Try a template name like “hat” or a word from a prompt.</p></div>
          )}
        </div>
      </div>
    </div>
  );
}
