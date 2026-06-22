# R1 — Result feed scoping brief (racing tier)

**For:** the racing-tier owner (mac-dev / ingestion).
**Why now:** the My Tickets app (ADR-0007, Phases 0–4) is built and in review, but
**settlement is inert in production** — no ticket ever resolves win/miss because
the `/api/live` producer never emits a `result` block. R1 closes that gap. It is
the single critical-path item for the feature's payoff (result → cheer → share)
and it lives entirely in the racing tier, so it can run in parallel with app
review. Companion: `docs/adr/0007-my-tickets-social-surface.md` (Phase 2
follow-up #1), `docs/my-tickets-rollout.md`.

## Goal

Make `/api/live` carry, for each finished race, a `result` block with finishing
order, scratches, and payouts — so the app's settlement resolver
(`frontend/src/lib/settle.ts` and the shared `workers/social` copy) can resolve
quinella / wide / exacta / trio / trifecta tickets. No app-tier change is needed:
the consumer contract already exists.

## The consumer contract is authoritative

Before designing anything, read what already consumes this:

- `frontend/src/api.ts` — the `RaceResult` type already declared on `LiveRace`
  (added in Phase 2). **Produce exactly what this type expects.**
- `frontend/src/lib/settle.ts` + its tests, and `workers/social/src/settle.ts`
  + tests — the resolver and its **dead-heat / scratch fixtures**. Those fixtures
  are the golden contract: your producer output, fed through them, must yield the
  expected settlement.
- `netkeiba_payouts.py` — the existing payout-combo canonicalization. Reuse it;
  do not invent a second combo-key scheme.

If your output satisfies those types + fixtures, R1 is done. The schema below is
the strawman they were written against — reconcile any drift toward the code.

## Result block — strawman shape

On each `LiveRace` whose race has finished, with `status: "result"`:

```jsonc
"result": {
  "status": "official",          // "official" | "provisional" — settle ONLY on official
  "placings": [                  // final placings; dead heats SHARE a rank
    { "rank": 1, "umaban": 5 },
    { "rank": 2, "umaban": 8 },
    { "rank": 2, "umaban": 3 },  // 同着 example
    { "rank": 4, "umaban": 1 }
  ],
  "scratches": [11, 4],          // 出走取消 / 返還 — umaban refunded
  "payouts": {                   // yen is PER ¥100 (JRA convention)
    "win":      [{ "combo": [5],     "yen": 340  }],
    "place":    [{ "combo": [5],     "yen": 150 }, { "combo": [8], "yen": 210 }],
    "quinella": [{ "combo": [5,8],   "yen": 1840 }],     // unordered → ascending
    "wide":     [{ "combo": [5,8],   "yen": 620 }, { "combo": [5,3], "yen": 980 }],
    "exacta":   [{ "combo": [5,8],   "yen": 3120 }],     // ordered → preserve
    "trio":     [{ "combo": [3,5,8], "yen": 8900 }],     // unordered → ascending
    "trifecta": [{ "combo": [5,8,3], "yen": 41200 }]     // ordered → preserve
  },
  "available_at": "2026-06-28T06:12:00Z"   // PIT marker; post-race
}
```

Key rules the resolver depends on:
- **Key runners by `umaban`, never `horse_id`** (DATA_TRAPS: `horse_id='0000000000'`
  is non-unique; join on `(race_id, horse_number)`).
- **Dead heats produce multiple rows** in the same pool and multiple horses at a
  rank — the resolver derives the placing *set* from `placings`, so emit ties
  faithfully or legitimate hits mis-settle as MISS.
- **Scratches** must appear in `scratches` so a line containing one routes to a
  refund, not an auto-MISS.
- **`yen` is per ¥100**; the app computes `yen * unit / 100`.
- **Only emit `status:"official"`** for settlement. If a race is provisional or
  under 審議 (inquiry) / 降着 (demotion) pending, hold or mark provisional — the
  app will keep showing the commit-time estimate until official.

## Where it wires (racing tier)

1. **Result + payout parser** (netkeiba results page — consistent with the
   Mac-only scrape direction of ADR-0004; avoid reviving JV-Link / capture-pc
   unless you prefer the official feed). Reuse / extend `netkeiba_payouts.py`.
2. **`keibamon_core.live.snapshot.build_live_snapshot`** — stop passing
   `raw.get('result')` through as `None` (`snapshot.py:87`); populate it from the
   parsed result for finished races; set `status:"result"`.
3. **`tools/jravan/expose_live.py`** — during the result window, fetch results
   for finished races on the card and include them; publish under `key='current'`
   as today (no D1 schema change — same `(key, payload, published_at)` row).
4. Keep the pure assembler unit-tested offline, as `build_live_snapshot` already is.

## Correctness / edge cases to handle

Dead heats (同着, multiple payout rows + shared rank) · scratches & refunds
(出走取消 / 返還) · disqualification / demotion (降着 — consume FINAL placings only)
· inquiry pending (審議 → provisional, don't settle) · abandoned race · name↔umaban
mismatches. Point-in-time: results are post-race — never let a `result` leak into
a pre-race snapshot, and stamp `available_at` so nothing pre-race ever reads it.

## Acceptance criteria

- A real finished race's `/api/live` entry carries a populated `result` block in
  the shape above, `status:"result"`.
- Feeding that payload through `settle.ts` / `workers/social settle.ts` resolves
  each bet type correctly, **including a dead-heat race and a scratch race** —
  reuse the Phase 4 fixtures as the cross-tier golden test.
- Combo keys match `netkeiba_payouts.py`; runners keyed by umaban.
- `PYTHONPATH=src python -m pytest -q` stays green; any new netkeiba result quirk
  is added to `DATA_TRAPS`.
- App tier, racing D1 schema, and the recommender/backtest are untouched.

## Workflow & boundaries (CLAUDE.md)

Run `python tools/whichdevice.py` first — this is **mac-dev** work (the scrape +
lake live there; the Cowork sandbox cannot commit). Branch
`feat/adr-0007-r1-result-feed`. Commit on the Mac. Out of scope: the app side
(done), historical backfill of past results, and any change to the
recommender/backtest. When done, hand back: the result payload sample, the
golden-fixture run against `settle.ts`, and the publish cadence for the result
window.

---

### Optional: paste-to-CLI form

```
Implement R1 (ADR-0007 Phase 2 follow-up #1): make /api/live emit a per-race
`result` block (finishing order incl. dead heats, scratches, per-¥100 payouts by
pool, official-only) so the app's settlement resolver can settle tickets. Read
docs/r1-result-feed-brief.md, CLAUDE.md, frontend/src/api.ts (RaceResult),
frontend/src/lib/settle.ts + workers/social/src/settle.ts (and their dead-heat /
scratch fixtures — your output must satisfy them), and netkeiba_payouts.py (reuse
its combo canonicalization). Run python tools/whichdevice.py first; this is
mac-dev work. Wire: a netkeiba result+payout parser → populate result in
keibamon_core.live.snapshot.build_live_snapshot (replace the snapshot.py:87
pass-through) → emit it from tools/jravan/expose_live.py during the result window,
published under key='current'. Key runners by umaban (DATA_TRAPS), settle only on
official, stamp available_at, keep PYTHONPATH=src pytest green, add DATA_TRAPS
entries for new quirks. Do NOT touch the app tier or the recommender/backtest.
Branch feat/adr-0007-r1-result-feed; commit on the Mac; open for review.
```
