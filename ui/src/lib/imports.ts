// What an import comes back as: a shared template is added at once and shown on Explore; a generation is reviewed first.
import type { EngineInfo, Imported } from "./api";
import { queryClient } from "./query";
import { go } from "./route";
import { useApp } from "./store";

export function landImport(r: Imported) {
  const st = useApp.getState();
  if (!("template" in r)) return st.setReview(r);
  const e = r.template;
  queryClient.setQueryData<EngineInfo[]>(["engines"], (list) => (list ? [...list.filter((x) => x.id !== e.id), e] : list));
  void queryClient.invalidateQueries({ queryKey: ["engines"] });
  go({ name: "explore", t: e.id });
  st.toast({ text: `${e.label} added to Explore.`, tone: "ok" });
}
