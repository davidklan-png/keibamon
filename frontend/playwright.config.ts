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
    // The ~94px cross-env difference this used to absorb was NOT jitter or "the
    // host shifting glyph AA" — it was ARCHITECTURE. mcr.microsoft.com/playwright
    // is a multi-arch manifest; baselines captured under linux/arm64 (Apple
    // Silicon's default) vs CI on linux/amd64 differ by a stable, reproducible
    // 94px on 6 text-dense baselines (same 6, same 94px across runs). The fix
    // is at the source: scripts/test-visual.sh pins --platform linux/amd64 and
    // visual.yml's regen job re-captures baselines on the native amd64 runner,
    // collapsing the 94px to ~0. Until those amd64 baselines land this stays
    // at 200 (the value that absorbed the 94px with ~2x headroom); the next
    // commit tightens it to the measured residual.
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
