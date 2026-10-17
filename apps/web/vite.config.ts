import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
    // The UI never evaluates rules itself; everything goes to the server.
    proxy: { "/api": { target: "http://localhost:3101", rewrite: (p) => p.replace(/^\/api/, "") } },
  },
});
