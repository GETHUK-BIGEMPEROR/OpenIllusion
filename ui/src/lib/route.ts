import { useEffect, useState } from "react";

// Hash routes keep the app a single static page at /.
export type Route =
  | { name: "explore"; t?: string }
  | { name: "library"; shelf?: string }
  | { name: "motion" }
  | { name: "edit" }
  | { name: "generation"; id: string }
  | { name: "settings" }
  | { name: "trash" }
  | { name: "build"; from?: string; cloud?: boolean }
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
      return { name: "build", from: q.get("from") ?? undefined, cloud: q.get("track") === "cloud" || undefined };
    case "connect":
      return { name: "connect" };
    case "library":
      // Templates used to be a Library shelf; old links land on Explore.
      if (q.get("shelf") === "templates") return { name: "explore", t: q.get("t") ?? undefined };
      // So was the trash.
      if (q.get("shelf") === "trash") return { name: "trash" };
      return { name: "library", shelf: q.get("shelf") ?? undefined };
    default:
      return { name: "explore", t: q.get("t") ?? undefined };
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case "generation":
      return `#/generation/${r.id}`;
    case "edit":
      return "#/create";
    case "explore":
      return r.t ? `#/explore?t=${encodeURIComponent(r.t)}` : "#/explore";
    case "build":
      return r.from ? `#/build?from=${encodeURIComponent(r.from)}` : r.cloud ? "#/build?track=cloud" : "#/build";
    case "library":
      return r.shelf && r.shelf !== "mine" ? `#/library?shelf=${r.shelf}` : "#/library";
    default:
      return `#/${r.name}`;
  }
}

export function go(r: Route) {
  window.location.hash = href(r);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parse(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
