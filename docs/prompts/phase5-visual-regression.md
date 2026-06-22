# CLI agent prompt — Keibamon Phase 5: App.tsx extraction + full visual regression (ADR-0007)

> Paste the fenced block below into the CLI agent on the **Mac** (mac-dev).
> Closes the last GA-blocking app-tier item: the visual-regression gate that
> proves the app-wide light re-theme (Decision 1) didn't regress any screen.

```
You are implementing Phase 5 of ADR-0007 in the Keibamon repo. Read
docs/adr/0007-my-tickets-social-surface.md and docs/my-tickets-rollout.md first.
Phases 0–4 are merged to main. This phase has NO new product behavior — it makes
the app-wide light re-theme provably non-regressing and pays down the App.tsx
refactor debt that blocks it.

## First
Run `python tools/whichdevice.py`. This is mac-dev work. If not on mac-dev, stop.

## Goal
1) Extract frontend/src/App.tsx (~2.7k lines, all screens as inline functions in
   one component with ~10 useEffects) into per-screen components + extracted hooks,
   with ZERO behavior change. 2) Add full visual-regression coverage across every
   screen in both languages and commit baselines.

## Hard constraints
- Behavior-preserving refactor: no UX, copy, or logic changes. Every existing test
  stays green; the build output is functionally identical.
- DO NOT touch the racing tier (racing D1, /api/live source, tools/jravan,
  ingestion, src/keibamon_core), the social Worker's behavior, or any backend
  contract. This is frontend structure + tests only.
- Bilingual parity preserved. Honesty guardrails (guardrails.test.ts) stay green;
  not-advice Footer + under-20 notice intact.
- No secrets committed.

## Tasks

1. Extract App.tsx (behavior-preserving)
   - Split into one file per screen: My Tickets feed / new / detail, and the four
     legacy screens (race / style / tickets / explain). Lift shared view-model
     helpers and the settlement/drift/countdown logic into hooks/modules
     (e.g. src/screens/*, src/hooks/*). Keep the i18n, recommender, /api/live, and
     localStorage wiring exactly as-is.
   - Do it in small commits; run `npm test` after each so any behavior drift is
     caught immediately.

2. Full visual-regression (Playwright)
   - Add Playwright with snapshot/screenshot tests covering ALL screens in EN and
     JA under the light theme: feed, new, detail (open / won / miss states),
     race, style, tickets, explain. Mock /api/live + Clerk so renders are
     deterministic. Commit baseline screenshots.
   - This is the gate for Decision 1 (app-wide re-theme) — it must actually
     render the four legacy screens and assert no regression, not just the auth
     surface.
   - Wire it into the test scripts (e.g. `npm run test:visual`) and document how to
     update baselines intentionally.

3. (Optional, if quick) KV token-bucket rate limiting
   - Only if low-risk: replace the D1 minute-bucket with a KV token bucket on the
     write paths. If it adds meaningful surface, SKIP and leave the accepted D1
     bucket — note the decision. (Tracked as accepted in the close-out register.)

## Acceptance criteria
- App.tsx is decomposed; all existing frontend tests pass unchanged; `npm run
  build` succeeds; no behavior/copy/logic diff (call it out explicitly).
- Visual-regression baselines committed for every screen × {en, ja}; the suite
  fails on an intentional style break (prove it once) and passes clean otherwise.
- Racing tier untouched (show diff scope). No secrets.

## Workflow
Branch `feat/adr-0007-phase5-visual-regression`. Small commits. When done,
summarize the diff, confirm zero behavior change, and confirm the re-theme
regression gate is now closed. Do not merge — open for review.
```
