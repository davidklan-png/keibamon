# Keibamon App — First-Principles BDD & Simplification

Status: proposal for review · Date: 2026-06-20 · Owner: David (PM)
Anchored on **one user**: the casual younger fan who wants to turn a hunch into a
fun ticket — not a pro bettor running a terminal.

---

## 1. The problem, in one line

The feedback "it's too complicated" is correct, and the cause is not the number
of *screens* — it's the number of *concepts* a casual fan must understand before
they get the one thing they came for: a ticket they can place and explain to a
friend.

## 2. Diagnosis — where the complexity actually concentrates

The flow is a five-step wizard (Race → Style → Intuition → Tickets → Why). To
complete one pass, a casual fan is asked to absorb **~11 quantitative or jargon
concepts**:

| Screen | Concepts the user must parse |
|---|---|
| Style | unit stake, complexity (4 modes), runner flavor (3 modes), betting personality (5) |
| Intuition | win-probability %, per-horse intent tags |
| Tickets | lines, cost, hit-estimate %, average payout, variance/fragility, takeout note, value-vs-chalk tag |
| Why | coverage, fair-value multiplier (Henery), upside, fragility, takeout reminder |

Three structural findings, each grounded in the current code:

**Finding A — the controls are redundant, not just numerous.** A betting
personality (Safe-ish, Longshot Hunter, etc.) already implies a runner flavor and
a complexity. The engine (`recommender.ts`) even derives bet types from
`(personality, complexity)` and reuses `flavor` for the same scoring. We expose
three overlapping knobs (personality × flavor × complexity) for what is really
one choice. The casual fan reads this as "lots of decisions," and any two of them
can contradict each other.

**Finding B — the simple path already exists but is buried.** The Race screen
already has a "Standard tickets · 3 picks" CTA with the hint "Style and intuition
are optional refinements." So a one-tap happy path is *in the code* — but the UI
frames the full five-step wizard as the spine and the simple path as a side door.
The default should be inverted.

**Finding C — the math vocabulary leaks into the primary surface.** Fair-value
multiplier, hit-estimate %, variance, takeout/overround, and the Henery note all
appear on the Tickets/Why screens by default. For a casual fan this is the
"trading-screen aesthetic" `app_plan.md` explicitly says to avoid. The math is
good and should stay — but as *progressive disclosure*, not the default view.

## 3. First principles — the one job

Strip everything away and the product's single job is:

> **Turn a feeling about a race into one ticket the user understands and can
> place — in under a minute, with no jargon required.**

Everything else (personalities, intuition tags, fair value, live odds, paid
features) is a *refinement* that must earn its place against that job. If a
feature does not make the one-minute happy path faster or more fun, it moves
behind a tap.

## 4. The big decisions (and their downstream impacts)

These are the calls that shape the system's future. Each is cut / keep / defer
with the consequence spelled out.

### Decision 1 — Make "one tap to three tickets" the default; the wizard becomes optional refinement.
- **Do:** Land the user on Race → a single primary CTA produces Safe / Balanced /
  Spicy tickets immediately. Style and Intuition become a "Refine" affordance, not
  a gate.
- **Impact:** This is a *navigation* change, not an engine change — the standard
  path already exists. Low build cost, highest UX payoff. Future-proofs the funnel:
  every later feature plugs in as an optional refinement instead of another wall.
- **Risk:** None to data correctness. The only cost is reworking `App.tsx` step
  gating (currently `steps[].enabled`).

### Decision 2 — Collapse personality × flavor × complexity into ONE control: "How do you want to play?"
- **Do:** Keep the 5 personalities as the single expressive choice. Derive flavor
  and complexity from the personality internally (the engine nearly does this
  already). Drop the standalone flavor and complexity selectors from the default UI.
- **Impact:** Removes the largest single block of decisions and eliminates the
  contradiction class (personality says one thing, flavor says another). Cleaner
  contract for the future preference engine: personality → constraint set, one
  mapping to test instead of a 5×3×4 matrix.
- **Risk:** Power users lose two knobs. Mitigate by surfacing them under "Refine"
  (Decision 4), not deleting them.

### Decision 3 — Demote the math vocabulary to progressive disclosure; keep two numbers on the ticket card.
- **Do:** A default ticket card shows only **cost** and **what you win if it
  hits** (plus a plain "longshot / safer" label). Fair value, hit-estimate %,
  variance, takeout, and Henery move to the "Why" expand.
