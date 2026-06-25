# CLI agent prompt — form-lookup fix #1 (verifier rejection)

> Branch feat/weekend-form-lookup @ 644eb00 was reviewed by the Cowork verifier
> and REJECTED for one blocking defect. Everything else passed (PIT exclusion
> correct, horse_id never keyed, guardrails tested, jockey passthrough good,
> suites green). Fix this, push, hand back to the verifier. Run on the Mac.

```
The horse/jockey form mart double-counts starts, inflating wins / top3 / win% /
top3% — the panel's headline numbers. Root cause + required fix below.

## Defect (reproduced by the verifier from raw silver)
src/keibamon_core/marts/form.py de-duplicates ENTRIES on (race_id,horse_number)
via the ROW_NUMBER() block at ~L135-143 (dedup_entries), but JOINs RESULTS (`r`)
RAW. Silver jravan_race_results has 1,471 duplicate (race_id,horse_number)
groups, so the entries→results join emits one row per duplicate result →
1,281 duplicated (horse_name_key, race_id) pairs in horse_form.parquet.
Evidence: ダノンデサイル race jra-20250405-C7-08 (a win) appears TWICE → the
mart reports 6 wins / 40% where silver truth is 5 wins. Mart-wide: 1,281
(horse,race) pairs occur >1x.

Secondary symptom (investigate while fixing): for ダノンデサイル the mart has
14 DISTINCT race_id but silver has 15 distinct starts — the join is also
DROPPING one real start. After the fix the per-horse start set MUST be exactly
1:1 with silver (no dup, no drop).

## Required fix
1. Dedup results the same way entries are deduped, BEFORE the join: add a
   dedup_results CTE — ROW_NUMBER() OVER (PARTITION BY race_id, horse_number
   ORDER BY <same src_rank / a stable tiebreak>) and keep _rrn = 1. Join
   dedup_entries to dedup_results (not raw {results}). Pick the surviving result
   row deterministically (prefer jravan; if a race genuinely has two different
   finish_positions for one (race_id,horse_number), prefer the non-NULL / the
   confirmed one and note it).
2. Re-derive field_size from the deduped set (already uses dedup_entries — fine).
3. Resolve the off-by-one drop: confirm the entries↔results join key is exactly
   (race_id, horse_number) on both deduped sides and that a horse with a result
   row but an odd entry mapping isn't lost. After the fix, re-run the verifier's
   check: ダノンデサイル must show 15 distinct starts, 5 wins, 10 top3.

## Regression tests to ADD (so this can't recur)
- A mart invariant test: NO (horse_name_key, race_id) pair appears more than
  once in horse_form.parquet; same for (jockey_id, race_id) semantics in the
  jockey aggregation.
- A golden test on a fixture with a duplicated results row: assert the start is
  counted once and win%/top3% match the hand-computed truth.
- Keep PYTHONPATH=src ./venv64/bin/python -m pytest -q and npm --prefix frontend
  test green.

## Rebuild + handback
make form-marts  (or python -m keibamon_core.marts.form), then report:
  - new row counts for horse_form / jockey_form
  - the verifier reproduction: /api/horses/ダノンデサイル/form now = 15 starts,
    5 wins, 10 top3 (33.3% / 66.7%)
  - mart-wide: 0 duplicated (horse_name_key, race_id) pairs
  - pytest + frontend output (incl. the 2 new regression tests)
The verifier will independently recompute ダノンデサイル + one jockey from
silver, re-run the mart-wide duplicate scan (must be 0), and re-confirm PIT
exclusion before sign-off. Mark "ready for re-verification", not "done".
```
