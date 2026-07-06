# CLI agent prompt — #12 + #13: distrust glyph + impressionsSync stale closure

> Runs on the **Mac** (mac-dev). Prepared by the Cowork/Claude agent (sandbox)
> 2026-07-06; paths verified that day. Two small fixes, one session, one
> commit each. Glyph choice was decided with David — **▽** — don't
> re-litigate (消 and a full ◎○▲△✓× ladder re-map were considered and
> rejected).

```
Read CLAUDE.md first. Run `python tools/whichdevice.py` — MUST be mac-dev.

## PART A — #12: distrust mark reads as mildly positive in JA convention

MARK_GLYPH in frontend/src/screens/RunnerMark.tsx (~line 47-53) maps
distrust → "△". In JA 予想印 convention △ is the 4th pick — mildly
POSITIVE — so a JA user reads the app's negative "distrust" mark as a
recommendation. Decided fix: distrust → "▽" (inverted triangle: visually
anti-△, unambiguous, script-neutral).

  - The stored value is the kind string ("distrust"), not the glyph — server
    rows, localStorage, and merge logic are all untouched. Display-only.
  - RunnerMark.tsx IS the single glyph source: a repo grep for "△" finds
    only line 51, and MARK_GLYPH's consumers (TicketsScreen.tsx + RunnerMark
    itself) import the table — so the one-line change propagates. Still
    re-verify with a grep, including splash/ and the share-card path in case
    anything hard-codes a glyph.
  - TRAP: HorseDrillView.tsx ~line 478 uses ▲/▼ as odds-DRIFT arrows
    (shorter/longer), not prediction marks — visually adjacent to your new
    ▽. Do NOT touch them, but confirm in the handback that a ▽ distrust
    badge next to a ▼ drift arrow is visually distinguishable (weight/color
    class differ); if it isn't, report rather than restyling unilaterally.
  - i18n labels (form.intuition.distrust: "Distrust" / "信頼できない") are
    correct and unchanged — glyphs deliberately carry no i18n (see the
    header comment in RunnerMark.tsx).
  - Any visual baselines showing a distrust mark need regenerating; if no
    current baseline exercises a distrust mark, say so in the handback
    (that's a mini #14-style gap worth a one-line follow-up issue).

## PART B — #13: stale closure in impressionsSync.ts sign-in merge

frontend/src/auth/impressionsSync.ts, sign-in effect (~line 259-275): the
setImpressions call correctly uses the FUNCTIONAL updater to merge against
the latest state, but the follow-up PUT then recomputes the merge from the
effect closure's `impressions` (line ~273, `mergeImpressions(impressions,
got.data)`) — a stale snapshot from the render that mounted the effect. A
mark made between effect-mount and GET-resolution is missing from that PUT.
Self-heals ~2s later via the debounced steady-state PUT (which is why this
is low priority), but the window exists and the code contradicts its own
comment.

Fix so the PUT body reflects the actual post-merge state. Two acceptable
shapes — your call:
  - keep a ref mirroring the latest impressions (updated by the steady-state
    effect or a tiny dedicated effect) and merge from ref.current; or
  - capture the updater's output in an outer variable. If you go this way,
    mind React 18 StrictMode double-invoking updaters — the updater must
    stay pure (mergeImpressions is), and don't PUT from inside it.

Extend frontend/src/auth/impressionsSync.test.ts with a test that pins the
bug: local write lands AFTER the sign-in effect runs but BEFORE the GET
resolves → the merge-PUT body must include that write. Confirm the test
FAILS on the old code before the fix (state that explicitly in the handback).

## Verification
  cd frontend && npx tsc --noEmit && npm test
  npm run test:visual   (only if Part A touched baselines)
  Two commits: "fix(marks): distrust glyph △→▽ (fixes #12)" and
  "fix(auth): impressionsSync merge-PUT stale closure (fixes #13)".

## Constraints
- Part A: glyph only. No vocabulary, ordering, label, or store changes.
- Part B: don't restructure the hook or reopen ADR-0018 semantics (LWW,
  union-at-merge edge, debounce window all stay).

## Handback to the verifier (Cowork/Claude, sandbox)
Report: both diffs, the grep proof that all glyph render sites were found,
the failing-then-passing test output for Part B, full frontend suite output,
commit hashes.
```
