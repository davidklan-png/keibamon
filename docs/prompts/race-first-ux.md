# CLI agent prompt — race-first UX: browse → research → build → tweak → place

> Run on the **Mac** (mac-dev). Reworks the companion app's information
> architecture so the entry point is the RACE CARD, not "My Tickets + a lone New
> bet button," and so a beginner gets a dead-simple linear path while an advanced
> punter can branch into depth (horse/jockey/race-history) and fold it back into
> the ticket. Branch: feat/race-first-ux. Commit on the Mac; do NOT deploy — the
> Cowork verifier reviews (and re-drives the live UI in a browser) first.
> Sits on top of the merged form-d1 work; coordinate with feat/ticket-edit
> (revise/tweak) — rebase on main.

```
You are restructuring the Keibamon companion flow. Read CLAUDE.md, app_plan.md
(Core User Loop, Younger-Demographic Fit, Guardrails), frontend/src/App.tsx (the
Step state machine: "mine"|"race"|"style"|"tickets"|"explain"), the screens in
frontend/src/screens/, frontend/src/api.ts (LiveSnapshot/LiveRace/LiveRunner +
fetchLiveSnapshot), frontend/src/lib/recommender.ts, and src/form/* (the live
horse/jockey form service on the Worker). Run python tools/whichdevice.py — MUST
be mac-dev. Keep the guardrails (recreational, not betting advice) everywhere.

## The product vision (David, confirmed)
Two speeds over ONE coherent flow:
  BROWSE races → PICK a race → SEE runners → (simple) build tickets → tweak →
  place;  OR at any point BRANCH into depth (deep-dive a horse/jockey/race
  history), form an opinion, then RETURN to the ticket to reshape it.
Beginner-simple on the surface; advanced-deep on demand (progressive
disclosure). Build for the beginner, provide depth for the advanced punter.

## P1 — Information architecture (the core change)
1. LANDING = a RACE BROWSER, not My Tickets. On sign-in, show "what's on" — the
   day's / weekend's card from /api/live: list each race with grade (G1/G2/G3
   chip), venue, post time, status, and runner count. My Tickets becomes a tab/
   icon, not the forced home. Keep a visible but non-dominant entry to it.
2. REGISTERED RACES MUST BE VISIBLE (this is also a verified bug). Today every
   race in the feed has 0 runners until entries finalize (~Thu 14:00 JST), so the
   builder shows "No live card available" and the weekend G3s (函館記念,
   ラジオNIKKEI賞) are invisible. Per ADR-0006, a registered race should appear —
   grayed, labeled "Entries Thu" / estimated odds when present — NOT collapse to
   "nothing available." Show registered, open (live), and result races with
   distinct states. A user must be able to SEE the weekend's races all week.
3. RACE DETAIL: tap a race → runners with odds (live `win_odds`, else
   `win_odds_est` grayed per `odds_is_live`), market rank, status. Two clear next
   actions from here:
     - SIMPLE: "Build tickets" → light Style (personality/budget, skippable) →
       3 named cards (see P3 diversity) → Why → tweak → Place. Minimal taps; a
       beginner should reach 3 tickets in ≤2 decisions.
     - DEEP: tap a runner → form/context deep-dive (the live /api/.../form data:
       recent finishes, distance/surface/going splits, running style, jockey
       record). From the deep-dive, let the user MARK intuition (like / anchor /
       fade / chaos — reuse IntuitionState) and RETURN to tickets, which reshape
       from those marks. This is the research loop: research ↔ tickets, not a
       dead end.
4. CLOSE THE LOOP: tweaks use the revise flow (coordinate with feat/ticket-edit);
   "Place" commits the ticket (existing POST /tickets). The path browse→build→
   tweak→place must never strand the user on a screen with no forward action
   (the current "New bet" dead-end is the anti-pattern to kill).

## P2 — Verified bugs to fix in this pass
- Form panel no-history copy CONFLATES two cases: "no history for THIS horse"
  (first-timer / unknown / sample) vs "feature coming soon." The service is LIVE
  (e.g. /api/horses/ダノンデサイル/form returns a real 15/5/10 card). Split the
  copy so a shipped feature never reads as unbuilt. "Coming this weekend" should
  appear only if you deliberately gate it, not as the empty state.
- "Start with a sample card" is static text styled like an action but isn't
  clickable; the only control is "Builder." Make the real affordance obvious
  (a labeled "Use a sample card" button) and align the copy.
- Sign-in screen: subtitle and button are both "Continue with email or social"
  (dedupe — make the subtitle a value line); the logo wraps mid-word
  ("ケイバモ/ン") — nowrap / size the badge.
- /app with NO trailing slash served a blank page. Add an /app → /app/ redirect
  in src/worker.js (301/308) so shared links without the slash work. Verify the
  built index.html asset refs still resolve.

## P3 — Polish / product
- Recommender diversity: the default 3 cards skewed 2-of-3 "BALANCED." Ensure the
  set spans the Safe / Balanced / Spicy(longshot) spread app_plan calls for; add
  a recommender test asserting ≥2 distinct risk tiers in the default output.
- Brand presence: the mascot shows in the builder but not on sign-in / landing —
  carry it onto the first screens so the playful positioning lands early.
- (Non-code, for David) Line social login returns a 400 in prod — the Line
  connection needs its own production OAuth credentials in the prod Clerk
  instance (Google works). Note it in the handback; don't try to fix in code.

## Constraints
- Don't touch the racing lake / PIT / recommender MATH / form mart / settlement.
  This is frontend IA + the Worker /app redirect. Keep guardrail copy; label
  estimated odds as estimates; keep "not betting advice" visible.
- Keep all suites green: npm --prefix frontend test, the worker vitest, and
  PYTHONPATH=src ./venv64/bin/python -m pytest -q. Add tests for the race-browser
  states (registered/open/result render) and the research→intuition→tickets loop.
- Commit on the Mac. Build + deploy are David's after sign-off; if you build,
  build and (only when approved) deploy ATOMICALLY (npm run build && wrangler
  deploy) and verify the deployed asset hash + the Clerk origin is
  clerk.keibamon.com.

## Acceptance criteria (user-flow level — the verifier will re-drive these live)
1. Signed-in landing shows the weekend card incl. both G3s with a "registered /
   Entries Thu" state — never "No live card available" when races exist.
2. From a race, a beginner reaches 3 ticket ideas in ≤2 decisions.
3. From a runner, a user opens a real form deep-dive (when history exists),
   marks intuition, returns, and sees the tickets reshape.
4. No screen is a dead-end; every step has a clear forward action.
5. Form empty state distinguishes "no history" from "coming soon."

## Handback to the verifier (Cowork/Claude)
Push feat/race-first-ux and report the test output + a short flow description.
The verifier has live browser access and will re-drive it on keibamon.com after
deploy: confirm the landing shows the registered G3s, the beginner path reaches 3
cards quickly, the research→tickets loop works, the dead-ends are gone, and the
form empty-state copy is fixed. Mark "ready for verification", not "done".
```
