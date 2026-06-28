// ============================================================================
// Smoke test — proves the Playwright + vite dev + auth-bypass wiring works
// and the MyTickets feed renders end-to-end. This is the prerequisite for
// the full visual-regression suite.
// ============================================================================
import { test, expect } from "@playwright/test";
import { installApiMocks } from "./fixtures";

test.describe("visual smoke", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
  });

  test("feed renders with the bypass user", async ({ page }) => {
    await page.goto("/");
    // Race-first UX (ADR-0012): `/` lands on the Races (browse) view. MyTickets
    // is now a top-level tab — click it before asserting the feed's header.
    await page.getByTestId("tab-mine").click();
    // Wait for the brand header that MyTickets renders.
    await expect(page.locator(".mt-brand-name")).toBeVisible({ timeout: 10_000 });
    // The fixture race should surface in the live banner.
    await expect(page.locator(".mt-banner-name")).toContainText("Takarazuka");
  });
});
