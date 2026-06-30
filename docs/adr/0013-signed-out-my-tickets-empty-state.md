# ADR-0013: Honest signed-out My Tickets empty state

- **Status:** Accepted
- **Date:** 2026-06-28
- **Surface:** Frontend (My Tickets route)
- **Companion:** `docs/ux-audit-netkeiba.md` (§4), `docs/ux-implementation-plan.md` (Session 2); builds on [ADR-0012](0012-bottom-tab-nav-and-account-slot.md)

## Summary

After ADR-0012, the bottom "Tickets" tab routes everyone — signed-out included — to `view="mine"`. But `MyTicketsHome` still wrapped that route in `AuthGate`, which rendered a full-screen `SignInScreen` for signed-out visitors. A destination tab that silently becomes a sign-in wall is the clunky pattern the audit flagged: it promises content and delivers an auth ambush, and the full-bleed screen also hid the new bottom bar.

## Decision

Signed-out visitors to My Tickets now get an **honest empty state** (`screens/MyTicketsEmpty.tsx`) instead of `SignInScreen`:

- A heading + one line of body copy ("Sign in to save your tickets").
- A **teaser of the user's locally-made impression marks**, read from the localStorage impression store (which works signed-out): "You've marked N horses across M races — sign in to save them." N = entries in the `${race_id}|${horse_key}`-keyed `ImpressionMap`; M = distinct `race_id` prefixes. Zero marks → a gentler variant with no fabricated numbers.
- An inline "Sign in" CTA calling `openSignIn()` — the same Clerk modal the header account slot uses.

The component renders inside the normal `.app` shell so the bottom tab bar (and its clearance padding) stays visible. The signed-in branch (AgeGate → feed) is unchanged. `App` threads the impression map into `MyTicketsHome` as a prop.

## Consequences

- Sign-in is weighted low and surfaced at the moment of value (save), not as a gate on the funnel — consistent with the low-friction, non-salesy posture. Casual fans can research and mark horses anonymously; the marks already persist locally.
- `AuthGate` is no longer used by this route but is retained (and still unit-tested) as a generic component. `SignInScreen` is still reachable via `AuthGate` elsewhere and remains snapshot-tested.
- The local-marks teaser sets up Session 5's keystone: **merging anonymous marks into the account on sign-in**. Until that lands, signing in does not yet migrate local marks to the server — the teaser promises saving, so Session 5 should not slip far behind.
- Visual baselines refreshed on mac-dev (the `.mt-empty*` styles); the sandbox gate covers types, units, and the production bundle only.
