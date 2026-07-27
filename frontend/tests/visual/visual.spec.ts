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
import { installApiMocks, FIXTURE_WEEKEND_PUBLISHED, STRUCTURED_TICKETS, LAYOUT_FIELD_18_SNAPSHOT } from "./fixtures";

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
    // is now a top-level tab — click it before asserting the feed. (Social UX
    // Fixes Phase A: the old .mt-brand-name header row is gone — the shared
    // <AppHeader /> carries the brand now; wait for the feed container.)
    await page.getByTestId("tab-mine").click();
    await expect(page.locator(".mt-feed")).toBeVisible({ timeout: 10_000 });
    // Let the auto-settle / drift effects fire once.
    await page.waitForTimeout(600);
    // Wait for webfonts before any screenshot — font-load timing is the one
    // residual non-determinism in a pinned container, and at maxDiffPixelRatio:0
    // even one unready glyph flakes (a ~160px text band differed between two
    // runs of the same image before this).
    await page.evaluate(() => document.fonts.ready);
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
    // Wait for webfonts before any screenshot — font-load timing is the one
    // residual non-determinism in a pinned container, and at maxDiffPixelRatio:0
    // even one unready glyph flakes (a ~160px text band differed between two
    // runs of the same image before this).
    await page.evaluate(() => document.fonts.ready);
  }

  /**
   * Signed-out landing (#11): same lang + frozen-clock setup as landOnFeed, but
   * sets the kbm.pw.signedout=1 flag BEFORE goto so AuthProvider's PLAYWRIGHT
   * bypass branch serves a signed-out AuthState (isSignedIn:false → App routes
   * MyTicketsHome to MyTicketsEmpty). The tab bar stays visible (it's a sibling
   * of MyTicketsHome in App's view="mine" branch).
   *
   * If `seedImpressions` is passed, it's written to localStorage as the
   * kbm.impressions.v1 blob so MyTicketsEmpty renders the N-horses/M-races
   * teaser variant instead of the gentle zero-marks variant.
   *
   * Tracks /api/social requests to assert NONE fire signed-out (cheap guard:
   * getToken returns null, MyTicketsHome's postMe effect bails on !isSignedIn,
   * so a social request reaching the wire here would be a regression).
   */
  async function landOnSignedOutEmpty(
    page: import("@playwright/test").Page,
    lang: "en" | "ja",
    seedImpressions?: Record<string, unknown>,
  ): Promise<{ socialHits: number }> {
    let socialHits = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/social/")) socialHits++;
    });
    await page.addInitScript(([l, seed]) => {
      try {
        window.localStorage.setItem("keibamon.lang", l);
        // #11 — flip the bypass to signed-out for this page load.
        window.localStorage.setItem("kbm.pw.signedout", "1");
        if (seed) {
          window.localStorage.setItem("kbm.impressions.v1", JSON.stringify(seed));
        }
      } catch { /* ignore */ }
      const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
      Date.now = () => FROZEN;
    }, [lang, seedImpressions ?? null] as const);
    await page.goto("/");
    // Race-first landing: navigate to the MyTickets tab to reach the empty state.
    await page.getByTestId("tab-mine").click();
    await expect(page.locator(".mt-empty")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    // Wait for webfonts before any screenshot — font-load timing is the one
    // residual non-determinism in a pinned container, and at maxDiffPixelRatio:0
    // even one unready glyph flakes (a ~160px text band differed between two
    // runs of the same image before this).
    await page.evaluate(() => document.fonts.ready);
    return { socialHits };
  }

  /**
   * Social UX Fixes (Phase A) — land on a non-default top-level tab for the
   * header/footer consistency snapshots. Same lang + frozen-clock setup as the
   * other landers; waits for each destination's anchor element so the capture
   * is deterministic. (Browse is the landing — use landOnLegacyRace for it.)
   */
  async function landOnTab(
    page: import("@playwright/test").Page,
    lang: "en" | "ja",
    tab: "tab-friends" | "tab-reference",
    anchor: string,
  ): Promise<void> {
    await page.addInitScript((l) => {
      try { window.localStorage.setItem("keibamon.lang", l); } catch { /* ignore */ }
      const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
      Date.now = () => FROZEN;
    }, lang);
    await page.goto("/");
    await page.getByTestId(tab).click();
    await expect(page.locator(anchor)).toBeVisible({ timeout: 10_000 });
    // Let each screen's mount effects (postMe / listFriends / feed) settle so
    // the snapshot isn't mid-loading.
    await page.waitForTimeout(600);
    // Wait for webfonts before any screenshot — font-load timing is the one
    // residual non-determinism in a pinned container, and at maxDiffPixelRatio:0
    // even one unready glyph flakes (a ~160px text band differed between two
    // runs of the same image before this).
    await page.evaluate(() => document.fonts.ready);
  }

  for (const lang of LANGS) {
    // ---- MyTickets feed ----
    // b85f7ab (manual-builder wiring) added the ✎ edit button
    // (.mt-card-edit, MyTickets.tsx ~line 913) to OPEN ticket cards behind a
    // {open && ...} render gate, but regenerated zero visual baselines — so
    // both feed baselines drifted by exactly the pencil on the first (open)
    // card. The fixture carries one open (kb-open-1) + one won (kb-won-1)
    // ticket, and the Open section sorts before History, so the first card
    // has the pencil and the second doesn't. Pin both branches of the gate
    // with locator assertions so a future render-gate regression can't pass
    // CI by pixel-matching a stale baseline — the #14 durable-assertion
    // pattern.
    test(`mytickets feed (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      // Edit pencil visible on the OPEN (first) card, absent on the WON (second).
      await expect(page.locator(".mt-card").first().locator(".mt-card-edit")).toBeVisible();
      await expect(page.locator(".mt-card").nth(1).locator(".mt-card-edit")).toHaveCount(0);
      // Exactly one pencil in the whole feed (the open card's).
      await expect(page.locator(".mt-card-edit")).toHaveCount(1);
      await expect(page).toHaveScreenshot(`mytickets-feed.${lang}.png`);
    });

    // ---- MyTickets new bet ----
    // The "Build manually" CTA (button.mt-manual-entry, MyTickets.tsx ~line
    // 1288) was added in b85f7ab as a 4th vibe-pick sibling BELOW the
    // screenshot fold of this baseline, so it had ZERO CI coverage (pixel
    // OR semantic) until this assertion. toBeVisible auto-scrolls it into
    // view; placed AFTER the screenshot so the existing top-of-page frame
    // is unchanged. The dedicated scrolled capture below covers the pixels.
    test(`mytickets new (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await page.locator(".mt-fab").click();
      await expect(page.locator(".mt-new")).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`mytickets-new.${lang}.png`);
      // Assert the manual-entry CTA exists + is visible (ends its CI invisibility).
      await expect(page.locator(".mt-manual-entry")).toBeVisible();
    });

    // ---- MyTickets new bet: manual-entry CTA (scrolled into view) ----
    // Dedicated pixel capture of the 4th "Build manually" CTA, scrolled into
    // the frame. Covers the visual treatment the fold-hidden baseline above
    // can't reach.
    test(`mytickets new manual-entry (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await page.locator(".mt-fab").click();
      await expect(page.locator(".mt-new")).toBeVisible();
      await page.locator(".mt-manual-entry").scrollIntoViewIfNeeded();
      await expect(page.locator(".mt-manual-entry")).toBeVisible();
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`mytickets-new-manual-entry.${lang}.png`);
    });

    // ---- MyTickets detail (open) ----
    test(`mytickets detail-open (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await page.locator(".mt-card").first().click();
      await expect(page.locator(".mt-detail")).toBeVisible();
      // Ticket-detail UX: the footer (@you/disclaimer/barcode) is gone and the
      // action row now leads with [Back] (real nav) + [Download] (image export).
      // The card is tall enough that the action row sits below the fold of the
      // card screenshot below, so assert the buttons directly (both langs).
      await expect(page.locator(".mt-back-btn")).toBeVisible();
      await expect(page.locator(".mt-download")).toBeVisible();
      // And confirm the removed footer pieces are truly gone.
      await expect(page.locator(".mt-card-foot")).toHaveCount(0);
      await expect(page.locator(".mt-barcode")).toHaveCount(0);
      await page.waitForTimeout(300);
      await expect(page).toHaveScreenshot(`mytickets-detail-open.${lang}.png`);
    });

    // ---- Ticket delete confirm (Social UX Fixes) ----
    // The [pill][edit][delete] cluster is pixel-pinned by mytickets-feed above;
    // this captures the confirm modal that opens on delete (also pins the
    // previously-unstyled .mt-modal* CSS). The first card is the open one.
    test(`ticket delete confirm (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await page.locator(".mt-card").first().locator(".mt-card-delete").click();
      await expect(page.locator(".mt-modal")).toBeVisible();
      await expect(page.locator(".mt-modal-cta-danger")).toBeVisible();
      await page.waitForTimeout(200);
      await expect(page.locator(".mt-modal")).toHaveScreenshot(`ticket-delete-confirm.${lang}.png`);
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

    // ---- Signed-out MyTickets empty (zero marks, gentle variant) ---- (#11)
    // ADR-0013 honest empty state: the surface that motivates ADR-0018's cross-
    // device-sync promise. The bypass branch reads kbm.pw.signedout=1 and serves
    // isSignedIn:false, so App routes MyTicketsHome → MyTicketsEmpty with zero
    // local marks (gentle variant — no teaser numbers).
    test(`signed-out empty zero-marks (${lang})`, async ({ page }) => {
      const { socialHits } = await landOnSignedOutEmpty(page, lang);
      // Sign-in affordance exists (not just pixels) — the CTA in the empty state.
      await expect(page.locator(".mt-empty-cta")).toBeVisible();
      // Tab bar visible signed-out (sibling of MyTicketsHome in App's view="mine").
      await expect(page.getByTestId("tab-mine")).toBeVisible();
      // No social Worker calls fire signed-out (getToken → null; postMe effect bails).
      expect(socialHits).toBe(0);
      await expect(page).toHaveScreenshot(`signed-out-empty-zero.${lang}.png`);
    });

    // ---- Signed-out MyTickets empty (≥1 mark, teaser variant) ---- (#11)
    // The teaser variant: seed one local impression so summarizeMarks reports
    // N=1 horse / M=1 race and the empty state shows the motivational "your
    // research is waiting" teaser. Same race_id + horse_key shape the store uses
    // (impressions.ts: `${race_id}|${normalizeName(name)}`).
    test(`signed-out empty with-marks (${lang})`, async ({ page }) => {
      const seed = {
        "jra-20260621-05-11|croixdu nord": {
          mark: "anchor",
          umaban: 1,
          odds_when_marked: 2.4,
          odds_snapshot_at: null,
          formed_at: 100,
        },
      };
      const { socialHits } = await landOnSignedOutEmpty(page, lang, seed);
      await expect(page.locator(".mt-empty-cta")).toBeVisible();
      await expect(page.getByTestId("tab-mine")).toBeVisible();
      expect(socialHits).toBe(0);
      await expect(page).toHaveScreenshot(`signed-out-empty-marks.${lang}.png`);
    });

    // ---- Social UX Fixes (Phase A): header + bottom-tabbar per main screen ----
    // The shared <AppHeader /> + <BottomTabBar /> are mounted ONCE in the App
    // shell and are present on every screen, in one fixed layout. These region
    // snapshots pin both so future drift — a re-added per-screen bell, a moved
    // EN/JP toggle, a tab-order/badging change, a title regression — fails CI
    // instead of reaching production. The header capture varies by screen
    // (title); the tabbar capture varies by the active tab. EN + JA both.
    //
    // Each pair also carries a durable text assertion on the header's <h1>
    // title so a formatter/i18n regression can't pass by pixel-matching a stale
    // baseline (#14 pattern).
    test(`app-header+footer browse (${lang})`, async ({ page }) => {
      await landOnLegacyRace(page, lang);
      await expect(page.locator(".app-header")).toBeVisible();
      await expect(page.locator(".bottom-tabbar")).toBeVisible();
      // Browse keeps the bilingual brand title (app.title + the 競馬モン glyph).
      await expect(page.locator(".app-header h1")).toContainText(
        lang === "en" ? "Keibamon" : "ケイバモン",
      );
      await expect(page.locator(".app-header")).toHaveScreenshot(`app-header.browse.${lang}.png`);
      await expect(page.locator(".bottom-tabbar")).toHaveScreenshot(`bottom-tabbar.browse.${lang}.png`);
    });

    test(`app-header+footer mine (${lang})`, async ({ page }) => {
      await landOnFeed(page, lang);
      await expect(page.locator(".app-header")).toBeVisible();
      await expect(page.locator(".bottom-tabbar")).toBeVisible();
      await expect(page.locator(".app-header h1")).toContainText(
        lang === "en" ? "Tickets" : "マイ",
      );
      await expect(page.locator(".app-header")).toHaveScreenshot(`app-header.mine.${lang}.png`);
      await expect(page.locator(".bottom-tabbar")).toHaveScreenshot(`bottom-tabbar.mine.${lang}.png`);
    });

    test(`app-header+footer friends (${lang})`, async ({ page }) => {
      await landOnTab(page, lang, "tab-friends", ".friends-screen");
      await expect(page.locator(".app-header")).toBeVisible();
      await expect(page.locator(".bottom-tabbar")).toBeVisible();
      await expect(page.locator(".app-header h1")).toContainText(
        lang === "en" ? "Friends" : "友だち",
      );
      await expect(page.locator(".app-header")).toHaveScreenshot(`app-header.friends.${lang}.png`);
      await expect(page.locator(".bottom-tabbar")).toHaveScreenshot(`bottom-tabbar.friends.${lang}.png`);
    });

    // ---- Item 4 + Item 5: social feed ShareCards ----
    // The Friends feed (share-gated) had NO visual coverage until now. This pins
    // BOTH items: the friend's win card (congratulate BUTTON) vs the viewer's
    // OWN win card ("You" badge + read-only congrats count — no button, since
    // the server forbids self-congrats), plus the Item 5 race identity line
    // (venue · R# · date) under each race name. FIXTURE_FEED (fixtures.ts)
    // drives it via the /api/social/feed mock.
    test(`friends feed (${lang})`, async ({ page }) => {
      await landOnTab(page, lang, "tab-friends", ".friends-screen");
      await expect(page.locator(".friends-feed")).toBeVisible({ timeout: 10_000 });
      // Durable assertions (#14 pattern): the friend's card exposes the
      // congratulate BUTTON; the own card's reaction count is a read-only span
      // and its owner is the "You" badge — so a regression can't pass by
      // pixel-matching a stale baseline.
      await expect(page.locator(".sc-card").first().locator("button.sc-congrats")).toBeVisible();
      await expect(page.locator(".sc-card").nth(1).locator(".sc-congrats-readonly")).toBeVisible();
      await expect(page.locator(".sc-card").nth(1).locator(".sc-you")).toBeVisible();
      // Let webfonts settle so the structure-aware TicketLines tiles + the CJK
      // identity line are pixel-stable (same lesson as the Formation flake).
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
      await expect(page.locator(".friends-feed")).toHaveScreenshot(`friends-feed.${lang}.png`);
    });

    test(`app-header+footer reference (${lang})`, async ({ page }) => {
      await landOnTab(page, lang, "tab-reference", ".glossary-search");
      await expect(page.locator(".app-header")).toBeVisible();
      await expect(page.locator(".bottom-tabbar")).toBeVisible();
      await expect(page.locator(".app-header h1")).toContainText(
        lang === "en" ? "Reference" : "用語",
      );
      await expect(page.locator(".app-header")).toHaveScreenshot(`app-header.reference.${lang}.png`);
      await expect(page.locator(".bottom-tabbar")).toHaveScreenshot(`bottom-tabbar.reference.${lang}.png`);
    });

    // ---- Social UX Fixes (Phase B): handle-onboarding gate (HandleSetup) ----
    // Override /api/social/me to report NO handle so the App shell's blocking
    // gate renders the shared HandleSetup step (the bypass user normally HAS a
    // handle, which keeps the gate closed in every other test). Pins the
    // one-field/one-button onboarding screen + the seed prefill.
    test(`handle-setup gate (${lang})`, async ({ page }) => {
      await installApiMocks(page);
      // No handle → gate opens.
      await page.unroute("**/api/social/me");
      await page.route("**/api/social/me", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ id: "playwright-fake-user", handle: null }),
        }),
      );
      // Availability probe → free, so the seed reads as available.
      await page.route("**/api/social/handle-available?h=*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: true }),
        }),
      );
      await page.addInitScript((l) => {
        try { window.localStorage.setItem("keibamon.lang", l); } catch { /* ignore */ }
        const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
        Date.now = () => FROZEN;
      }, lang);
      await page.goto("/");
      await expect(page.locator(".handle-setup-card")).toBeVisible({ timeout: 10_000 });
      // Seed prefilled from the bypass user's displayName "Playwright".
      await expect(page.locator(".handle-setup-input")).toHaveValue("playwright");
      await expect(page.locator(".handle-setup-rules")).toBeVisible();
      // Let the debounced availability check settle before the snapshot.
      await page.waitForTimeout(500);
      await expect(page.locator(".handle-setup-card")).toHaveScreenshot(`handle-setup.${lang}.png`);
    });

    // ---- Social UX Fixes (Phase C): invite deep-link interstitial ----
    // Land on /?friend=boss as the signed-in bypass user → useInvite resolves
    // (friendship none) → the one-tap "Add @boss" interstitial. Pins the new
    // profile-card screen.
    test(`invite interstitial (${lang})`, async ({ page }) => {
      await installApiMocks(page);
      // The inviter's profile (friendship none → interstitial, not auto-add).
      await page.route("**/api/social/users/boss", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: "u-boss",
            handle: "boss",
            display_name: "Boss Player",
            avatar: null,
            created_at: 0,
            friendship: "none",
          }),
        }),
      );
      await page.addInitScript((l) => {
        try { window.localStorage.setItem("keibamon.lang", l); } catch { /* ignore */ }
        const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
        Date.now = () => FROZEN;
      }, lang);
      await page.goto("/?friend=boss");
      await expect(page.locator(".invite-card")).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(".invite-handle")).toContainText("@boss");
      await expect(page.locator(".invite-cta")).toContainText(lang === "en" ? "Add" : "追加");
      await page.waitForTimeout(300);
      await expect(page.locator(".invite-card")).toHaveScreenshot(`invite-interstitial.${lang}.png`);
    });
  }

  // ---- ADR-0020: focused Japanese EXPANDED-Research snapshot ----
  // The LANGS-loop `research-mode` baseline captures the EMPTY roundup. This
  // focused JA-only test overrides /api/weekly-report with a PUBLISHED edition
  // and expands the deep dive, so the generated JA prose (headline, glance,
  // market/pace/gate, contender reasons, trend, ticket notes, watchlist, lens)
  // is pixel-pinned. JA-only on purpose — the EN expanded surface has no prior
  // baseline and is covered structurally by the RoundupPanel integration test.
  test(`research-expanded (ja)`, async ({ page }) => {
    await installApiMocks(page);
    // Deterministically override the empty weekly-report mock (unroute first so
    // handler order can't decide which wins).
    await page.unroute("**/api/weekly-report");
    await page.route("**/api/weekly-report", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(FIXTURE_WEEKEND_PUBLISHED),
      }),
    );
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem("keibamon.lang", "ja");
      } catch {
        /* ignore */
      }
      const FROZEN = Date.parse("2026-06-28T13:00:00+09:00");
      Date.now = () => FROZEN;
    });
    await page.goto("/");
    await expect(page.locator(".lane-segmented")).toBeVisible({ timeout: 10_000 });
    await page.locator(".lane-segmented button").nth(1).click(); // Research lane
    await expect(page.locator(".roundup-tab")).toBeVisible({ timeout: 10_000 });
    // Expand the (single) deep dive to expose the generated JA blocks.
    await page.locator("button.deepdive-toggle").first().click();
    await expect(page.locator(".ticket-notes")).toBeVisible({ timeout: 5_000 });
    // Durable text assertions (guard against a formatter regression passing CI
    // by pixel-matching a stale baseline): the expanded JA surface carries JA
    // generated prose, not English template fragments.
    const body = page.locator("body");
    await expect(body).toContainText("ペースの読み"); // pace read (JA)
    await expect(body).toContainText("約2.4倍"); // contender reason, JA odds
    await expect(body).toContainText("馬連"); // ticket-note shape
    await expect(body).not.toContainText("Running styles not yet declared");
    await page.waitForTimeout(300);
    await expect(page).toHaveScreenshot("research-expanded-ja.png");
  });
});

// ============================================================================
// Ticket-detail UX — structured-mode snapshots (box / formation / wheel).
// The renderer's new track-style CSS (tiles, position columns, axis+partners)
// is pinned here in the real detail card. A dedicated ticket set
// (STRUCTURED_TICKETS) is installed in beforeEach; the feed lists them in array
// order [box, formation, wheel], so each test opens the nth card and verifies
// the structure badge before screenshotting. Points line is OFF on the detail
// card (the pay panel carries cost + combo count) — it's covered by the
// TicketLines unit tests with showPoints on.
// ============================================================================
test.describe("ticket-detail structured modes", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page, STRUCTURED_TICKETS);
  });

  async function openStructuredDetail(
    page: import("@playwright/test").Page,
    lang: "en" | "ja",
    cardIndex: number,
    badgeSelector: string,
  ): Promise<void> {
    await page.addInitScript((l) => {
      try {
        window.localStorage.setItem("keibamon.lang", l);
      } catch {
        /* ignore */
      }
      Date.now = () => Date.parse("2026-06-21T13:00:00+09:00");
    }, lang);
    await page.goto("/");
    await page.getByTestId("tab-mine").click();
    await expect(page.locator(".mt-feed")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600);
    // Wait for webfonts before any screenshot — font-load timing is the one
    // residual non-determinism in a pinned container, and at maxDiffPixelRatio:0
    // even one unready glyph flakes (a ~160px text band differed between two
    // runs of the same image before this).
    await page.evaluate(() => document.fonts.ready);
    await page.locator(".mt-card").nth(cardIndex).click();
    await expect(page.locator(".mt-detail")).toBeVisible();
    // Confirm we opened the intended mode before pinning the screenshot.
    await expect(page.locator(badgeSelector)).toBeVisible();
    // Wait for web fonts (the mono tiles) to load before capturing — the
    // formation card carries the most tiles and is the most font-sensitive.
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
  }

  for (const lang of LANGS) {
    test(`ticket-detail box trifecta (${lang})`, async ({ page }) => {
      await openStructuredDetail(page, lang, 0, ".tl-badge-box");
      await expect(page).toHaveScreenshot(`ticket-detail-box.${lang}.png`);
    });

    test(`ticket-detail formation (${lang})`, async ({ page }) => {
      await openStructuredDetail(page, lang, 1, ".tl-badge-form");
      await expect(page).toHaveScreenshot(`ticket-detail-formation.${lang}.png`);
    });

    test(`ticket-detail wheel (${lang})`, async ({ page }) => {
      await openStructuredDetail(page, lang, 2, ".tl-badge-wheel");
      await expect(page).toHaveScreenshot(`ticket-detail-wheel.${lang}.png`);
    });
  }
});

// ============================================================================
// Ticket-studio (ADR-0011 structural surface) — SetFamilyView + FormationView
// + WheelView + FillGuide. This whole surface had ZERO visual coverage until
// this block: it is only reachable via the "Box these N horses" CTA, which no
// test opened (grep for TicketStudio|fillguide|SetFamily|FormationView|WheelView
// in this file returned 0). Captures the studio LIST layer + FillGuide in box
// / formation / wheel. The formation/wheel FillGuide bodies are the shared
// <TicketLines> after ticket-structure-unify Phase 2.
//
// 枠連 (bracket) FillGuide is NOT captured here: SetFamilyView's bracket row is
// display-only (no Ticket representation) and the live path carries no `gate`,
// so no studio path produces a bracket_quinella FillGuide. That render is
// pinned only by the FillGuide unit test (bracketBoxTicket → 1-8 waku grid).
//
// Driven by 3 seeded impressions on the fixture G1 (1 anchor + 2 includes) →
// markedSet=[1,3,6], anchor=1 → the CTA + all three list layers (Wheel needs
// the anchor). Each FillGuide mode opens the studio fresh and taps its row, so
// there's no fragile back-button navigation between captures. EN + JA.
// ============================================================================
test.describe("ticket-studio structural surface", () => {
  // horse_key = normalizeName(name): NFKC + drop ALL whitespace (no lowercase).
  // "Croix du Nord"→"CroixduNord", "Pegasus Seiya"→"PegasusSeiya",
  // "Ho O Biscay"→"HoOBiscay".
  const STUDIO_IMPRESSIONS: Record<string, Record<string, unknown>> = {
    "jra-20260621-05-11|CroixduNord": {
      mark: "anchor",
      umaban: 1,
      odds_when_marked: 2.4,
      odds_snapshot_at: null,
      formed_at: 100,
    },
    "jra-20260621-05-11|PegasusSeiya": {
      mark: "like",
      umaban: 3,
      odds_when_marked: 7.2,
      odds_snapshot_at: null,
      formed_at: 200,
    },
    "jra-20260621-05-11|HoOBiscay": {
      mark: "priceHorse",
      umaban: 6,
      odds_when_marked: 5.1,
      odds_snapshot_at: null,
      formed_at: 300,
    },
  };

  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
  });

  async function openStudio(
    page: import("@playwright/test").Page,
    lang: "en" | "ja",
  ): Promise<void> {
    await page.addInitScript(([l, seed]) => {
      try {
        window.localStorage.setItem("keibamon.lang", l);
        window.localStorage.setItem("kbm.impressions.v1", JSON.stringify(seed));
      } catch {
        /* ignore */
      }
      const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
      Date.now = () => FROZEN;
    }, [lang, STUDIO_IMPRESSIONS] as const);
    await page.goto("/");
    await expect(page.locator(".stepper")).toBeVisible({ timeout: 10_000 });
    // The CTA appears once ≥2 include-marks resolve AND a market exists. Let the
    // initial loadLive settle so the button is enabled.
    await page.waitForTimeout(600);
    await expect(page.getByTestId("studio-cta")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("studio-cta").click();
    await expect(page.locator(".kbm-modal")).toBeVisible();
    await expect(page.locator(".setfamily-view")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  }

  for (const lang of LANGS) {
    test(`studio list layer (${lang})`, async ({ page }) => {
      await openStudio(page, lang);
      // All three list layers render — Wheel is gated on the seeded anchor.
      await expect(page.locator(".setfamily-view")).toBeVisible();
      await expect(page.locator(".formation-view")).toBeVisible();
      await expect(page.locator(".wheel-view")).toBeVisible();
      await page.waitForTimeout(200);
      await expect(page.locator(".kbm-modal-card")).toHaveScreenshot(`studio-list.${lang}.png`);
    });

    test(`studio FillGuide box (${lang})`, async ({ page }) => {
      await openStudio(page, lang);
      await page.locator(".setfamily-row").first().click();
      await expect(page.locator(".fillguide")).toBeVisible();
      // Box = the field grid (highlighted cells), NOT the TicketLines columns.
      await expect(page.locator(".fillguide-cell.on").first()).toBeVisible();
      // Compliance element: present AND visible — an assertion, not just a
      // baseline. A baseline can be regenerated around a regression; this can't
      // (the exportTicketCard gate asserts on exactly this element, and its
      // failure is silent — doShare swallows MissingNotAdvice).
      await expect(page.locator(".fillguide [data-not-advice]")).toBeVisible();
      await page.waitForTimeout(200);
      await expect(page.locator(".fillguide")).toHaveScreenshot(`studio-fill-box.${lang}.png`);
    });

    test(`studio FillGuide formation (${lang})`, async ({ page }) => {
      await openStudio(page, lang);
      await page.locator(".formation-row").first().click();
      await expect(page.locator(".fillguide")).toBeVisible();
      // Formation body = the shared TicketLines columns (post-Phase-2).
      await expect(page.locator(".tl-cols")).toBeVisible();
      await page.waitForTimeout(200);
      await expect(page.locator(".fillguide")).toHaveScreenshot(`studio-fill-formation.${lang}.png`);
    });

    test(`studio FillGuide wheel (${lang})`, async ({ page }) => {
      await openStudio(page, lang);
      await page.locator(".wheel-row").first().click();
      await expect(page.locator(".fillguide")).toBeVisible();
      // Wheel body = TicketLines axis + partners, axis tagged on its slot.
      await expect(page.locator(".tl-axis-tag")).toBeVisible();
      await page.waitForTimeout(200);
      await expect(page.locator(".fillguide")).toHaveScreenshot(`studio-fill-wheel.${lang}.png`);
    });
  }
});

// ============================================================================
// Manual builder (current design) — the open ManualTicketBuilder had ZERO
// visual coverage (mytickets-new-manual-entry only scrolls the CTA into view;
// it never opens the builder). This block opens it and captures TODAY's design
// at two field sizes: the 8-runner fixture (box + formation) and a synthetic
// 18-runner field (formation). The 18-runner formation capture is the one that
// shows the three-stacked-grids problem ticket-structure-unify Phase 3a exists
// to fix — it is the BEFORE image for 3a's handback.
//
// The 18-runner field is opt-in (an /api/live override with LAYOUT_FIELD_18);
// the default 8-runner snapshot is unchanged so no other baseline moves.
// ============================================================================
test.describe("manual builder (current design)", () => {
  test.beforeEach(async ({ page }) => {
    await installApiMocks(page);
  });

  async function openBuilder(
    page: import("@playwright/test").Page,
    lang: "en" | "ja",
  ): Promise<void> {
    await page.addInitScript((l) => {
      try {
        window.localStorage.setItem("keibamon.lang", l);
      } catch {
        /* ignore */
      }
      const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
      Date.now = () => FROZEN;
    }, lang);
    await page.goto("/");
    await page.getByTestId("tab-mine").click();
    await expect(page.locator(".mt-feed")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(400);
    await page.locator(".mt-fab").click();
    await expect(page.locator(".mt-new")).toBeVisible();
    await page.locator(".mt-manual-entry").click();
    await expect(page.locator(".mt-manual")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
  }

  for (const lang of LANGS) {
    test(`manual builder box 8-runner (${lang})`, async ({ page }) => {
      await openBuilder(page, lang);
      // Default is quinella / box mode (the compact number grid).
      await expect(page.locator(".mt-manual-grid")).toBeVisible();
      await page.waitForTimeout(200);
      await expect(page.locator(".mt-manual")).toHaveScreenshot(`manual-builder-box-8.${lang}.png`);
    });

    test(`manual builder formation 8-runner (${lang})`, async ({ page }) => {
      await openBuilder(page, lang);
      // Switch to an ordered bet type → formation mode (stacked per-position grids).
      await page
        .locator(".mt-manual-type")
        .filter({ hasText: lang === "en" ? "Trifecta" : "3連単" })
        .click();
      await expect(page.locator(".mt-manual-matrix")).toBeVisible();
      await page.waitForTimeout(200);
      await expect(page.locator(".mt-manual")).toHaveScreenshot(`manual-builder-formation-8.${lang}.png`);
    });

    test(`manual builder formation 18-runner (${lang})`, async ({ page }) => {
      // Override /api/live with the synthetic 18-runner field (opt-in; default
      // snapshot unchanged). unroute the beforeEach route first so the override
      // is in place before goto.
      await page.unroute("**/api/live");
      await page.route("**/api/live", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(LAYOUT_FIELD_18_SNAPSHOT),
        }),
      );
      await openBuilder(page, lang);
      await page
        .locator(".mt-manual-type")
        .filter({ hasText: lang === "en" ? "Trifecta" : "3連単" })
        .click();
      // Trifecta formation matrix = 3 position columns (was 3 stacked grids).
      await expect(page.locator(".mt-matrix-colhead").nth(2)).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      await expect(page.locator(".mt-manual")).toHaveScreenshot(`manual-builder-formation-18.${lang}.png`);
    });

    test(`manual builder formation 18-runner mid-scroll (${lang})`, async ({ page }) => {
      // Phase 3c — the proof of sticky behaviour. A top-of-list capture cannot
      // see it: scroll the middle runner row to the viewport centre so the
      // sticky column headers are stuck at the top and the sticky cost bar is
      // pinned at the bottom (above the tab bar). expect(page) captures the
      // 390x844 viewport, so the stuck state is what's pinned.
      await page.unroute("**/api/live");
      await page.route("**/api/live", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(LAYOUT_FIELD_18_SNAPSHOT),
        }),
      );
      await openBuilder(page, lang);
      await page
        .locator(".mt-manual-type")
        .filter({ hasText: lang === "en" ? "Trifecta" : "3連単" })
        .click();
      await expect(page.locator(".mt-matrix-colhead").nth(2)).toBeVisible();
      // Pick a few horses per position so a ticket builds — the sticky cost bar
      // is {ticket && isFormationMode}; empty picks → no ticket → no bar.
      const picks: Array<[number, string]> = [
        [0, "1"], [0, "2"], [0, "3"],
        [1, "4"], [1, "5"],
        [2, "6"],
      ];
      for (const [pos, uma] of picks) {
        await page.locator(`.mt-matrix-cell[data-mt-pos="${pos}"][data-mt-uma="${uma}"]`).click();
      }
      await expect(page.locator("[data-mt-sticky-cost]")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      // Scroll the middle matrix row to the viewport centre → the sticky column
      // headers stick at the top and the sticky cost bar pins at the bottom.
      await page.evaluate(() => {
        const rows = document.querySelectorAll(".mt-matrix-row");
        const mid = rows[Math.floor(rows.length / 2)];
        mid?.scrollIntoView({ block: "center" });
      });
      await page.waitForTimeout(300);
      // Durable assertions (#14 pattern): headers + cost bar stay visible
      // (sticky) mid-scroll — a baseline alone can't prove sticky behaviour.
      await expect(page.locator(".mt-matrix-head")).toBeVisible();
      await expect(page.locator("[data-mt-sticky-cost]")).toBeVisible();
      await expect(page).toHaveScreenshot(`manual-builder-formation-18-midscroll.${lang}.png`);
    });

    // Manual-builder fill card (ADR-0011 parity with TicketStudio). A manually
    // built ticket now gets the same JRA-style fill card a studio-built one
    // does — toggled from the preview, mounted WITHOUT onSave/onShare (the
    // builder's Register/Share CTA is the commit path; the card is a copy-view
    // + share-as-image). The 枠連 capture had never been reachable by a user
    // until gate flowed on /api/live, so it had never been pinned by a baseline.
    test(`manual builder fill card box (${lang})`, async ({ page }) => {
      await openBuilder(page, lang);
      // Default quinella/box; pick two horses → 1 combo.
      await page.locator(".mt-manual-cell").first().click();
      await page.locator(".mt-manual-cell").nth(2).click();
      await expect(page.locator(".mt-manual-preview")).toBeVisible();
      await page.locator(".mt-manual-fillcard-toggle").click();
      await expect(page.locator(".fillguide")).toBeVisible();
      // Export gate: [data-not-advice] MUST render in this mount or
      // exportTicketCard throws + the download silently fails. The studio
      // coverage batch asserted this for its mount; this extends it here.
      await expect(page.locator(".fillguide [data-not-advice]")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      await expect(page.locator(".fillguide")).toHaveScreenshot(`manual-fillcard-box.${lang}.png`);
    });

    test(`manual builder fill card bracket (${lang})`, async ({ page }) => {
      await openBuilder(page, lang);
      await page
        .locator(".mt-manual-type")
        .filter({ hasText: lang === "en" ? "Bracket quinella" : "枠連" })
        .click();
      await expect(page.locator(".mt-manual-grid")).toBeVisible();
      // 枠連 (bracket quinella): pick 3 brackets → C(3,2) = 3 combos.
      await page.locator(".mt-manual-cell.bracket-1").click();
      await page.locator(".mt-manual-cell.bracket-2").click();
      await page.locator(".mt-manual-cell.bracket-3").click();
      await expect(page.locator(".mt-manual-preview")).toBeVisible();
      await page.locator(".mt-manual-fillcard-toggle").click();
      await expect(page.locator(".fillguide")).toBeVisible();
      await expect(page.locator(".fillguide [data-not-advice]")).toBeVisible();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);
      await expect(page.locator(".fillguide")).toHaveScreenshot(`manual-fillcard-bracket.${lang}.png`);
    });
  }

  // Phase 3 close-out — two bounding-box invariants a baseline cannot see. The
  // sticky cost bar must never (a) overlap the matrix row it reports on, and
  // (b) slide under the fixed bottom tab bar. (b) is the one that degrades under
  // type scaling: --bottom-bar-h was measured at DEFAULT type size, and the tab
  // bar's height grows with text size, so the cost bar's clearance has to absorb
  // that growth — which is why it is +15px, not the bare minimum. The tab bar
  // also paints ABOVE the cost bar (z-index 50 vs 6), so an overlap is SILENT;
  // this check is the only thing that would go red. Language-independent — EN.
  test("manual builder cost bar clears last row + tab bar", async ({ page }) => {
    await page.unroute("**/api/live");
    await page.route("**/api/live", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(LAYOUT_FIELD_18_SNAPSHOT),
      }),
    );
    await openBuilder(page, "en");
    await page
      .locator(".mt-manual-type")
      .filter({ hasText: "Trifecta" })
      .click();
    await expect(page.locator(".mt-matrix-colhead").nth(2)).toBeVisible();
    // Pick horses per position so a ticket builds — the sticky bar is
    // {ticket && isFormationMode}; empty picks → no ticket → no bar.
    const picks: Array<[number, string]> = [
      [0, "1"], [0, "2"], [0, "3"],
      [1, "4"], [1, "5"],
      [2, "6"],
    ];
    for (const [pos, uma] of picks) {
      await page.locator(`.mt-matrix-cell[data-mt-pos="${pos}"][data-mt-uma="${uma}"]`).click();
    }
    await expect(page.locator("[data-mt-sticky-cost]")).toBeVisible();
    await page.evaluate(() => document.fonts.ready);

    // (a) At the END of the list, the last row sits above the cost bar in flow
    //     (the netkeiba-badge mistake was a FIXED bar floating over the rows —
    //     sticky + flow order makes that impossible; this pins the invariant).
    await page.evaluate(() => window.scrollTo(0, Number.MAX_SAFE_INTEGER));
    await page.waitForTimeout(300);
    const atEnd = await page.evaluate(() => {
      const rows = document.querySelectorAll(".mt-matrix-row");
      const last = rows[rows.length - 1] as HTMLElement | undefined;
      const cost = document.querySelector("[data-mt-sticky-cost]") as HTMLElement | null;
      if (!last || !cost) return null;
      return {
        lastBottom: Math.round(last.getBoundingClientRect().bottom),
        costTop: Math.round(cost.getBoundingClientRect().top),
      };
    });
    expect(atEnd, "last row + sticky cost bar present").not.toBeNull();
    expect(
      atEnd!.lastBottom,
      "last runner row bottom must sit at/above the sticky cost bar top at list end",
    ).toBeLessThanOrEqual(atEnd!.costTop);

    // (b) With the cost bar PINNED — scroll the last row to the viewport bottom,
    //     which keeps the cost bar stuck just above the tab bar — it must clear
    //     the tab bar's top edge. This is the type-scaling-sensitive invariant.
    await page.evaluate(() => {
      const rows = document.querySelectorAll(".mt-matrix-row");
      rows[rows.length - 1]?.scrollIntoView({ block: "end" });
    });
    await page.waitForTimeout(300);
    const pinned = await page.evaluate(() => {
      const cost = document.querySelector("[data-mt-sticky-cost]") as HTMLElement | null;
      const tab = document.querySelector(".bottom-tabbar") as HTMLElement | null;
      if (!cost || !tab) return null;
      return {
        costBottom: Math.round(cost.getBoundingClientRect().bottom),
        tabTop: Math.round(tab.getBoundingClientRect().top),
      };
    });
    expect(pinned, "sticky cost bar + bottom tab bar present").not.toBeNull();
    expect(
      pinned!.costBottom,
      "sticky cost bar must clear the bottom tab bar (the type-scaling invariant)",
    ).toBeLessThanOrEqual(pinned!.tabTop);
  });
});

// Guard against the regression that bit this branch: hiding .foot-version in
// the harness (addStyleTag visibility:hidden, or similar) to make a stale-
// baseline CI run green. The footer version stamp is a real product element
// (Footer.tsx → __APP_VERSION__); if it is worth rendering it is worth one
// assertion that it is VISIBLE in the harnessed page. The companion component
// test (Footer.test.tsx) only covers renderToStaticMarkup, not the harness.
test.describe("version stamp guard", () => {
  test(".foot-version is visible + non-empty in the harnessed page", async ({ page }) => {
    await installApiMocks(page);
    await page.goto("/");
    await page.waitForTimeout(600);
    const el = page.locator(".foot-version");
    await expect(el).toHaveCount(1);
    // toBeVisible covers display:none, visibility:hidden, and zero-size boxes
    // in one assertion. (The hand-rolled getComputedStyle(el).visibility check
    // this replaced missed display:none — visibility is independent of display,
    // so a display:none element still reported "visible".) opacity:0 is still
    // considered visible by Playwright; if that hide ever shows up, add an
    // explicit opacity check here.
    await expect(el).toBeVisible();
    await expect(el).toHaveText(/Keibamon v\d+\.\d+\.\d+/);
  });
});
