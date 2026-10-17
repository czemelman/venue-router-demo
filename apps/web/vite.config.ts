import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `VITE_DEMO=1` builds the static demo: the ZEN engine (WASI build) runs in the browser, no server needed.
// `VITE_BASE` sets the public path, e.g. /venue-router-demo/ on GitHub Pages.
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  plugins: [react()],
  build: { target: "esnext" }, // the WASI loader uses top-level await
  optimizeDeps: { exclude: ["@gorules/zen-engine", "@gorules/zen-engine-wasm32-wasip1"], esbuildOptions: { target: "esnext" } },
  server: {
    port: 5173,
    host: true,
    // In the normal build the UI never evaluates rules itself; everything goes to the server.
    proxy: { "/api": { target: "http://localhost:3101", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
