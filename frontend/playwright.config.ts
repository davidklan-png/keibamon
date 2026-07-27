// ============================================================================
// Playwright config — ADR-0007 Phase 5 visual-regression suite.
//
// Boots the vite dev server with VITE_PLAYWRIGHT_BYPASS_AUTH=1 so the
// auth-gated MyTickets surface renders without a real Clerk session. The
// test files (under tests/visual/) mock /api/live via page.route() so the
// renders are deterministic.
//
// Run:   npm run test:visual
// Update baselines:  npm run test:visual -- --update-snapshots
// ============================================================================
import { defineConfig, devices } from "@playwright/test";

const PORT = 5174;
const BASE = `http://127.0.0.1:${PORT}/app/`;

export default defineConfig({
  testDir: "./tests/visual",
  timeout: 30_000,
  expect: {
    // Visual regression gate. Absolute pixel budget (maxDiffPixels), NOT a
    // ratio. Subpixel/AA differences scale with the amount of TEXT, not image
    // AREA, so a ratio is loosest exactly where a small regression hides (big
    // page captures) and tightest on small surfaces that need it least.
    //
    // BUDGET 0: with the visual spec's clock frozen, fonts waited for, and the
    // image pinned (v1.61.0-jammy), every baseline is byte-stable run-to-run —
    // two consecutive green pull_request CI runs at 0 prove it. (The long-
    // standing "~94px" that sat under budget 200 was NOT rasterization: the
    // branch was behind main, so .foot-version existed in CI's merge checkout
    // but not in the branch-only regen baselines — a constant presence/absence
    // diff, misread as jitter. Merging main + rebaselining closed it.) If a
    // future ubuntu-latest roll ever shifts a glyph by a pixel, 0 flakes on an
    // unchanged tree — bump it THEN, not preemptively.
    toHaveScreenshot: { maxDiffPixels: 0 },
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    locale: "en-US",
    timezone: "Asia/Tokyo",
  },
  projects: [
    {
      name: "chromium",
      // Phone-first capture. The app is a responsive SPA — no mobile-UA / touch
      // branching, layout depends on viewport WIDTH only — so we keep the
      // stable Desktop Chrome profile (DPR 1, desktop UA, the profile the
      // baselines have always used) and override ONLY the viewport to 390x844
      // (iPhone 12 width). A top-level use.viewport used to be set here too,
      // but a project's use wins, so it was dead config and the suite was
      // silently capturing at 1280x720 — pinning a desktop layout users never
      // see. Now the viewport lives where it takes effect.
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 } },
    },
  ],
  webServer: {
    command: "VITE_PLAYWRIGHT_BYPASS_AUTH=1 vite dev --port " + PORT + " --host 127.0.0.1 --strictPort",
    url: BASE,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: ".",
  },
});