- **Impact:** Directly fixes the "concepts too dense" feedback while honoring the
  honesty guardrails — takeout and "not betting advice" stay one tap away, never
  hidden. The math core (`fairvalue.ts`) is untouched; only its *exposure* changes.
- **Risk:** Honesty optics. Mitigate: cost stays more prominent than payout
  (guardrail already in `app_plan.md`), and the takeout reminder lives in "Why".

### Decision 4 — Keep depth, but tier it: casual default, hobbyist refinement, paid live context.
- **Do:** One progressive-disclosure ladder — (1) one-tap tickets, (2) Refine
  (personality + intuition + the recovered knobs), (3) Why (the math), (4) paid
  live/lookup. Nothing is deleted; everything is sequenced.
- **Impact:** Sets the monetization spine. The paywall sells *live convenience and
  context* on top of an already-complete free path — exactly the positioning in
  `app_plan.md`, and now structurally enforced rather than aspirational.
- **Risk:** Scope creep at each tier. The BDD scenarios below are the contract
  that keeps the default tier minimal.

### Decision 5 — Defer everything not on the one-minute path until the default tier tests green.
- **Defer:** advanced ticket modes (wheel/banker/formation), saved profiles,
  alerts, jockey/trainer lookup. All are Milestone 3–4 in `app_plan.md`.
- **Impact:** Protects the simplification. Re-adding features before the core loop
  is clean is how we got here. These come back as paid refinements once the casual
  happy path passes its scenarios.

## 5. BDD — must-have behaviors (the contract)

Written first, before any code. These define "done" for the simplified default
tier. Anchored on the casual fan. Scenarios are the acceptance gate; if a change
breaks one, it ships behind a refinement tap, not on the default path.

```gherkin
Feature: One-tap ticket — the core job
  As a casual younger fan
  I want to turn a feeling about a race into a ticket I understand
  So that I can play for fun without learning bettor jargon

  Background:
    Given a race card is available (live or manual odds)

  Scenario: Get tickets without making any decisions
    When I open a race
    And I tap the primary "Get tickets" action
    Then I see up to three tickets
    And each ticket shows only its cost and what I win if it hits
    And each ticket shows one plain mood label (safer / balanced / spicier),
        derived from the ticket's own properties — not a fixed bucket
    And I am NOT required to set a personality, flavor, complexity, or budget first

  Scenario: Understand a ticket in plain language
    When I expand a ticket
    Then the first thing I read is a plain-language sentence, not a number
    And the math (fair value, hit estimate, variance, takeout) is available below it
    And the cost is presented at least as prominently as the payout

  Scenario: Express a single feeling without learning a system
    When I choose how I want to play from one control
    Then the three tickets update to match that mood
    And I never have to reconcile two controls that could contradict each other
```

```gherkin
Feature: Refinement is optional, never a gate
  Scenario: Skip straight to tickets
    Given I have not set any preferences
    Then the Tickets step is reachable without passing through Style or Intuition

  Scenario: Refine only if I want to
    When I choose to refine
    Then I can mark horses I like, dislike, or anchor on
    And I can recover advanced knobs (flavor, complexity) here, not on the default path
    When I go back
    Then my three tickets reflect my refinements
```

```gherkin
Feature: Honest by default (guardrails as behavior)
  Scenario: Takeout is never hidden
    Then a takeout / "house edge" note is reachable within one tap of any ticket

  Scenario: No edge or advice claims
    Then no ticket or copy uses "guaranteed", "lock", "sure thing", or "beat the market"
    And "recreational use, not betting advice" is visible but not intrusive

  Scenario: Cost honesty
    When a refinement pushes a ticket over my stated budget
    Then I see soft friction before the more expensive ticket is treated as default
```

## 6. What this means for the next build

This reorders, it does not rewrite. The engine (`recommender.ts`), the math
(`fairvalue.ts`), and the data lake are untouched. The work is:

1. Invert the default: one-tap tickets on Race; wizard steps become "Refine."
2. Merge personality/flavor/complexity into one "how you play" control; recover
   the two knobs under Refine.
3. Trim the default ticket card to cost + payout + mood; push math into "Why."
4. Encode the Section 5 scenarios as the acceptance tests for the default tier.

Sequencing guardrail: nothing from the deferred list (Decision 5) returns until
the default-tier scenarios are green.
