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
    // Visual regression gate. Absolute pixel budget, NOT a ratio. Two reasons
    // a ratio is the wrong unit here:
    //   1. Subpixel/AA differences scale with the amount of TEXT, not image
    //      AREA. A ratio scales with area. So a ratio is loosest exactly where
    //      a small regression is easiest to hide (big page captures) and
    //      tightest on the surfaces that need it least (header strips).
    //   2. The pinned Linux container makes the suite deterministic RUN-TO-RUN
    //      (two captures in the same image are byte-identical, 0px). The only
    //      residual is cross-ENVIRONMENT: the committed baselines (captured in
    //      Docker on macOS) vs the CI container (ubuntu-latest) differ by a
    //      STABLE ~94px on 6 text-dense baselines — same 6, same 94px across
    //      two CI runs, not random jitter. (Same image; the host subtly shifts
    //      one text band's glyph AA.)
    // So: maxDiffPixels sized over that measured 94px ceiling. 200px = ~2.1x
    // headroom over the worst observed baseline, and well under the smallest
    // real regression this gate exists to catch — the b85f7ab class (an edit
    // pencil / small control appearing or disappearing) is ~256px+, which
    // exceeds 200 and fails. A 1px card-border change (~360px) fails. A
    // whole-region drift (thousands of px) fails hard. Locally the budget
    // never bites (0px); it only ever absorbs the CI cross-env 94px.
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
