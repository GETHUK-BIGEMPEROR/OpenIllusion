import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, type ReactNode } from "react";
import { DropOverlay, Rail, StatusBar, Toasts, TopBar } from "./components/Shell";
import { api } from "./lib/api";
import { errMsg } from "./lib/format";
import { useJobFeed } from "./lib/live";
import { go, href, useRoute, type Route } from "./lib/route";
import { useApp } from "./lib/store";
import { Connect } from "./screens/Connect";
import { EditStudio } from "./screens/EditStudio";
import { ImportReview } from "./screens/ImportReview";
import { Library } from "./screens/Library";
import { MotionStudio } from "./screens/MotionStudio";
import { QueueDrawer } from "./screens/QueueDrawer";
import { GenerationDetail } from "./screens/GenerationDetail";
import { Settings } from "./screens/Settings";
import { ShareSheet } from "./screens/ShareSheet";

const TITLES = { library: "Library", motion: "Motion", edit: "Edit", generation: "Library", settings: "Settings", connect: "" } as const;

export function App() {
  useJobFeed();
  const route = useRoute();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const setReview = useApp((s) => s.setReview);
  const toast = useApp((s) => s.toast);
  const studio = useApp((s) => (route.name === "motion" ? s.motion : route.name === "edit" ? s.edit : null));
  const fileInput = useRef<HTMLInputElement>(null);
  const genId = route.name === "generation" ? route.id : null;
  const gen = useQuery({ queryKey: ["generation", genId], queryFn: () => api.generation(genId!), enabled: !!genId, retry: false });

  // A shared link carries a Recipe-only generation in #gen=…; open it for review.
  useEffect(() => {
    const h = window.location.hash;
    if (h.startsWith("#gen=")) {
      api.importText(h).then(setReview).catch((e) => toast({ text: errMsg(e), tone: "error" }));
      history.replaceState(null, "", window.location.pathname + "#/library?shelf=imported");
    }
  }, [setReview, toast]);

  // Transient overlays never outlive the screen they were opened on.
  const routeKey = location.hash;
  useEffect(() => {
    const st = useApp.getState();
    if (st.shareFor) st.share(null);
  }, [routeKey]);

  // First run goes to Connect until a key is saved or the user skips.
  useEffect(() => {
    const s = status.data;
    if (s && !s.has_key && !s.onboarded && route.name !== "connect" && route.name !== "settings") go({ name: "connect" });
  }, [status.data, route.name]);

  useEffect(() => {
    const on = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA"].includes(t.tagName)) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (text.includes("#gen=") || /^\s*\{[\s\S]*"openillusion\.illusion"/.test(text)) {
        api.importText(text).then(setReview).catch((err) => toast({ text: errMsg(err), tone: "error" }));
      }
    };
    window.addEventListener("paste", on);
    return () => window.removeEventListener("paste", on);
  }, [setReview, toast]);

  if (route.name === "connect") return <><Connect /><Toasts /></>;

  const crumbs: { label: ReactNode; href?: string }[] = [{ label: TITLES[route.name], href: href(route.name === "generation" ? { name: "library", shelf: "mine" } : ({ name: route.name } as Route)) }];
  if (route.name === "motion" || route.name === "edit") crumbs.push({ label: studio?.title || (studio?.forked_from ? "Untitled remix" : "Untitled draft") });
  if (route.name === "generation") crumbs.push({ label: gen.data?.title || (gen.isLoading ? "…" : "Generation") });

  const importPick = async (f?: File) => {
    if (!f) return;
    try {
      setReview(await api.importFile(f));
    } catch (e) {
      toast({ text: errMsg(e), tone: "error" });
    }
  };

  return (
    <div className="h-full flex max-lg:flex-col bg-bg overflow-hidden">
      <Rail route={route} />
      <div className="flex-1 min-w-0 min-h-0 flex flex-col">
        <TopBar crumbs={crumbs} onImport={() => fileInput.current?.click()} />
        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          {route.name === "library" && <Library shelf={route.shelf} t={route.t} />}
          {route.name === "motion" && <MotionStudio />}
          {route.name === "edit" && <EditStudio />}
          {route.name === "generation" && <GenerationDetail key={route.id} id={route.id} />}
          {route.name === "settings" && <Settings />}
        </main>
        <StatusBar />
      </div>
      <input ref={fileInput} type="file" hidden accept=".illusion,.json,.png,.mp4,application/zip" onChange={(e) => { importPick(e.target.files?.[0]); e.target.value = ""; }} />
      <QueueDrawer />
      <ShareSheet />
      <ImportReview />
      <DropOverlay />
      <Toasts />
    </div>
  );
}
