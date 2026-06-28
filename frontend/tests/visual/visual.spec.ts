// ============================================================================
// Visual regression — every screen × {en, ja}, under the light theme.
//
// Gate for Decision 1 (app-wide light re-theme, Phase 1–3): proves the legacy
// 4 screens (race/style/tickets/explain) and the auth-gated MyTickets surface
// (feed/new/detail) didn't regress when the theme rolled out.
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

    // ---- Legacy race screen ----
    // The 4-step builder IS the landing now. Stepper order is fixed in App.tsx
    // as [race(0), style(1), tickets(2), explain(3)] — index comments below
    // reference that order.
    test(`legacy race (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      await expect(page.locator(".race-selector, .race-card").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`legacy-race.${lang}.png`);
    });

    // ---- Legacy style screen ----
    test(`legacy style (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      // Style = stepper index 1.
      await page.locator(".stepper button").nth(1).click();
      await expect(page.locator(".persona-grid")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`legacy-style.${lang}.png`);
    });

    // ---- Legacy tickets screen ----
    test(`legacy tickets (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      // Tickets = stepper index 2.
      await page.locator(".stepper button").nth(2).click();
      await expect(page.locator(".ticket").first()).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`legacy-tickets.${lang}.png`);
    });

    // ---- Legacy explain screen ----
    test(`legacy explain (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      await page.locator(".stepper button").nth(2).click();
      await expect(page.locator(".ticket").first()).toBeVisible({ timeout: 10_000 });
      // "Why ticket" / "推す理由" — the gold button on each ticket card.
      await page.locator(".ticket .btn.gold").first().click();
      await expect(page.locator(".explain-lead")).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`legacy-explain.${lang}.png`);
    });
  }
});
