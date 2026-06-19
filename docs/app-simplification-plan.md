# Keibamon Simplification — Build Plan

Companion to `docs/app-simplification-bdd.md`. Turns the must-have scenarios into
a phased, tracked rework of `frontend/src/App.tsx` and its engine inputs.

**Governing rule:** reorder, don't rewrite. The recommender (`lib/recommender.ts`),
the math (`lib/fairvalue.ts`), and the data lake are untouched. Each phase is
independently shippable and gated by the BDD scenarios it satisfies.

---

## Phase 0 — Lock the contract (do first)

Encode the Section 5 scenarios as tests *before* changing UI, so simplification
can't silently break the core job.

- Add `frontend/src/lib/defaultTier.test.ts`: assert `standardTickets()`'s engine
  call (`recommend({ allUmas, p, style: DEFAULT_STYLE, intuition: {} })`) returns
  exactly three tickets with cost + payout populated and no required preconditions.
- Add a render smoke test (extend the existing `i18n.test.tsx` harness) asserting:
  on a fresh race, a single primary CTA reaches tickets without visiting Style or
  Intuition.
- Existing `recommender.test.ts` / `fairvalue.test.ts` stay green throughout.

**Satisfies:** the acceptance gate for every later phase.
**Risk:** none. Pure additions.

## Phase 1 — Invert the default (Decision 1)

Make one-tap tickets the spine; the wizard becomes optional refinement. The
handler already exists (`standardTickets()` → `onStandard`); this is hierarchy and
framing, not new logic.

- Race screen: promote `onStandard` ("Standard tickets · 3 picks") to the single
  prominent primary action; demote `onRefine` to a quiet secondary link.
- Stepper (`steps[]`): keep Style/Intuition reachable (already `enabled` at
  `runners >= 2`) but reframe them visually as "Refine," not sequential gates.
  Consider relabeling `nav.style`/`nav.intuition` under a "Refine" grouping.
- Confirm Tickets is never a dead end (auto-`regenerate` on change already covers
  this).

**Satisfies:** `Feature: Refinement is optional, never a gate` (both scenarios);
`Scenario: Get tickets without making any decisions`.
**Risk:** low — no engine/data change. Cost is the `App.tsx` nav/hierarchy edit.

## Phase 2 — Collapse the three knobs into one (Decision 2)

One control — "How do you want to play?" (the 5 personalities). Derive flavor and
complexity from personality; recover the raw knobs under an Advanced expander.

- Add a `personality → { flavor, complexity }` mapping (proposed below) and apply
  it when building the `recommend` input, so Style no longer needs standalone
  `flavor`/`complexity` selectors on the default path.
- `StyleScreen`: keep personality + budget on the default surface; move
  `complexity` and `flavor` selectors into an "Advanced" disclosure.
- `DEFAULT_STYLE` / `StyleState`: keep the fields (engine still reads them) but
  treat personality as the source of truth unless Advanced overrides.

Proposed mapping (review/tune — derived from `app_plan.md` personalities):

| Personality | flavor | complexity |
|---|---|---|
| Safe-ish | chalk | two |
| Balanced | mixed | auto |
| Longshot Hunter | value | three |
| Fan Pick | mixed | auto (anchored) |
| Anti-Chalk | value | two |

**Satisfies:** `Scenario: Express a single feeling without learning a system`
(never reconcile two contradicting controls).
**Risk:** medium — touches the engine *input shape*, not the engine. Power-user
knobs preserved under Advanced (mitigates Decision 2's stated risk). Add a
snapshot test per personality so the derived mapping is pinned.

## Phase 3 — Trim the ticket card; math becomes progressive (Decision 3)

Default card shows two numbers + a mood label. Everything quantitative moves to
"Why."

- `TicketsScreen` card (default): **cost**, **what you win if it hits**, and a
  plain label ("safer" / "longshot"). Remove hit-estimate %, average payout as
  raw figures, variance, takeout note, value/chalk tag from the default card.
- `ExplainScreen` ("Why"): keep/own fair value (Henery), hit estimate, variance,
  coverage, takeout reminder. Plain-language sentence renders *first*, math below.
- Keep cost visually >= payout (honesty guardrail).
- i18n: no new concepts on the default surface; move dense keys to the explain
  block in `en.ts` / `ja.ts`.

**Satisfies:** `Scenario: Understand a ticket in plain language`; the cost-honesty
and "no edge claims" scenarios under `Feature: Honest by default`.
**Risk:** low-medium — UI + copy only; `fairvalue.ts` untouched. Honesty optics
covered by keeping takeout one tap away.

## Phase 4 — Tier the depth, fence the deferred (Decisions 4–5)

- Ensure nothing on the deferred list (advanced ticket modes, saved profiles,
  alerts, jockey/trainer lookup) appears on the default path; stub them as paid/
  refine placeholders only.
- Add the takeout/"not betting advice" reachability as a standing check.

**Satisfies:** `Scenario: Takeout is never hidden`; sequencing guardrail.
**Risk:** low. Mostly a guard and copy pass.

---

## Sequencing & acceptance

```
Phase 0 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 4
(tests)    (invert)    (one knob)   (trim card)  (tier/fence)
```

- Phase 0 blocks 1–4 (the contract must exist first).
- Phases 1 → 3 are strictly ordered (each reframes what the next touches).
- Phase 4 can begin once 3 is green.
- **Done = the Section 5 scenarios pass on the default path.** Deferred features
  (Decision 5) do not return until that holds.

## Files in scope

| File | Phases | Change |
|---|---|---|
| `frontend/src/App.tsx` | 1,2,3 | nav hierarchy, screen wiring |
| `frontend/src/App.tsx` (`StyleScreen`) | 2 | personality-primary, Advanced disclosure |
| `frontend/src/App.tsx` (`TicketsScreen`,`ExplainScreen`) | 3 | trim card, move math |
| `frontend/src/lib/types.ts` / `DEFAULT_STYLE` | 2 | personality→knob mapping |
| `frontend/src/i18n/en.ts`,`ja.ts` | 3 | relocate dense keys |
| `frontend/src/lib/*.test.ts` + new tests | 0,2 | contract + mapping snapshots |

Out of scope: `recommender.ts` and `fairvalue.ts` logic, backend, lake.
