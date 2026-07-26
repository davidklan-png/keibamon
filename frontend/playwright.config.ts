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
    // Visual regression gate. The suite runs in a pinned Linux container
    // (mcr.microsoft.com/playwright) so CI and local share one render
    // environment — that eliminates cross-MACHINE variance (the macOS CJK-font
    // gap that broke a macos-15 runner). It does NOT eliminate cross-RUN
    // subpixel jitter: even two runs of the same image differ by ~0.01% of
    // pixels (a single text band's glyph AA) on a handful of baselines. A 0
    // ratio flakes on that; 0.1% absorbs it with ~10x headroom while still
    // catching real regressions (the ticket-renderer batch's smallest real
    // drift was ~4%). Scales with baseline size, so small surfaces stay tight.
    toHaveScreenshot: { maxDiffPixelRatio: 0.001 },
  },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE,
    viewport: { width: 390, height: 844 },
    locale: "en-US",
    timezone: "Asia/Tokyo",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
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
