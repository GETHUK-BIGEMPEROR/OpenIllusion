import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { api, type EngineInfo } from "./api";

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/…$/, "").trim();
const human = (id: string) => {
  const s = (id.split("/").pop() ?? id).replace(/[-_]+/g, " ").trim();
  return s ? s[0].toUpperCase() + s.slice(1) : id;
};

type Named = { title: string; model?: string; engine?: string; prompt?: string | null };

/**
 * What a run is called and what goes under it. A run is named after its template; a title someone typed wins.
 * Older runs were titled with their prompt (or "Default · <id>" by scripts); those read as their template too.
 */
export function runName(r: Named, engines?: EngineInfo[]) {
  const id = r.engine || r.model || "";
  const e = engines?.find((x) => x.id === id);
  const tpl = e ? e.label : id ? human(id) : "";
  const v = / · (v\d+)$/.exec(r.title)?.[1];
  const t = r.title.replace(/ · v\d+$/, "").trim();
  const prompt = (r.prompt ?? "").replace(/\s+/g, " ").trim();
  const auto = !t || t === tpl || /^(Edit run|Motion run|Untitled generation)$/.test(t) || /^(Default|Template test) · /.test(t)
    || (!!prompt && norm(prompt).startsWith(norm(t)));
  const name = (auto ? tpl || t : t) + (v ? ` · ${v}` : "");
  return { name, sub: prompt || (auto ? "" : tpl) };
}

export function useRunName() {
  const engines = useQuery({ queryKey: ["engines"], queryFn: () => api.engines(), staleTime: Infinity });
  return useCallback((r: Named) => runName(r, engines.data), [engines.data]);
}
