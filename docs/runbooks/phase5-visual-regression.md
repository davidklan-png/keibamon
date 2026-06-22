# Phase 5 — Visual regression (App.tsx decomposition + Playwright, frozen clock)

Builds on Phase 4's HTML-string snapshots (auth surface). Phase 5 closes the
CSS-pixel gap with a real browser (chromium) and adds 14 baseline PNGs across
**every screen × {en, ja}**. To make that possible, the 2.7k-line `App.tsx`
monolith (all screens inline as functions inside one component) is split into
per-screen components first — the extraction is **behavior-preserving**
(bundle byte-size unchanged, all 105 existing tests stay green).

Scope cuts decided up front (see ADR-0007 Phase 5 backlog):

- **App.tsx decomposition: behavior-preserving only.** No UX/copy/logic
  changes. Verified by bundle-size parity (364.17 kB before/after) + the
  existing test suite. Visual baselines are the second gate.
- **CSS-pixel coverage: every screen, both languages.** maxDiffPixelRatio: 0
  (any pixel drift fails). One intentional style break is proven to fail
  during Phase 5 sign-off.
- **KV token bucket rate limits: deferred again.** Phase 4's D1 minute-bucket
  counter covers current volume; no demonstrated need for KV yet.
- **Server-side card renderer: deferred again.** Client `html-to-image` works;
  no cross-platform bug reports.

The racing tier (racing D1, `/api/live`, the asset Worker, `tools/jravan`,
`ingestion/`, `src/keibamon_core`) is **not modified**.

## What lives where

