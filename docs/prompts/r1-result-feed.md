# CLI agent prompt — R1: drive /api/live to emit `result` (ADR-0007)

> Dev agent runs this on the **Mac** (mac-dev / racing tier). A separate
> verification layer (Claude in Cowork) checks the output against the resolver
> contract and runs the suites. This prompt is pinned to the REAL consumer
> contract in `workers/social/src/settle.ts` — it SUPERSEDES the strawman shape
> in `docs/r1-result-feed-brief.md` (that brief predates the merged resolver and
> has the wrong field names).

```
You are implementing R1 (ADR-0007 Phase 2 follow-up #1): make the /api/live
producer emit a per-race `result` block so the app's settlement resolver can
settle committed tickets. The app side (resolver, sweep, UI) is DONE and merged;
this is racing-tier wiring only. Run `python tools/whichdevice.py` first — this
is mac-dev work. Read CLAUDE.md (point-in-time rules, DATA_TRAPS) before editing.

## The contract is FIXED by the consumer — match it exactly
The resolver is `workers/social/src/settle.ts` (frontend imports it via
`frontend/src/lib/settle.ts`). Read its `RaceResult` type. Your producer must
emit exactly that shape on each race when `status === 'result'`:

  result = {
    // Finishing order. Prefer `placings` — it expresses 同着 (dead heats):
    "placings": [
      { "pos": 1, "umabans": [5] },
      { "pos": 2, "umabans": [16, 7] },   // dead heat at 2nd
      { "pos": 3, "umabans": [1] }
    ],
    // (or the simpler ordered form, ties impossible: "finishers": [5,16,1])
    "scratched": [11, 4],                  // umabans refunded (返還); optional
    "payouts": [                           // omit → resolver uses commit-time estimate
      { "pool": "quinella", "combo": "5-16",   "yen": 1840 },
      { "pool": "wide",     "combo": "5-16",   "yen": 620 },
      { "pool": "exacta",   "combo": "5-16",   "yen": 3120 },
      { "pool": "trio",     "combo": "1-5-16", "yen": 8900 },
      { "pool": "trifecta", "combo": "5-16-1", "yen": 41200 }
    ]
  }

HARD shape rules (the resolver depends on every one):
- `pool` MUST be exactly one of: quinella | wide | exacta | trio | trifecta
  (map netkeiba's 馬連/ワイド/馬単/3連複/3連単 to these strings). The resolver
  ignores win/place — including them is harmless, omitting them is fine.
- `combo` is a dash-joined umaban string: ASCENDING for unordered pools
  (quinella/wide/trio), FINISH ORDER for exacta/trifecta. Matches
  `netkeiba_payouts.py` canonicalization.
- `yen` is per ¥100 stake (JRA convention). The app computes yen*unit/100.
- Key everything by `umaban`, NEVER `horse_id` (DATA_TRAPS: horse_id
  '0000000000' is non-unique).
- Dead heat → multiple umabans at a `pos` AND multiple payout rows in that pool.
- Only attach `result` on OFFICIAL results. While provisional / under 審議 /
  降着 pending, do NOT attach it — the app keeps showing the estimate and never
  false-settles.

## Touchpoints (wiring, not new parsing)
- `src/keibamon_core/adapters/netkeiba_payouts.py` — ALREADY parses payout cells
  (`build_payouts`, `parse_payouts_payload`, `_extract_combos`, `_extract_payouts`).
  Reuse it; adapt its output into the `payouts: {pool, combo, yen}` rows above
  with `pool` mapped to the BetType strings.
- Finishing order: locate or add a netkeiba 着順 (result table) parser to build
  `placings` with dead-heat sets, keyed by umaban.
- `src/keibamon_core/live/snapshot.py` (~line 71/87) — ALREADY passes
  `raw.get("result")` through into the snapshot. No change needed unless you
  reshape; if you touch it, keep `build_live_snapshot` pure + offline-tested.
- `tools/jravan/expose_live.py` — during the result window, for finished races,
  populate `raw["result"]` with the shape above before publishing under
  `key='current'`. No D1 schema change.

## Point-in-time / correctness
- A `result` may only appear once the race is finished/official. Never let it
  leak into a pre-race snapshot. Stamp result provenance with an `available_at`
  so nothing pre-race ever reads it (honor the lake's PIT contract).
- Add any new netkeiba result-page quirk to `adapters/jravan.DATA_TRAPS`.

## Provide for the verification layer (REQUIRED)
1. A committed fixture: a real (or realistic) `result` payload for one finished
   race in the exact shape above — INCLUDING one dead-heat case and one scratch
   case (can be separate fixtures).
2. A short note mapping each netkeiba pool label → BetType string.
3. The producer output for a sample card so the verifier can feed it through
   `resolveTicket` for all five bet types.

## Constraints
- Racing tier only. Do NOT modify `workers/social/src/settle.ts`,
  `frontend/`, or any app code. Do NOT change the resolver's rules — match them.
- Keep `PYTHONPATH=src python -m pytest -q` green; add tests for the new parser
  (clean race, dead heat, scratch) and the pool mapping.
- Never commit secrets.

## Workflow
Branch `feat/adr-0007-r1-result-feed`. Small commits, commit on the Mac. When
done, hand back: the diff scope, the fixtures, the pool→BetType mapping, and a
sample producer `result` for a finished card. Do NOT merge — it goes to the
verification layer first.
```
