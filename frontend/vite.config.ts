import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// The SPA builds into ../splash/app so the existing Cloudflare Worker
// ASSETS binding (directory = ./splash) serves it at /app/ — no worker.js
// or wrangler.jsonc changes needed. The splash home page stays at /.

// Single source of truth for the version string is the repo-root VERSION file
// (see docs/runbooks/deploy-public-app.md "Release ritual"). Read it here so
// the app bundle and the splash badge (stamped by scripts/stamp-version.mjs)
// can never drift apart — both derive from the same file.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP_VERSION = readFileSync(resolve(repoRoot, "VERSION"), "utf8").trim();

export default defineConfig({
  plugins: [react()],
  base: "/app/",
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
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
