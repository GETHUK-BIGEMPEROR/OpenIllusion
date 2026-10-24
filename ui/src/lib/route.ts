import { useEffect, useState } from "react";

// Hash routes keep the app a single static page at /.
export type Route =
  | { name: "library"; shelf?: string; t?: string }
  | { name: "motion" }
  | { name: "edit" }
  | { name: "generation"; id: string }
  | { name: "settings" }
  | { name: "connect" };

export function parse(hash: string): Route {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").filter(Boolean);
  const q = new URLSearchParams(query);
  switch (parts[0]) {
    case "motion":
      return { name: "motion" };
    case "edit":
      return { name: "edit" };
    case "generation":
      return parts[1] ? { name: "generation", id: parts[1] } : { name: "library" };
    case "settings":
      return { name: "settings" };
    case "connect":
      return { name: "connect" };
    default:
      return { name: "library", shelf: q.get("shelf") ?? undefined, t: q.get("t") ?? undefined };
  }
}

export function href(r: Route): string {
  switch (r.name) {
    case "generation":
      return `#/generation/${r.id}`;
    case "library": {
      const q = new URLSearchParams();
      if (r.shelf) q.set("shelf", r.shelf);
      if (r.t) q.set("t", r.t);
      const s = q.toString();
      return s ? `#/library?${s}` : "#/library";
    }
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
