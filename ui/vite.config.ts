import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Built into ../server/static and served by the OpenIllusion server at /.
// `npm run dev` proxies the API and its websocket to a running server.
const server = process.env.OPENILLUSION_URL ?? "http://127.0.0.1:7870";

// The server only takes writes from its own origin. Pages served by this dev server are
// that app too, so their Origin is rewritten to the server's; any other site's is left alone.
const DEV = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):5178$/;
const sameOrigin = (proxy: import("http-proxy").Server) => {
  const fix = (req: { setHeader: (k: string, v: string) => void }, incoming: { headers: Record<string, unknown> }) => {
    if (DEV.test(String(incoming.headers.origin ?? ""))) req.setHeader("origin", server);
  };
  proxy.on("proxyReq", fix);
  proxy.on("proxyReqWs", fix);
};

export default defineConfig({
  base: "/",
  plugins: [react()],
  build: { outDir: "../server/static", emptyOutDir: true, assetsDir: "assets", chunkSizeWarningLimit: 900 },
  server: {
    // IPv4 loopback: on Windows "localhost" binds ::1 only, which leaves 127.0.0.1:5178 dead.
    host: "127.0.0.1",
    port: 5178,
    proxy: {
      "/api/ws": { target: server.replace(/^http/, "ws"), ws: true, changeOrigin: true, configure: sameOrigin },
      "/api": { target: server, changeOrigin: true, configure: sameOrigin },
    },
  },
});
