import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../openillusion/static and served by the OpenIllusion server at /.
// `npm run dev` proxies the API and its websocket to a running server.
const server = process.env.OPENILLUSION_URL ?? "http://127.0.0.1:7870";

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: { outDir: "../openillusion/static", emptyOutDir: true, assetsDir: "assets", chunkSizeWarningLimit: 900 },
  server: {
    port: 5178,
    proxy: {
      "/api/ws": { target: server.replace(/^http/, "ws"), ws: true },
      "/api": server,
    },
  },
});
