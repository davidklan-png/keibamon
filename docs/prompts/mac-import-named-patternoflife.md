# CLI agent prompt — mac-dev: import USB, name the pattern-of-life, log exotic-curve gap

> Goal: land this weekend's PC JV-Link pull, resolve jockey/trainer ids→names,
> emit the NAMED pattern-of-life. Counterpart to
> docs/prompts/jvlink-master-named-patternoflife.md (STEP 1+). Commit on the Mac.

## STEP 0 — Device + import (mac-dev only)
`python tools/whichdevice.py` → must be mac-dev (owns git + lake). Dock USB,
import both shapes:
- 蓄積 masters/odds/votes:
  `python tools/jravan/import_delta.py --from /Volumes/<usb>/keibamon-xfer`
  (canonical lake = repo ./data; do NOT set KEIBAMON_LAKE on Mac -- caused a bronze/silver split 2026-07-02)
- realtime curves:
  `... python tools/jravan/import_realtime.py --from /Volumes/<usb>/keibamon-xfer --dry-run`, then for real.
Verify sha + print per-spec row counts. STOP if KS or CH is absent — don't
fabricate a master.

## STEP 1 — Silver masters (the names task; REQUIRED)
KS 騎手マスタ / CH 調教師マスタ → data/normalized/jockey_master (jockey_id, name,
name_kana) + trainer_master. Parse on BYTES not chars (cp932). Idempotent,
content-hashed. DATA_TRAP: jockey_id='00000' (sibling of horse '0000000000') =
non-unique placeholder → label "(unknown/placeholder)", never a real name; add to
adapters/jravan.DATA_TRAPS. (UM/BN/BR, H1 votes, O1–O6 蓄積, JG stay bronze this
pass — parse later. Only KS/CH needed below.)

## STEP 2 — Named pattern-of-life
Re-run the anomaly pattern-of-life (trainer/jockey flag-rate + won/flop split over
strong plunges), LEFT JOIN masters so output is named. Keep volume-norm, z-score,
won-vs-flop split. Emit a ranked artifact (parquet/md): named connections by
plunge-flag z with flagged win%/flop%.

## STEP 3 — Honest framing (verbatim)
Carry the report caveats unchanged: over-representation ≠ misconduct; high flop
rate is what *popular* connections produce honestly; multiple-testing; flag, not
verdict. "Worth-a-look," not accusation.

## STEP 4 — Exotic-curve silver ticket (NOT blocking; do NOT capture)
CORRECTION to PC-prompt Tier 3: O3–O6 are ALREADY in bronze via 0B30 (verified
3984/pool, 2026-06-21; adapter byte-parses all six). The gap is downstream —
ingestion/jravan_silver.py filters the timeseries to ("O1","O2"). So exotic curves
are NOT forward-only and NOT at risk. File a SEPARATE ticket (not in the names
commit): un-filter O3–O6, runnable on existing bronze incl. 06-21 backfill. GATE
on cardinality (O6 ≈ 4,900 combos/race × ~250 snaps × 36 races): pick scope —
full curve vs T-30-only vs liquidity floor — before materializing.

## Constraints
Don't touch PIT rules / recommender / form mart / settlement. Judge new odds
signals vs market baseline net of takeout. Keep suite green
(`PYTHONPATH=src python -m pytest -q`). Commit on the Mac.

## Handback to verifier (Cowork/Claude)
Report: import path + per-spec row counts, jockey_master/trainer_master row
counts, top ~10 NAMED connections with stats. Mark "ready for verification," not
"done." Verifier spot-checks a known id (top graded-winner jockey_id → marquee
rider e.g. 武豊/Ｃ.ルメール) and confirms '00000' is labelled.
