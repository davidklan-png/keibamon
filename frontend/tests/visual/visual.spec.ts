// ============================================================================
// Visual regression — every screen × {en, ja}, under the light theme.
//
// Gate for Decision 1 (app-wide light re-theme, Phase 1–3) + ADR-0012/0014 UX
// refactors: proves the collapsed race→tickets builder (with the inline Refine
// panel + per-ticket Why disclosures replacing the old standalone Style and
// Explain steps) and the auth-gated MyTickets surface (feed/new/detail) didn't
// regress across the rebuild.
//
// Run:              npm run test:visual
// Update baselines: npm run test:visual -- --update-snapshots
// Auth bypass:      VITE_PLAYWRIGHT_BYPASS_AUTH=1 is set in playwright.config.
// Language:         set via `keibamon.lang` localStorage before each visit.
// ============================================================================
import { test, expect } from "@playwright/test";
import { installApiMocks } from "./fixtures";

const LANGS = ["en", "ja"] as const;

test.describe("visual regression", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
  });

  /**
   * Navigates to /, sets the language, and waits for the MyTickets feed to
   * render. Each screen test starts from this baseline state and then walks
   * forward to the target view.
   */
  async function landOnFeed(page: import("@playwright/test").Page, lang: "en" | "ja"): Promise<void> {
    await page.addInitScript((l) => {
      try { window.localStorage.setItem("keibamon.lang", l); } catch { /* ignore */ }
      // Freeze wall-clock so countdown text + auto-settle timing is deterministic
      // across runs. Fixture race post_time=15:40 JST, frozen now=13:00 JST →
      // countdown renders "2:40:00 to go" (en) / "開始まで 2:40:00" (ja).
      const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
      Date.now = () => FROZEN;
      // Steadfast the second-resolution countdown ticks: intervals that fire
      // `setNow(Date.now())` now produce identical values.
    }, lang);
    await page.goto("/");
    // Race-first UX (ADR-0012): `/` lands on the Races (browse) view. MyTickets
    // is now a top-level tab — click it before asserting the feed's header.
    await page.getByTestId("tab-mine").click();
    await expect(page.locator(".mt-brand-name")).toBeVisible({ timeout: 10_000 });
    // Let the auto-settle / drift effects fire once.
    await page.waitForTimeout(600);
  }

  /**
   * Race-first landing (ADR-0012): `/` now lands directly on the classic 4-step
   * builder at the Race step. The legacy screen tests used to reach this surface
   * via MyTickets → FAB → Builder, but the Builder button was removed at commit
   * 3dd12fe (ADR-0007 Phase 5) when MyTickets was extracted — so this prologue
   * is now a one-liner. Same lang + frozen-clock setup as landOnFeed so the
   * countdown text and auto-regen are deterministic.
   */
  async function landOnLegacyRace(page: import("@playwright/test").Page, lang: "en" | "ja"): Promise<void> {
    await page.addInitScript((l) => {
      try { window.localStorage.setItem("keibamon.lang", l); } catch { /* ignore */ }
      const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
      Date.now = () => FROZEN;
    }, lang);
    await page.goto("/");
    await expect(page.locator(".stepper")).toBeVisible({ timeout: 10_000 });
    // Let the initial loadLive + auto-regen fire so all stepper buttons are enabled.
    await page.waitForTimeout(600);
  }

  for (const lang of LANGS) {
    // ---- MyTickets feed ----
    test(`mytickets feed (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await expect(page).toHaveScreenshot(`mytickets-feed.${lang}.png`);
    });

    // ---- MyTickets new bet ----
    test(`mytickets new (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await page.locator(".mt-fab").click();
      await expect(page.locator(".mt-new")).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`mytickets-new.${lang}.png`);
    });

    // ---- MyTickets detail (open) ----
    test(`mytickets detail-open (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await page.locator(".mt-card").first().click();
      await expect(page.locator(".mt-detail")).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`mytickets-detail-open.${lang}.png`);
    });

    // ---- Race step (collapsed-builder landing) ----
    // Stepper is now [race(0), tickets(1)] (ADR-0014 collapsed the 4-step spine
    // to race → tickets; the standalone Style + Explain steps are gone). The race
    // step is the landing — only ADR-0014 delta here is the removed "Refine by
    // style" link, so this baseline should drift by exactly that.
    test(`legacy race (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      await expect(page.locator(".race-selector, .race-card").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      // #14 — durable text assertion on the RaceContextBar surface/distance
      // segment so a formatter regression can't pass CI by pixel-matching a
      // stale baseline. en: "turf 2000m" (latin space), ja: "芝2000m" (CJK
      // joiner, no space — see RaceContextBar.hasWideChar). The fixture race
      // now carries surface:"turf" + distance_m:2000.
      const expectedSurfDist = lang === "en" ? "turf 2000m" : "芝2000m";
      await expect(page.locator(".rcb-surf-dist")).toHaveText(expectedSurfDist);
      await expect(page).toHaveScreenshot(`legacy-race.${lang}.png`);
    });

    // ---- Tickets step (collapsed builder, nth(1) now) ----
    // Captures the Refine panel + per-ticket Why disclosures in their COLLAPSED
    // state, so the expanded variants below show a deterministic delta.
    test(`legacy tickets (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      // Tickets = stepper index 1 (was 2 pre-collapse).
      await page.locator(".stepper button").nth(1).click();
      await expect(page.locator(".ticket").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`legacy-tickets.${lang}.png`);
    });

    // ---- Refine panel (was "legacy style") ----
    // The standalone Style step is gone (ADR-0014). Its controls — persona grid,
    // budget/unit, advanced complexity/flavor — now live inside a collapsible
    // <details className="refine"> at the top of Tickets. Expand it and snapshot
    // to cover the same controls the old legacy-style baseline did.
    test(`refine-panel (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      await page.locator(".stepper button").nth(1).click();
      await expect(page.locator(".ticket").first()).toBeVisible({ timeout: 10_000 });
      await page.locator("details.refine > summary").click();
      await expect(page.locator(".persona-grid")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`refine-panel.${lang}.png`);
    });

    // ---- Inline Why (was "legacy explain") ----
    // The standalone Why step is gone (ADR-0014). Reasoning now lives inline per
    // ticket in a <details className="ticket-why-disclosure">. Expand the first
    // ticket's disclosure and snapshot to cover the same reasoning (lead,
    // coverage/upside/fragility/cost, combos, math) the old legacy-explain did.
    test(`inline-why (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      await page.locator(".stepper button").nth(1).click();
      await expect(page.locator(".ticket").first()).toBeVisible({ timeout: 10_000 });
      await page.locator("details.ticket-why-disclosure > summary").first().click();
      // Every ticket renders its own TicketWhy (each with .explain-lead) inside
      // its own <details>; only the first is opened, but the locator still
      // matches all of them in the DOM → scope to .first() to satisfy strict mode.
      await expect(page.locator(".explain-lead").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`inline-why.${lang}.png`);
    });

    // ---- Research lane (inline RoundupPanel, ADR-0015) ----
    // Tap the Research segment of the lane control on the Races view. The
    // weekend roundup now renders inline (sharing the App header + bottom tab
    // bar + impression spine with the live-card builder). The fixture pins
    // /api/weekly-report to {status:"empty"}, so this capture is the
    // deterministic EmptyRoundup state — cadence message + the fixture's G1
    // (Tokyo Takarazuka, 2026-06-21) listed as an upcoming graded stake under
    // the frozen clock. Without that pin the baseline would flake on whatever
    // the dev server's D1 happens to carry.
    test(`research-mode (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      // Second button in the lane segmented control = Research.
      await page.locator(".lane-segmented button").nth(1).click();
      // RoundupPanel's empty state renders .roundup-empty (cadence + upcoming).
      await expect(page.locator(".roundup-empty")).toBeVisible({ timeout: 10_000 });
      // Stepper hides in research mode (ADR-0015) — assert it's gone so a
      // regression that re-renders the race→tickets spine here fails the test.
      await expect(page.locator(".stepper")).toHaveCount(0);
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`research-mode.${lang}.png`);
    });
  }
});