| Concern | Where |
|---------|-------|
| App entry (state + effects + loadLive + applyRace + recommend + stepper) | `frontend/src/App.tsx` — 316 lines (down from 2731) |
| My Tickets surface (feed / new / detail / profile / report modal) | `frontend/src/screens/MyTickets.tsx` — `MyTicketsHome` exported; internal `MyTickets` + all state/effects/actions |
| Legacy 4-step builder screens | `frontend/src/screens/{Race,Style,Tickets,Explain}Screen.tsx` — explicit props interfaces |
| My Tickets view-model helpers (mtStateColor, avatarColor, mtSep, mtRaceKey, mtFmtDate, mtPickFeature, mtRunnersOf, mtLoadStored) | `frontend/src/lib/mytickets-view.ts` |
| Shared tiny pure helpers (`yen`, `fmt`) | `frontend/src/lib/format.ts` |
| Shared footer | `frontend/src/components/Footer.tsx` |
| Auth bypass (test-only env var) | `frontend/src/auth/AuthProvider.tsx` — `VITE_PLAYWRIGHT_BYPASS_AUTH=1` branch |
| Playwright config | `frontend/playwright.config.ts` — vite dev on :5174 with the bypass env var |
| Visual fixtures | `frontend/tests/visual/fixtures.ts` — deterministic /api/live + /api/social/* |
| Smoke + visual specs | `frontend/tests/visual/{smoke,visual}.spec.ts` |
| Visual baselines | `frontend/tests/visual/visual.spec.ts-snapshots/*.png` (14 files) |
| Auth-gate HTML snapshots (Phase 4, unchanged) | `frontend/src/app.snapshot.test.tsx` + `__snapshots__/` |
| Racing tier | UNCHANGED |

## Architecture decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | **Extract pure helpers first; screens second; MyTickets last** | Pure helpers (no closures over React state) are the safest move. The 4 legacy screens have explicit props interfaces — extraction is mechanical. The 1709-line MyTickets move is highest-risk so it goes last, after the bundle-size gate proves the pattern works. |
| 2 | **Bundle byte-size as the behavior-preservation gate** | After each extraction: `npm run build` and compare `dist/assets/*.js` size. Identical byte-size (364.17 kB throughout) is strong evidence no code changed semantically. The visual baselines are the second gate. |
| 3 | **`MyTickets.tsx` is one file (not split into feed/new/detail)** | All three views share state (~10 `useState`, ~10 `useEffect`, `now`, `feature`, `friendsOnCard`, etc.) and would balloon props if separated. A single 1709-line component with internal `render{Feed,New,Detail,Profile,ReportModal}` functions preserves the closures exactly. Trade-off: file size, not behavior. |
| 4 | **Test-only auth bypass env var (not network mocking, not a separate dev server)** | `VITE_PLAYWRIGHT_BYPASS_AUTH=1` makes AuthProvider return a fake signed-in session. Off in production builds (env var unset). Cheapest path to full MyTickets coverage. |
| 5 | **`page.route()` mocks for `/api/live` + `/api/social/*`** | One fixture race (open G1 at Tokyo, 8 runners) + two CommittedTickets (open quinella owned by "you", won win owned by "Rin"). Deterministic shape → deterministic render. |
| 6 | **Freeze `Date.now()` in the test init script** | The countdown chip (`/api/live` post_time=15:40 JST) ticks every second under wall-clock; pixel drift between runs fails `maxDiffPixelRatio: 0`. Override `Date.now` to `2026-06-21T13:00:00+09:00` so the countdown renders a deterministic "2:40:00 to go" (en) / "開始まで 2:40:00" (ja). |
| 7 | **`maxDiffPixelRatio: 0`** | Strictest possible. A single intentional style change (e.g., bumping `.mt-brand-name` font-size 17→22 px) fails the suite — proven during sign-off. The trade-off is brittleness to sub-pixel rendering across chromium versions; accepted. |
| 8 | **Walk forward via UI clicks, not URL deep-links** | `App.tsx` always starts at `step="mine"`; deep-linking isn't supported. Each test lands on the feed, then clicks `.mt-fab` → `.mt-back-head .lang-toggle` (Builder/詳細) → stepper buttons. Same UX path a real user takes. |
| 9 | **`workers: 1, fullyParallel: false, retries: 0`** | Visual regression can't be parallelized safely (fonts, clock, dev-server all share state). One failure mode — no flaky retries hiding real regressions. |
| 10 | **Self-hosted fonts (Phase 4) are critical infrastructure** | If the runtime Google Fonts `@import` were still in `styles.css`, every visual baseline would fail intermittently (network-dependent glyph substitution). Phase 4's font subsetting + self-hosting made Phase 5's strict threshold achievable. |
| 11 | **KV token bucket: SKIP again** | Phase 4's D1 minute-bucket counter covers current volume; no data justifying the work. Phase 6 backlog. |

## App.tsx decomposition

The 2731-line monolith becomes:

| File | Lines | Contents |
|------|------:|----------|
| `src/lib/mytickets-view.ts` | 108 | MtView type, mt* view-model helpers (pure) |
| `src/lib/format.ts` | 13 | `yen(n)`, `fmt(n, d)` |
| `src/components/Footer.tsx` | 16 | Shared footer (used by App + MyTicketsHome) |
| `src/screens/RaceScreen.tsx` | 290 | Race selection + runner list |
| `src/screens/StyleScreen.tsx` | 142 | Persona grid + complexity/flavor choosers |
| `src/screens/TicketsScreen.tsx` | 111 | Recommended tickets with mood badges |
| `src/screens/ExplainScreen.tsx` | 116 | "Why this ticket" — lead + math disclosure |
| `src/screens/MyTickets.tsx` | 1709 | feed / new / detail / profile / report modal |
| `src/App.tsx` | 316 | Entry: state, effects, loadLive, stepper nav |

**Behavior-preservation gate:** `npm run build` produces identical
`dist/assets/index-*.js` size (364.17 kB) before and after every extraction.
All 105 vitest tests stay green at every commit.

## Visual regression suite

### Coverage

14 baselines under `frontend/tests/visual/visual.spec.ts-snapshots/`:

| Screen | Selector landmark | Baselines |
|--------|-------------------|-----------|
| MyTickets feed | `.mt-brand-name` | `mytickets-feed.{en,ja}.png` |
| MyTickets new bet | `.mt-new` | `mytickets-new.{en,ja}.png` |
| MyTickets detail (open) | `.mt-detail` | `mytickets-detail-open.{en,ja}.png` |
| Legacy race | `.race-selector` / `.race-card` | `legacy-race.{en,ja}.png` |
| Legacy style | `.persona-grid` | `legacy-style.{en,ja}.png` |
| Legacy tickets | `.ticket` | `legacy-tickets.{en,ja}.png` |
| Legacy explain | `.explain-lead` | `legacy-explain.{en,ja}.png` |

Plus a smoke test (`smoke.spec.ts`) that exercises the bypass wiring
end-to-end (`mt-brand-name` visible + `.mt-banner-name` contains
"Takarazuka").

### Auth bypass

`frontend/src/auth/AuthProvider.tsx` gains a `VITE_PLAYWRIGHT_BYPASS_AUTH=1`
branch that returns a fake `AuthState`:

```ts
const PLAYWRIGHT_VALUE: AuthState = {
  isSignedIn: true,
  userId: "playwright-fake-user",
  ageVerified: true,
  getToken: async () => "playwright-fake-token",
  openSignIn: () => {},
  setAgeVerified: async () => {},
};
```

Branch order in `AuthProvider`: `PLAYWRIGHT_BYPASS` → `!CLERK_ENABLED` →
`ClerkAuthInner`. The env var is set ONLY in `playwright.config.ts`'s
`webServer.command`; production builds (`vite build` without the env) compile
the dead branch out.

### Mock fixtures

`tests/visual/fixtures.ts` exports:

- `FIXTURE_SNAPSHOT` — one open G1 race at Tokyo, R11, 8 runners
  (Croix du Nord at win_odds=2.4).
- `FIXTURE_TICKETS` — two CommittedTickets: open quinella owned by "you",
  won win ticket owned by "Rin" (with `cheers: 41`).
- `installApiMocks(page)` — registers `page.route()` handlers for
  `/api/live` and `/api/social/*` (`/tickets`, `/me`, `/friends/...`).

### Clock freeze

`landOnFeed(page, lang)` calls `page.addInitScript` before navigating:

```ts
await page.addInitScript((l) => {
  window.localStorage.setItem("keibamon.lang", l);
  const FROZEN = Date.parse("2026-06-21T13:00:00+09:00");
  Date.now = () => FROZEN;
}, lang);
```

Fixture race `post_time=15:40 JST`. With `now` frozen at 13:00 JST, the
countdown renders `2:40:00 to go` (en) / `開始まで 2:40:00` (ja) —
deterministic across runs. The `setInterval` in MyTickets keeps firing but
the value never changes.

### Strict threshold

```ts
expect: { toHaveScreenshot: { maxDiffPixelRatio: 0 } }
```

Any pixel drift fails. Phase 5 sign-off proved the gate works: bumping
`.mt-brand-name` font-size from 17→22 px made the `mytickets-feed` tests
fail (en + ja); reverting brought the suite green.

## Setup — run these yourself

### 1. Install Playwright (already installed in Phase 5)

```bash
cd frontend
npm install  # picks up @playwright/test from package.json
npx playwright install chromium
```

### 2. Run the suite

```bash
cd frontend
npm run test:visual
```

The first run will boot vite dev on :5174 with
`VITE_PLAYWRIGHT_BYPASS_AUTH=1` and execute 15 tests (1 smoke + 14 visual).
Expect "15 passed (17s)".

### 3. Update baselines after an intentional change

When a deliberate UI change lands (e.g., re-spacing the race card):

```bash
cd frontend
npm run test:visual -- --update-snapshots
git add tests/visual/visual.spec.ts-snapshots/
git commit -m "ADR-0007 Phase 5 visual: refresh baselines for <change>"
```

Commit the new baselines alongside the source change.

### 4. Verify

```bash
# Visual regression suite
cd frontend && npm run test:visual

# Existing vitest suite (unchanged after extraction)
cd frontend && npm test

# Build still bundles (font + extraction sanity)
cd frontend && npm run build

# Scope gate — racing tier must be untouched
git diff main...HEAD --stat
# Expect: only frontend/ and docs/
```

## Rollback

Phase 5 is opt-in via the new files; it doesn't change runtime behavior.
To disable:

1. **Disable the visual suite** (keep the extraction):
   ```bash
   # Remove the test scripts from frontend/package.json or just don't run them
   # The bypass env var is only set in playwright.config.ts — never in prod.
   ```

2. **Revert the extraction** (extreme — would un-fix the App.tsx monolith):
   ```bash
   git revert <phase5-extraction-commits>
   ```
   This loses the per-screen componentization but doesn't break production.

3. **The auth bypass is unreachable in prod.** Even if you keep the
   AuthProvider branch, `import.meta.env.VITE_PLAYWRIGHT_BYPASS_AUTH` is
   unset in production builds → the dead branch is eliminated at compile
   time. No runtime risk.

## Common gotchas

- **Set `keibamon.lang` BEFORE first paint.** Use `page.addInitScript`, not
  `page.evaluate` after `goto`. The i18n store reads `localStorage` once on
  module load; setting it later misses the first render.
- **Freeze `Date.now()` BEFORE first paint too.** The `setInterval` ticks
  start when MyTickets mounts; if the override lands after, you get one
  real tick before the fake one. `addInitScript` runs before any app code.
- **The Builder/詳細 button lives in `.mt-back-head`, not `.mt-new`.** The
  `lang-toggle` class is reused (legacy reason); the new-bet view has it
  in the header, not the body. Selector: `.mt-back-head .lang-toggle`.
- **Run from `frontend/`, not the repo root.** `npm run test:visual` reads
  `frontend/package.json`. From the root, npm errors out (no package.json).
- **`maxDiffPixelRatio: 0` is intentionally brutal.** Sub-pixel rendering
  differences across chromium versions CAN fail this. If CI is on a
  different OS than the baseline-capture host, expect to update baselines
  per OS. The committed baselines are `*-chromium-darwin.png`.
- **Visual tests are serial.** `workers: 1, fullyParallel: false` — a single
  dev server, a single browser context, no parallel races on the clock or
  the dev server. Don't try to speed this up; flakiness will outweigh the
  wall-clock savings.
- **Auth bypass ≠ production auth path.** A test passing under
  `VITE_PLAYWRIGHT_BYPASS_AUTH=1` does NOT prove Clerk's flow works. The
  existing `AuthProvider` unit tests cover the real Clerk branch; visual
  tests cover render correctness given a signed-in state.
- **Racing tier drift.** Do NOT edit `wrangler.jsonc` (root), `src/worker.js`,
  `/api/live`, `tools/jravan/`, `ingestion/`, or `src/keibamon_core/` from
  this branch. `git diff main...HEAD --stat` should show only `frontend/`
  and `docs/`.

## Decisions deferred

- **Server-side card renderer.** Client `html-to-image` works; no
  cross-platform bug reports justifying the work. Phase 6 backlog.
- **KV token bucket rate limits.** Phase 4's D1 minute-bucket is sufficient
  for current volume. Phase 6 backlog.
- **Moderation review queue UI.** Phase 4 stores reports in D1 but doesn't
  surface them for staff review. Phase 6 backlog.
- **Multi-browser / multi-OS visual baselines.** Phase 5 covers
  chromium-darwin only. WebKit/Firefox and Linux/Windows baselines are
  Phase 6 if/when CI grows multi-platform runners.

## Phase 6 backlog (NOT done in Phase 5)

- **KV token bucket** for rate limits (carried from Phase 4).
- **Server-side card renderer** for share image (carried from Phase 4).
- **Moderation review queue UI** (carried from Phase 4).
- **Drive `/api/live` to emit result** (carried from Phase 2 — the racing-tier
  dependency that gates real settlement in prod).
- **Multi-platform visual baselines** (chromium-darwin only in Phase 5).
