# My Tickets (ADR-0007) — delivery plan

One-page rollout sequence for the "commit → live → result → cheer → share"
feature. Companion to `docs/adr/0007-my-tickets-social-surface.md` and the
phase prompts in `docs/prompts/`. Status as of 2026-06-21.

## Sequence & status

| # | Branch / change | Delivers | Depends on | Status |
|---|-----------------|----------|------------|--------|
| P0 | (Phase 0, frontend) | My Tickets UI on real `recommend()` + `/api/live`, localStorage stand-in, light re-theme | — | ✅ Complete · verified (23/23 tests, clean build) |
| P1 | `feat/adr-0007-phase1-clerk` | Clerk identity, sign-in gate, `users` table, 20+ self-attest | P0 | ✅ Merged |
| P2 | `feat/adr-0007-phase2-persistence` | Server-side tickets, localStorage→cache, client settlement + resolver | P1 | ✅ Merged |
| P3 | `feat/adr-0007-phase3-social` | Follows, cross-user cheers, public profiles, real counts, share-image export | P2 | ✅ Merged |
| P4 | `feat/adr-0007-phase4-hardening` | Settle sweep, dead-heat/scratch resolver, rate limits, block/report, self-host fonts, snapshot baselines | P2 + P3 | ✅ Complete · in review (worker 117/117, frontend 105/105; scope diff = frontend/ + workers/ + docs/ only) |
| P5 | (backlog) | App.tsx extraction + full visual-regression, KV token-bucket rate limits, server-side card renderer | P4 | ⚪ Backlog — see below |
| R1 | racing-tier PR (separate) | `/api/live` producer emits `result` with finishing order, ties, scratches | — (racing tier) | ⚪ Not started — **critical path for settlement value** |

## Critical path

R1 is the gating dependency, not P3/P4. Until the producer emits results,
**no ticket settles in production** and the result→cheer→share payoff never
fires for real users — the resolver, sweep, and animations are all built but
inert. R1 is a racing-tier change (different device per CLAUDE.md, separate
branch/PR) and is independent of the app code, so it can and should run in
parallel — but it must land before settlement goes GA.

```
P0 ─► P1 ─► P2 ─► P3 ─► P4 ──────────────► (app feature complete)
                                   │
R1 (racing tier, parallel) ────────┴──────► settlement GA gate
```

## Phase 5 backlog (deferred from P4, documented in the runbook)

These were conscious, documented scope reductions in P4 — not gaps to hide:

1. **App.tsx component extraction.** The 8 screens render as inline functions
   inside a single ~2.7k-line component with ~10 `useEffect`s. Extraction is the
   blocker for #2 and is itself the largest standing refactor.
2. **Full visual-regression.** P4 shipped **4 HTML snapshot baselines (auth
   surface only)**, not the ~16 needed to cover all 8 app screens × 2 languages +
   the 4 legacy screens. Playwright + CSS-pixel regression is the real gate that
   the app-wide light re-theme (Decision 1) didn't regress existing screens — it
   is **only partially closed** until this lands (depends on #1).
3. **KV token-bucket rate limiting.** P4 extended the D1 minute-bucket to
   block/report; a KV token bucket is the more robust upgrade.
4. **Server-side card renderer.** Deferred — no cross-platform inconsistency data
   yet justifies it. Revisit if client `html-to-image` output proves uneven.

## GA gate — what must be true to turn settlement on for real users

1. **R1 merged** — `/api/live` carries finishing order + payouts + ties +
   scratches. ⚠️ **Not started — the one open blocker.**
2. P2 merged: tickets persist; client resolver + auto-settle effect live. ✅
3. P4 dead-heat/scratch fixtures green; server-side settle sweep deployed
   (offline-at-post users settle on reconnect). ✅ (against fixtures; exercises
   real data only once R1 lands)
4. Visual-regression closed across all screens × both languages. ⚠️ **Partial** —
   P4 shipped 4 auth-surface baselines; full coverage is Phase 5 (#1–#2). The
   re-theme regression gate is not fully closed.

Until 1 and 4 hold, ship the rest behind the honest "shows commit-time estimate,
stays open" behavior already implemented — no false settlements.

> Full disposition of every open item: `docs/adr/0007-open-items-closeout.md`.
> Net: C/D/E/F/G/H closed; only **A (R1)** and **B (Phase 5 visual regression)**
> remain — both fully specified, each one agent-run from closed.

## Where things stand & next moves

- **App feature work P0–P4 is done and in review.** The build is functionally
  complete behind the honest no-settlement fallback.
- **R1 is now the single critical-path item** and hasn't started. Settlement —
  the result→cheer→share payoff, the reason the feature exists — stays inert in
  prod until the racing-tier producer emits results. Start scoping it with the
  racing-tier owner now; it has the longest lead time and is a different device.
- **Before GA**, close the visual-regression gate (Phase 5 #1–#2) so the
  app-wide re-theme is provably non-regressing on the legacy screens.
- Merge order P2 → P3 → P4 held; remaining merges are review-and-land.
