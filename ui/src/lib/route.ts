import { useEffect, useRef, useState } from "react";

// Hash routes keep the app a single static page at /.
export type Route =
  | { name: "explore"; t?: string; source?: "local" | "cloud" }
  | { name: "library"; shelf?: string }
  | { name: "motion" }
  | { name: "edit" }
  | { name: "generation"; id: string }
  | { name: "settings" }
  | { name: "trash" }
  | { name: "build"; from?: string; edit?: string; cloud?: boolean }
  | { name: "connect" };

export function parse(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "motion":
      return { name: "motion" };
    case "edit":
    case "create":
      return { name: "edit" };
    case "generation":
      return parts[1] ? { name: "generation", id: parts[1] } : { name: "library" };
    case "settings":
      return { name: "settings" };
    case "trash":
      return { name: "trash" };
    case "build":
      return { name: "build", from: q.get("edit") ? undefined : q.get("from") ?? undefined, edit: q.get("edit") || undefined, cloud: q.get("track") === "cloud" || undefined };
    case "connect":
      return { name: "connect" };
    case "library":
      // Templates used to be a Library shelf; old links land on Explore.
      if (q.get("shelf") === "templates") return { name: "explore", t: q.get("t") ?? undefined };
      // So was the trash.
      if (q.get("shelf") === "trash") return { name: "trash" };
      return { name: "library", shelf: q.get("shelf") ?? undefined };
    default:
      return { name: "explore", t: q.get("t") ?? undefined, source: q.get("source") === "cloud" ? "cloud" : q.get("source") === "local" ? "local" : undefined };
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case "generation":
      return `#/generation/${r.id}`;
    case "edit":
      return "#/create";
    case "explore":
      return "#/explore" + (r.t || r.source ? `?${new URLSearchParams({ ...(r.t ? { t: r.t } : {}), ...(r.source ? { source: r.source } : {}) })}` : "");
    case "build":
      return r.edit ? `#/build?edit=${encodeURIComponent(r.edit)}` : r.from ? `#/build?from=${encodeURIComponent(r.from)}` : r.cloud ? "#/build?track=cloud" : "#/build";
    case "library":
      return r.shelf && r.shelf !== "mine" ? `#/library?shelf=${r.shelf}` : "#/library";
    default:
      return `#/${r.name}`;
  }
}

export function go(r: Route) {
  window.location.hash = href(r);
}

let navigationGuard: (() => Promise<boolean>) | null = null;

/** Keep the current screen mounted while its unsaved changes are confirmed. */
export function useNavigationGuard(active: boolean, check: () => Promise<boolean>) {
  const latest = useRef(check);
  latest.current = check;
  useEffect(() => {
    if (!active) return;
    const guard = () => latest.current();
    navigationGuard = guard;
    return () => { if (navigationGuard === guard) navigationGuard = null; };
  }, [active]);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    let current = window.location.hash;
    let revision = 0;
    const on = async () => {
      const next = window.location.hash;
      if (next === current) return;
      const ticket = ++revision;
      if (navigationGuard) {
        history.replaceState(null, "", window.location.pathname + window.location.search + current);
        if (!await navigationGuard() || ticket !== revision) return;
        history.replaceState(null, "", window.location.pathname + window.location.search + next);
      }
      current = next;
      setRoute(parse(next));
      window.dispatchEvent(new Event("oi:navigated"));
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
