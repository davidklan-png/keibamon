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
    // The ~94px cross-run diff an earlier batch attributed to "arch" or "the
    // host shifting glyph AA" is NEITHER. Regenerating all 53 baselines as
    // native linux/amd64 in CI changed ZERO files (committed baselines already
    // matched amd64) → not arch. And it reproduces at budget 0 → not stale.
    // It is RUN-TO-RUN AA jitter on ONE text element: the version string
    // "Keibamon v0.3.0", on the 6 baselines where it lands at a jitter-prone
    // layout position (research-mode, signed-out-empty-{zero,marks}, EN+JA),
    // ~92-99px each, the same 6 across runs. The other ~40 baselines are
    // byte-stable run-to-run. ARCH stays pinned to linux/amd64
    // (scripts/test-visual.sh --platform; CI regen job) — preventive, removes
    // arch as a variable — but it did not fix the 94px (there was no arch diff
    // to fix). 200 = ~2x over the 99px jitter ceiling, and well under the
    // smallest real regression this gate catches (the b85f7ab edit-pencil class
    // is ~256px > 200 → fails). CLEAN FIX (David's call, not done here): mask
    // the version element in toHaveScreenshot — it is not a regression target
    // and changes every release — which drops the global budget toward 0.
    toHaveScreenshot: { maxDiffPixels: 200 },
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
