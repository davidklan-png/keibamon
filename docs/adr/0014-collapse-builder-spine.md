# ADR-0014: Collapse the ticket-builder spine to Race → Tickets

- **Status:** Accepted
- **Date:** 2026-06-30
- **Surface:** Frontend (ticket builder)
- **Companion:** `docs/ux-audit-netkeiba.md` (§3), `docs/ux-implementation-plan.md` (Session 3a); builds on [ADR-0012](0012-bottom-tab-nav-and-account-slot.md)

## Summary

The builder was a four-step stepper — `race → style → tickets → explain`. Measured against NetKeiba (which gets from a race to a bet slip with the prediction marks already carried in), two of those steps were friction: Style was already optional ("adjust later"), and Explain was a terminal screen the user reached last and could skip — the wrong place for the honesty posture that is the product's first principle. This collapses the spine to **Race → Tickets**.

## Decision

**Style is no longer a step.** Its controls (the 5-personality grid, budget/unit, and the advanced complexity/flavor knobs) move verbatim into an inline **"Refine ▾"** `<details>` panel (`screens/RefinePanel.tsx`) at the top of the Tickets screen. It edits the same `style` state through the same `onChange`, so auto-regeneration on style change is unchanged.

**Why is no longer a step.** The ticket *reasoning* (lead sentence, coverage/upside/fragility/cost, combos, math/house-edge disclosure) is extracted into `screens/TicketWhy.tsx` and rendered as an inline **"Why ▾"** `<details>` on every ticket card. Honesty is now one tap from every recommendation instead of a final gate.

**The per-horse form/marks drill is deliberately NOT inlined into tickets.** That capability already lives on the Race screen (tap a runner → FormPanel/HorseDrillView). Keeping it there avoids a second marks surface and keeps ticket cards light — and it's where Session 4 will consolidate inline marks.

## Consequences

- Race → Tickets is two steps; the recommender, the "Updated with your marks" toast, `standardTickets()`/`resetToStandard()`, the empty-state, and Place all behave as before.
- `StyleScreen.tsx` and `ExplainScreen.tsx` are now thin re-export shims (the sandbox can't delete files); nothing imports or routes them. **They should be `git rm`'d on mac-dev** with no further change, since live imports already point at `RefinePanel`/`TicketWhy`.
- A few i18n keys (`nav.style`, `nav.explain`, `race.refine`, `tickets.backToStyle`) are now unused but left in place (balanced across en/ja so the parity guardrail stays green); prune later.
- This is Session 3a. Session 3b (folding the weekend roundup into the Races "Research" segment) is a separate commit because it also touches `App.tsx`; 3a must land first to keep the two reviewable.
