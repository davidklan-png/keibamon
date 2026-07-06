# CLI agent prompt — manual ticket register (interactive builder + edit-in-place)

> Runs on the **Mac** (mac-dev: real network access, wrangler auth, git).
> The Cowork/Claude agent (sandbox) designed this feature, already implemented
> and test-verified the resolver half (bracket_quinella / "gate" bet support,
> both Python and TypeScript sides) directly on this checked-out repo, and did
> the codebase research below. It cannot commit/push from the sandbox (git is
> unreliable there) or run the frontend build (sandbox EPERM on esbuild native
> binaries for anything beyond `vitest`), so this prompt picks up from there.

```
Read CLAUDE.md and docs/adr/0007-my-tickets-social-surface.md before touching
anything. Run `python tools/whichdevice.py` — MUST be mac-dev. If not, stop.

## STEP 0 — Verify + commit the already-completed resolver work

The working tree already has UNCOMMITTED changes (made directly on this
checkout from the sandbox, not via patch/diff) adding bracket_quinella (枠連,
"gate" in the UI) as a 6th resolver-supported bet type:

  - src/keibamon_core/adapters/netkeiba_results.py — extracts `waku` (bracket)
    per finisher from cell[1] of the results table.
  - src/keibamon_core/live/result.py — adds "bracket_quinella" to _BET_TYPES,
    builds a new `gates: [{umaban, waku}]` field on the result block, and
    reformats bracket_quinella's payout combo from netkeiba's concatenated
    digit form ("38") to dash-joined ("3-8") to match every other pool.
  - tests/test_live_result.py — updated + 3 new tests for the gates field.
  - workers/social/src/settle.ts — "bracket_quinella" added to BetType; new
    `RaceResult.gates` field; a `sameMultiset()` comparison (NOT a Set — two
    different horses can share one bracket, so ["3","3"] is a real, distinct
    case from ["3","8"]); a bracket_quinella ticket stays `open` (not a false
    miss) when `gates` is absent; the generic scratch→refund check now skips
    bracket_quinella (its combo is bracket space, not umaban space).
  - workers/social/test/settle.test.ts — new `describe` blocks covering
    lineHits + resolveTicket for bracket_quinella (won/miss/no-gates-stays-open
    /shared-bracket-multiset/scratch-is-a-no-op cases).

Verify before committing:
  - git status / git diff --stat
  - PYTHONPATH=src python -m pytest -q tests/test_live_result.py — 16/16 must
    pass (already confirmed in the sandbox; re-confirm here).
  - PYTHONPATH=src python -m pytest -q — full suite. NOTE: the sandbox could
    not run this cleanly (pyarrow isn't installed there → 26 unrelated
    pre-existing failures, all "lake append failed... pyarrow is required to
    write parquet assets", nothing to do with this change). On the Mac
    (pyarrow installed) this should be fully green — if it ISN'T, stop and
    report what broke before committing.
  - cd workers/social && npm run tsc && npx vitest run — must be green except
    the ONE known pre-existing failure: test/social.test.ts "cheer dedupe"
    (409 instead of 200) — confirmed unrelated to this change, ignore it.
  - cd frontend && npx tsc --noEmit && npm test — should be unaffected by the
    py/ts resolver changes (frontend doesn't import settle.ts's BetType yet
    for bracket_quinella — see Step 2).
Commit this as its own commit (e.g. "feat(resolver): bracket_quinella / gate
bet support") before starting the new work below, so it's bisectable
independent of the manual-ticket-register feature.

## Feature recap (already scoped with David; don't re-litigate)

Manual ticket register: advanced punters can create a ticket from scratch, or
edit an existing OPEN ticket, using a tap-to-build UI similar to the existing
mark cards (FillGuide.tsx render style, but interactive instead of read-only).
  - Bet type picker first (exacta / wide / gate=bracket_quinella / quinella /
    trio / trifecta), then umaban (or bracket, for gate) selection.
  - Once a ticket is assembled: "Update odds" (re-fetch/recompute the
    fair-value estimate), "Register" (create, or overwrite if editing), and
    "Cancel".
  - Entry point: a 4th option on the "New Bet" flow, alongside the existing
    Safer/Balanced/Spicier personality tabs (`frontend/src/screens/
    RefinePanel.tsx`'s `PERSONALITIES` array + tab render around line 17-64 —
    the array holds "safe"/"balanced"/"longshot"; add a 4th tab there that
    routes to the new builder instead of a personality, OR add a sibling
    button next to the tab row if threading a 4th PersonalityId value turns
    out to be invasive — your call, but the 3 existing personality tabs and
    their scoring must NOT change behavior).
  - Edit semantics: edit-in-place — the SAME ticket id, PATCH/overwrite
    semantics, not a duplicate draft. Edit icon in the upper-right of each
    OPEN ticket card in MyTickets.tsx opens the same builder pre-filled with
    that ticket's current type/lines/unit.

## STEP 1 — Backend: allow edit-in-place without a new endpoint

Investigated in the sandbox: `POST /api/social/tickets`
(workers/social/src/index.ts, handler around line 1381-1408 calling
`insertTicket` at line 348) already does
`INSERT ... ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,
state=excluded.state, payout_base=excluded.payout_base, returned=NULL`.
That means POSTing the SAME ticket id with a new payload ALREADY overwrites
it in place — you likely don't need a new PATCH route for editing combo/type/
unit. The existing `PATCH /api/social/tickets/:id` (patchTicket, ~line 472)
stays as-is for settlement (state/returned/placings) — don't conflate the two.

BUT: `insertTicket`'s upsert has no guard today against overwriting an
ALREADY-SETTLED ticket. A client POSTing the same id after settlement would
silently reset state to 'open' and returned to NULL, erasing settlement
history — not acceptable once manual edit exists as a real user action.

Required change: before the upsert, look up any existing row for this id. If
it exists and `state !== 'open'`, reject with 409 (`{error:
"cannot_edit_settled_ticket"}`) instead of overwriting. If it doesn't exist,
or exists with state='open', proceed as today. Add a test in
workers/social/test/social.test.ts (or wherever ticket POST is tested)
covering: (a) editing an open ticket's payload succeeds and overwrites, (b)
POSTing the same id for a settled ticket returns 409 and leaves the row
untouched.

## STEP 2 — Frontend: widen BetType to 6 types

`frontend/src/lib/fairvalue.ts` line 43 defines its OWN `BetType` (5 values —
NOT imported from `workers/social/src/settle.ts`). `frontend/src/lib/
types.ts`'s `Ticket.type` uses this fairvalue.ts BetType. Add
"bracket_quinella" here too. Check `RET` (line 35, a `Record<BetType,
number>`) and any other exhaustive switches/records keyed by BetType in
fairvalue.ts and recommender.ts — the compiler will point them out once the
union is widened (`npx tsc --noEmit` will fail loudly on missing cases; fix
each). Note `recommender.ts` already has a `bracketQuinellaAgg()` (~line
683) that aggregates a DISPLAY-only 枠連 estimate over `Runner.gate` for the
existing recommender views (SetFamilyView) — that's a different code path
(estimate over auto-picked combos) from the new manual builder (user picks
brackets directly); don't merge them, but DO reuse `Runner.gate` (already
present on every runner in the live snapshot — confirmed, no live-feed change
needed) as the bracket source for the new builder's gate-bet UI.

Per `frontend/src/lib/settle.test.ts`'s own header comment ("these fixtures
are a verbatim port... if you add a case here, add it on the frontend side
too — they MUST agree"), port the new bracket_quinella `describe` blocks from
`workers/social/test/settle.test.ts` into `frontend/src/lib/settle.test.ts`
now that BetType supports it there too.

## STEP 3 — Frontend: interactive manual ticket builder component

New component (e.g. `frontend/src/screens/ManualTicketBuilder.tsx`). Look at
`FillGuide.tsx` for the established visual language (number grid for
box-style bets, position columns with arrows for ordered/formation bets) —
mirror that grid/column layout but make it TAPPABLE instead of read-only.
For bracket_quinella specifically, render a BRACKET grid (1-8, JRA's actual
color convention if one already exists in styles.css — check for bracket
color classes before inventing new ones) sourced from each runner's `.gate`,
not a horse-number grid.

Flow: bet-type picker → combo/position picker (exact selection for
quinella/wide/trio, or 1st/2nd/3rd position columns for exacta/trifecta,
matching how TicketStudio's existing Set/Formation/Wheel views already
distinguish ordered vs. unordered types — reuse that distinction, don't
reinvent it) → live fair-value preview via the existing `fairvalue.ts`
helpers → three actions:
  - "Update odds" — recompute the preview (reuse whatever odds-refresh path
    the recommender views already call; don't add a new one if one exists).
  - "Register" — POST to `/api/social/tickets` (new ticket: fresh id/serial;
    edit: reuse the existing id, relying on Step 1's overwrite semantics).
  - "Cancel" — discard, no network call.

## STEP 4 — Wire the entry point + edit icon

  - 4th option on the "New Bet" flow per the recap above.
  - Edit icon (upper-right) on each OPEN ticket card in
    `frontend/src/screens/MyTickets.tsx` — opens ManualTicketBuilder
    pre-filled from that ticket's current `type`/`lines`/`unit`. Must NOT
    appear on settled (non-open) tickets — Step 1's backend guard is the
    server-side backstop, but don't rely on it alone; the button shouldn't
    even be offered for a settled ticket.

## STEP 5 — i18n, CSS, full verification

  - Add every new user-facing string to BOTH `frontend/src/i18n/en.ts` and
    `ja.ts` (this codebase has a guardrail test —
    `frontend/src/i18n/guardrails.test.ts` — that fails on missing keys in
    either locale; run it explicitly).
  - CSS in `frontend/src/styles.css`, following existing naming conventions
    (check prefixes like `.mt-*`, `.fill-*`, `.persona` before inventing new
    ones).
  - Full verification pass, must ALL be green (module the one known
    pre-existing `social.test.ts` cheer-dedupe failure):
      PYTHONPATH=src python -m pytest -q
      cd workers/social && npm run tsc && npx vitest run
      cd frontend && npx tsc --noEmit && npm test && npm run build
  - Commit in logical chunks (backend guard / BetType widening / builder
    component / wiring+i18n) rather than one giant commit — this repo's
    convention per CLAUDE.md's device-topology doc is commit-on-Mac,
    sign-off-and-push-on-Mac; David reviews the commit list, so keep them
    legible.

## Constraints
- Don't touch the racing lake / PIT rules / recommender scoring math.
- Don't change the 3 existing personality tabs' behavior while adding the
  4th option.
- Never print secrets (CF_API_TOKEN, Clerk keys, etc.) in logs.
- If anything in Steps 2-4 turns out more invasive than described here (e.g.
  BetType is used in more exhaustive switches than found in this pass, or
  the "4th tab" wiring conflicts with PersonalityId elsewhere), STOP and
  report the specific conflict rather than working around it silently —
  these are judgment calls David/the verifier should see, not silently
  absorbed scope creep.

## Handback to the verifier (Cowork/Claude, sandbox)
Report:
  - Step 0's verification output + the commit hash for the resolver work.
  - The 409-on-settled-ticket guard: the exact diff, and the new test's
    pass/fail output.
  - Confirmation BetType widening compiled clean, and which files needed
    exhaustiveness fixes.
  - Screenshots or a written walkthrough of the builder flow (bet type →
    combo → register) for at least: quinella (unordered, umaban-based) and
    bracket_quinella (unordered, bracket-based) — the two flows that
    exercise the most new logic.
  - The edit-in-place walkthrough: open an existing OPEN ticket, change a
    combo, Register, confirm same id / same serial in the ticket list.
  - Attempt (and expected failure) to edit a SETTLED ticket, showing the
    409 and that the UI doesn't even offer the edit icon there.
  - Full verification suite output (Step 5), called out failures vs. the one
    known pre-existing exception.
  - Commit list (hashes + one-line summaries) for this feature, separate
    from Step 0's resolver commit.
Do NOT mark this done unless the full verification pass is green (modulo the
documented pre-existing failure) and both walkthroughs above are shown, not
just asserted.
```
