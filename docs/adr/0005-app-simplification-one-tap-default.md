# ADR-0005: Simplify the app — one-tap tickets as the default, wizard as refinement

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** David Klan
- **Amends:** the wizard-first "Immediate Next Build" framing in `app_plan.md`
  (the five-step Race→Style→Intuition→Tickets→Why flow is retained, but demoted
  from the spine to optional refinement).

## Context

User feedback: the app is *too complicated*. A first-principles BDD pass
(`docs/app-simplification-bdd.md`) found the cause is not the number of screens
but the number of **concepts** a casual fan must absorb before getting the one
thing they came for — a ticket they can place and explain. To complete a single
pass the user meets ~11 quantitative/jargon concepts (unit stake, complexity
mode, runner flavor, win-probability %, fair-value multiplier, hit-estimate %,
average payout, variance, takeout, value/chalk tag, Henery note).

Three structural findings, each grounded in the current code:

- **Redundant controls.** Personality, flavor, and complexity are three knobs for
  one choice — `lib/recommender.ts` already derives bet types from
  `(personality, complexity)` and reuses `flavor` in scoring. The 5×3×4 surface is
  both heavy and internally contradictable.
- **The simple path already exists but is buried.** The Race screen already has a
  "Standard tickets · 3 picks" CTA (`standardTickets()` → `onStandard`) with the
  hint "Style and intuition are optional refinements." The UI just frames the
  five-step wizard as the spine and the simple path as a side door.
- **Math leaks onto the primary surface.** Fair value, hit %, variance, takeout,
  and the Henery note render by default — the "trading-screen aesthetic"
  `app_plan.md` explicitly says to avoid.

Anchored on **one user**: the casual younger fan who wants to turn a hunch into a
fun ticket, not a pro bettor running a terminal.

## Decision

The app's single job is: **turn a feeling about a race into one ticket the user
understands and can place — in under a minute, with no jargon required.** Every
other feature is a *refinement* that must earn its place against that job.

1. **One-tap tickets become the default.** The user lands on Race and a single
   primary action produces Safe / Balanced / Spicy tickets immediately. Style and
   Intuition are reframed as an optional "Refine," never a gate.
2. **Collapse personality × flavor × complexity into one control** — "How do you
   want to play?" (the 5 personalities). Flavor and complexity are *derived* from
   personality on the default path; the raw knobs survive under an Advanced
   disclosure inside Refine.
3. **Demote the math to progressive disclosure.** The default ticket card shows
   only cost, what-you-win-if-it-hits, and a plain mood label. Fair value, hit %,
   variance, and the takeout reminder move into the "Why" expand — never hidden,
   one tap away.
4. **Tier the depth.** One ladder: one-tap → Refine → Why → paid live/lookup.
   Nothing is deleted; everything is sequenced.
5. **Defer everything off the one-minute path** (advanced ticket modes, saved
   profiles, alerts, jockey/trainer lookup — `app_plan.md` Milestones 3–4) until
   the default tier passes its BDD scenarios.

The behavioral contract is the Gherkin in `docs/app-simplification-bdd.md` §5;
the phased build is `docs/app-simplification-plan.md`.

## Consequences

**Positive.** Directly addresses the "too dense" feedback. The casual happy path
becomes one tap. The redundant-knob contradiction class is eliminated. The
monetization spine is now structural: the paywall sells live convenience/context
on top of an already-complete free path, exactly the `app_plan.md` positioning.
Low blast radius — the change is navigation, hierarchy, and exposure, not logic.

**Costs (accepted, eyes open).**
- **Power users lose two default knobs.** Flavor and complexity move behind
  Advanced. Mitigated by keeping them, not deleting them.
- **A derived personality→{flavor,complexity} mapping becomes a product
  decision.** It determines what each personality actually generates; it must be
  reviewed and snapshot-tested rather than left implicit.
- **Amends `app_plan.md`.** The wizard-first "Immediate Next Build" is no longer
  the spine. The five screens remain, reordered.

**Engine/data untouched.** `lib/recommender.ts`, `lib/fairvalue.ts`, the backend,
and the lake are out of scope. This ADR is a frontend reorder only.

## Alternatives considered

- **Keep the wizard, trim copy only.** Rejected — leaves the concept load and the
  redundant knobs intact; treats symptom, not cause.
- **Delete advanced features outright.** Rejected — throws away the hobbyist/paid
  depth that is the monetization path. Tiering preserves it behind disclosure.

Related: `app_plan.md`, `docs/app-simplification-bdd.md`,
`docs/app-simplification-plan.md`.

## Status — implementation progress

Phased per `docs/app-simplification-plan.md`. Sandbox does edits + tests; commits
land on the Mac (`git` is unreliable in the Cowork sandbox per CLAUDE.md).

- [x] Phase 0 — BDD contract encoded as tests (`src/lib/defaultTier.test.ts` —
      no-precondition one-tap contract + mood label; mapping coverage).
- [x] Phase 1 — Default inverted to one-tap; Style reaches tickets directly,
      intuition demoted to a secondary "+ Intuition".
- [x] Phase 2 — personality/flavor/complexity collapsed to one control;
      `PERSONALITY_PRESET` + `applyPersonality` derive the knobs; raw knobs kept
      behind an Advanced `<details>`.
- [x] Phase 3 — Ticket card trimmed to cost + "if it hits" + one mood label;
      hit %, variance, value tag, house-edge line moved into "Why"; plain
      sentence now leads the explain screen.
- [x] Phase 4 — Honesty guardrails encoded (`src/i18n/guardrails.test.ts` —
      banned-language + takeout reachability); no deferred features on the
      default path.
- [x] All 23 frontend tests pass; `tsc -b` clean; vite bundle builds.

**Commit + production build run on the Mac** (the Cowork sandbox can't `git`
commit or unlink `../splash/app` for `npm run build` — both are known sandbox
limits in CLAUDE.md). The sandbox validated tests + a bundle build to a temp dir.
