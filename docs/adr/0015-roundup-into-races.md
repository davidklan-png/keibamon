# ADR-0015: Fold the weekend roundup into the Races "Research" lane

- **Status:** Accepted
- **Date:** 2026-06-30
- **Surface:** Frontend (Races view, Reference destination)
- **Companion:** `docs/ux-audit-netkeiba.md` (§1), `docs/ux-implementation-plan.md` (Session 3b); builds on [ADR-0012](0012-bottom-tab-nav-and-account-slot.md) and [ADR-0014](0014-collapse-builder-spine.md); resolves the scope-boundary deferral recorded in ADR-0012

## Summary

ADR-0012 relocated the two-lane funnel (Quick / Research) out of the header into an in-view segmented control on the Races view, but deferred the actual convergence: Quick stayed in `view=browse`, while Research still *jumped* the user to the Reference destination (`view=reference`) — a different shell with its own header and a glossary|roundup tab nav. The two lanes thus landed in two different destinations, even though they share the same impression store and the same research posture.

This closes that loop. The Research segment now stays in `view=browse` and renders the weekend roundup **inline**, sharing the App header + bottom tab bar + impression spine with the live-card builder. The Reference destination becomes glossary-only.

## Decision

**The two-lane funnel converges on the Races destination.** The Research segment of the lane control no longer sets `view="reference"`; it sets `funnel="research"` and stays in `view=browse"`. In research mode:
- The race→tickets stepper is hidden (the builder spine doesn't apply to the roundup path).
- The lane segmented control stays visible so the user can flip back to Quick.
- `<RoundupPanel>` renders in place of `<RaceScreen>`/`<TicketsScreen>`.

**RoundupPanel is extracted as a reusable, section-returning unit** (`screens/RoundupPanel.tsx`). It owns the worker fetch (`/api/weekly-report`), edition selection, deterministic report generation, and the published vs. empty cadence state — the same logic the old `RoundupTab` owned inside `ReferenceScreen`. It takes `{ impressions, onSetImpressions, oddsSnapshotAt }` and returns `<section>` elements; the caller's shell provides `<main>`, header, and `Footer`. Marks made in the roundup drill-down land on the same spine as marks made on the live-card `FormPanel` (the read-back path is pinned by `crossSurface.test.tsx`).

**The Reference destination is reduced to glossary-only.** `ReferenceScreen` drops its `glossary|roundup` tab nav, the `RoundupTab` helper, the `EmptyRoundup` helper, and the `impressions`/`onSetImpressions`/`oddsSnapshotAt` props (no longer needed on this surface). It renders `<GlossaryView>` directly under the existing header + `Footer`. The i18n `reference.subtitle` strings (en/ja) are updated to drop the "graded-stakes research" half.

## Scope boundary (what this ADR does NOT do)

- The Reference **destination** stays in the bottom tab bar (`BottomTabBar`'s third tab still routes to `view="reference"`). Only its content narrows.
- The auto-regen effect, the recommender, `placeTicket`, and the live-snapshot polling are all unchanged — Research mode just doesn't engage them.
- The lane-choice persistence (`saveFunnel`/`loadFunnel`) is unchanged. A user who relaunched into Research pre-ADR-0015 now relaunches into the inline roundup rather than the Reference destination; this is the intended improvement, not a regression.

## Consequences

- `App.tsx` routing for Research changes from `setView("reference")` to `setView("browse") + setFunnel("research")`. The `view==="reference"` branch still exists for the bottom-bar's Reference tab; it renders the reduced `ReferenceScreen` (no impressions props).
- The inline wiring (`funnel==="research"` swaps RoundupPanel in for RaceScreen/TicketsScreen) lives in `App.tsx` and is therefore deliberately untested at the component level — `App.tsx` carries ~10 `useEffect` hooks and a fetch-on-mount and is excluded from the snapshot pattern by `app.snapshot.test.tsx`. The contract is pinned instead by:
  - `screens/RoundupPanel.test.tsx` — published-edition vs. empty-state rendering.
  - `screens/ReferenceScreen.test.tsx` — glossary-only regression guard (fails if the old `<nav aria-label="reference tabs">` or any `.roundup-tab` / `.roundup-empty` class reappears on this surface).
  - Playwright visual regression (mac-dev) for the rendered browse shell.
- Visual baselines taken inside the Reference destination will drift (the tab nav and roundup content are gone); baselines taken on the Races destination will gain a new research-mode variant when added.
- The `reference.glossary` / `reference.roundup` i18n keys are now unused on the Reference surface (no tab nav to label them); left in place for the parity guardrail. Prune in a later sweep alongside the ADR-0014 leftovers.
