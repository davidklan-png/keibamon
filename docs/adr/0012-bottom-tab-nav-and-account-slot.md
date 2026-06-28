# ADR-0012: Bottom tab bar, single account slot, relocated lane control

- **Status:** Accepted
- **Date:** 2026-06-28
- **Surface:** Frontend (App shell — header, global nav)
- **Companion:** `docs/ux-audit-netkeiba.md`, `docs/ux-implementation-plan.md` (Session 1)

## Summary

The phone header was carrying six action elements plus the brand in one CSS-grid
row: language toggle, two lane pills (Quick / Research), a My-Tickets tab, a
Reference tab, and the Clerk `<UserButton>`. It overflowed gracefully but sat at
its limit, and it conflated three different kinds of navigation in one row —
lane selection, destination switching, and account utility. Measured against the
NetKeiba app (the muscle-memory reference for any JRA fan), the right model is a
persistent **bottom tab bar** for destinations, a single **account slot** for
auth utility, and **in-screen controls** for mode choices.

## The decisions

### D1 — Destinations move to a persistent bottom tab bar

Races / My Tickets / Reference become a fixed bottom navigation bar
(`components/BottomTabBar.tsx`), mapped onto the existing `view` enum
(`browse | mine | reference`). This is a remap of state already present, not a
new router. The bar renders on all three destination screens, each of which
roots on `.app` (so the existing `.app` bottom padding clears the fixed bar).

### D2 — One top-right account slot, two states

The header top row holds only brand, language toggle, and a single account slot.
Signed-out: one "Sign in" affordance calling `openSignIn()`. Signed-in: the
hosted `<UserButton>` (gating on `isSignedIn && clerkMounted` preserved for the
Playwright bypass branch). This kills the previous pattern where the My-Tickets
tab doubled as the sign-in trigger.

### D3 — The two-lane funnel is relocated, not removed

Quick / Research move from header pills to an in-view segmented control on the
Races view, still setting and persisting `funnel` via `saveFunnel`. Routing is
unchanged for now (Quick → live card; Research → existing roundup surface).

## Scope boundary (what this ADR does NOT do)

Folding the weekend roundup *into* the Races tab (so Research is a true sub-mode
rather than a jump to the Reference destination) is deferred to a later session.
The signed-out My-Tickets empty-state, the builder-spine collapse, inline marks
on the runner row, and the persistent race-context bar are each their own
session per the implementation plan. Dead CSS for the removed header controls
(`.mine-tab`, `.reference-tab`, `.lane-pill`) is left in place for a later sweep.

## Consequences

- The header stops being the overflow risk it was, and survives JA/EN labels in
  three bottom tabs far more robustly than six labels in one row.
- `view` is now the single source of truth for both the rendered destination and
  the active tab — future destinations are a tab + an enum case.
- Visual/Playwright baselines must be refreshed on mac-dev; the sandbox verifies
  types, unit tests, and the production bundle but not pixels.
