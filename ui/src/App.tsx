import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Sprite } from "./components/oi";
import { Palette } from "./components/Palette";
import { ConfirmHost } from "./components/Confirm";
import { DropOverlay, Rail, TabBar, Toasts } from "./components/Shell";
import { api } from "./lib/api";
import { errMsg } from "./lib/format";
import { useJobFeed } from "./lib/live";
import { go, useRoute } from "./lib/route";
import { useApp } from "./lib/store";
import { Connect } from "./screens/Connect";
import { EditStudio, MotionStudio } from "./screens/create/CreateStudio";
import { Explore } from "./screens/Explore";
import { GenerationDetail } from "./screens/GenerationDetail";
import { Builder, buildAction, workflowToBuilder } from "./screens/builder/Builder";
import { ImportReview } from "./screens/ImportReview";
import { isBackup, openBackup, RestoreReview } from "./screens/RestoreReview";
import { Library } from "./screens/Library";
import { QueueDrawer } from "./screens/QueueDrawer";
import { Settings } from "./screens/Settings";
import { ShareSheet } from "./screens/ShareSheet";

/** Film grain for the run-in-progress reveal, made once. */
function useNoise() {
  useEffect(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 160;
    const x = c.getContext("2d");
    if (!x) return;
    const d = x.createImageData(160, 160);
    for (let i = 0; i < d.data.length; i += 4) {
      const v = Math.random() * 255;
      d.data[i] = v * 0.95; d.data[i + 1] = v * 0.9; d.data[i + 2] = v; d.data[i + 3] = 255;
    }
    x.putImageData(d, 0, 0);
    document.getElementById("app")?.style.setProperty("--noise", `url(${c.toDataURL()})`);
  }, []);
}

export function App() {
  useJobFeed();
  useNoise();
  const route = useRoute();
  const status = useQuery({ queryKey: ["status"], queryFn: () => api.status() });
  const setReview = useApp((s) => s.setReview);
  const toast = useApp((s) => s.toast);
  const fileInput = useRef<HTMLInputElement>(null);

  // A shared link carries a Recipe-only generation in #gen=…; open it for review.
  useEffect(() => {
    const h = window.location.hash;
    if (h.startsWith("#gen=")) {
      api.importText(h).then(setReview).catch((e) => toast({ text: errMsg(e), tone: "error" }));
      history.replaceState(null, "", window.location.pathname + "#/library?shelf=imported");
    }
  }, [setReview, toast]);

  // Create returns to whichever studio was open last.
  useEffect(() => {
    if (route.name === "edit" || route.name === "motion") useApp.setState({ lastStudio: route.name });
  }, [route.name]);

  // Transient overlays never outlive the screen they were opened on.
  const routeKey = location.hash;
  useEffect(() => {
    const st = useApp.getState();
    if (st.shareFor) st.share(null);
    if (st.queueOpen) st.setQueue(false);
    if (st.palette) st.setPalette(false);
  }, [routeKey]);

  // First run checks the local ComfyUI once, until the user opens Explore from there.
  useEffect(() => {
    const s = status.data;
    if (s && !s.onboarded && route.name !== "connect" && route.name !== "settings") go({ name: "connect" });
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

  // Library's Import button.
  useEffect(() => {
    const on = () => fileInput.current?.click();
    window.addEventListener("oi:import", on);
    return () => window.removeEventListener("oi:import", on);
  }, []);

  const importPick = async (f?: File) => {
    if (!f) return;
    if (isBackup(f)) return void openBackup(f);
    if (await workflowToBuilder(f)) return;
    try {
      setReview(await api.importFile(f));
    } catch (e) {
      toast({ text: errMsg(e), tone: "error", action: buildAction(f) });
    }
  };

  if (route.name === "connect") {
    return (
      <div className="app" id="app">
        <Sprite />
        <div style={{ height: "100%", overflow: "auto" }}><Connect /></div>
        <Toasts />
      </div>
    );
  }

  return (
    <div className="app" id="app" data-route={route.name}>
      <Sprite />
      <div className="shell">
        <Rail route={route} />
        <main className="main">
          {route.name === "explore" && <Explore t={route.t} />}
          {route.name === "library" && <Library shelf={route.shelf} />}
          {route.name === "motion" && <MotionStudio />}
          {route.name === "edit" && <EditStudio />}
          {route.name === "generation" && <GenerationDetail key={route.id} id={route.id} />}
          {route.name === "settings" && <Settings />}
          {route.name === "build" && <Builder from={route.from} />}
        </main>
        <TabBar route={route} />
      </div>
      <input ref={fileInput} type="file" hidden accept=".illusion,.illusionbackup,.json,.png,.webp,.mp4,application/zip" onChange={(e) => { importPick(e.target.files?.[0]); e.target.value = ""; }} />
      <QueueDrawer />
      <Palette />
      <ShareSheet />
      <ImportReview />
      <RestoreReview />
      <ConfirmHost />
      <DropOverlay />
      <Toasts />
    </div>
  );
}
