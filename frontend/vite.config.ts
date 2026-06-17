import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The SPA builds into ../splash/app so the existing Cloudflare Worker
// ASSETS binding (directory = ./splash) serves it at /app/ — no worker.js
// or wrangler.jsonc changes needed. The splash home page stays at /.
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: {
    outDir: "../splash/app",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
