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
import { installApiMocks, FIXTURE_WEEKEND_PUBLISHED } from "./fixtures";

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
