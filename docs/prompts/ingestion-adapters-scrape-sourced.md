# CLI agent task: scrape-sourced ingestion adapters (results / payouts / entries)

You are working in the Keibamon repo on the **Mac (`mac-dev`)**. Read `CLAUDE.md`,
`docs/adr/0004-mac-only-scrape-sourced.md`, `docs/adr/0001-jra-van-additive-bronze.md`,
`docs/adr/0002-live-odds-source-and-fetch.md`, and `docs/modeling-spine.md`. Run
`python tools/whichdevice.py` to confirm `mac-dev`. Use `venv64`.

## Why this is the critical path

ADR-0004 retires the Windows capture PC and goes **Mac-only, scrape-sourced**. The
**hard prerequisite** before the PC can be switched off: the Mac scrape must supply
the data JV-Link currently does. Today the netkeiba poller fetches **odds only** —
results, payouts, and entries exist in the lake solely because JV-Link made them.
Stage-4 settlement reads `jravan_payouts`; with no scrape replacement, every new
race's settlement goes dark. This task builds that replacement and proves it correct
against the official feed.

**Do not treat this as done until the cross-validation gate (Step 5) passes at
0.0000% mismatch.** Until then the system stays hybrid (PC docked for the weekly
official pull); the PC is not switched off.

## Target schemas — write the SAME silver tables the pipeline already reads

Match the JV-Link silver columns exactly so stages 1/2/4 need no change:

- `jravan_race_entries`: `race_id, horse_id, horse_number, gate (wakuban), …,
  available_at` (+ year/venue partition cols via the existing `_write_silver`).
- `jravan_race_results`: `race_id, horse_id, horse_number, finish_position
  (None if 0/no placing), finish_time_seconds, …, available_at`.
- `jravan_payouts`: `race_id, pool, combo, payout_yen, popularity, available_at`.
  Settlement keys on `(race_id, pool, combo)` and takes `MAX(payout_yen)` (dead-heat
  collapse) — your rows must slot into that lookup unchanged.

Reuse `ingestion/jravan_silver.py:_write_silver` (it derives the partitions from
`race_id`) and the canonical id crosswalk `curve_log.crosswalk_race_id`
(netkeiba `r-YYYY-MMDD-venue-NN` → `jra-YYYYMMDD-<jyo>-NN`).

## Non-negotiable correctness rules

1. **`(race_id, horse_number)` is the only safe key.** Scraped `horse_id` may be
   missing, reformatted, or non-unique. Always carry `horse_number`; never join or
   dedupe on `horse_id` alone (DATA_TRAPS `horse_id='0000000000'`). Add any new
   scrape gotchas to `adapters/jravan.DATA_TRAPS`.
2. **`available_at` is EVENT time, not scrape time.** Stamp results with when the
   official result became available, entries/payouts likewise — never the moment
   you downloaded the page (the `available_at_bulk_download` lesson). PIT
   correctness downstream depends on this; getting it wrong silently leaks
   look-ahead into every backtest.
3. **Provenance column (ADR-0004 follow-up): add `source` to every ingested row**
   (`netkeiba` | `yahoo`; JV-Link rows are `jravan`, treat absent as `jravan` on
   read). This is what keeps post-cutover scraped data distinguishable from the
   licensed history — essential for honest calibration reporting.
4. **Bronze first, then parse (ADR-0001 additive bronze).** Archive each raw scrape
   response to bronze once (replayable), then parse bronze → silver. Don't parse
   straight from the wire.
5. **Polite fetch (ADR-0002 design, now mandatory).** Conditional requests
   (ETag/If-Modified-Since), the descriptive UA already in `polling/netkeiba.py`,
   robots.txt compliance, strict rate limits, back off when the source timestamp is
   unchanged. Yahoo SportsNavi is **reference/cross-validation only** — fetched
   occasionally, never an automated polling loop.

## Step 1 — entries adapter → `jravan_race_entries`

netkeiba race card → runners with `horse_number`, `gate (wakuban)`, `horse_id` (best
effort). `available_at` = entries-published time. New module
`adapters/netkeiba_entries.py` (or extend `polling/netkeiba.py`), bronze-archived,
parsed via a `build_*` fn mirroring `_entry_record`.

## Step 2 — results adapter → `jravan_race_results`

netkeiba results page → finish order, `finish_position` (None for no official
placing), `finish_time_seconds`, `horse_number`, `horse_id` (best effort), final
odds if available. `available_at` = official-result time. Mirror `_result_record`.

## Step 3 — payouts adapter → `jravan_payouts`

netkeiba payouts table → one row per winning combo per pool: `pool, combo,
payout_yen, popularity`. Cover all pools settlement uses (win/place/bracket,
quinella, wide, exacta, trio, trifecta). Honor dead-heat (multiple payout rows per
combo — settlement takes MAX) and special-payout cases. `available_at` = payout-
confirmed time. Mirror `build_jravan_payouts`.

## Step 4 — a single ingest entry point + CLI

`tools/scrape_ingest.py --date YYYYMMDD [--venue ...]` that runs entries → results →
payouts for a card into bronze then silver, idempotently (re-running a settled day
adds no duplicate rows; dedupe on the table's natural key + `available_at`).

## Step 5 — the cross-validation gate (acceptance test; gates PC switch-off)

Build `tools/validate_scrape_vs_jravan.py` (template: `tools/validate_market_baseline.py`'s
settlement oracle). Over the overlap window where BOTH the final JV-Link pull and the
scrape exist:

- **Payout oracle**: for every `(race_id, pool, combo)`, scraped `payout_yen` must
  equal the official `jravan` row. Report mismatch rate — **must be 0.0000%**.
- **Results oracle**: finish_position per `(race_id, horse_number)` matches official.
- **Entries oracle**: runner set + `gate` per `(race_id, horse_number)` matches.
- Settle a full win/place backtest twice (official rows vs scraped rows via
  `settle_many`) and assert identical settlements. Any divergence prints the races
  and the diff; the gate fails.

Print the verdict plainly. **The PC is retired only after this prints 0.0000% on a
full weekend overlap.** Document that in the commit message and as a checkbox in
ADR-0004 if you add a status line.

## Step 6 — tests (keep suite green)

`tests/test_scrape_adapters.py`: parse fixed netkeiba fixtures → expected silver rows
(entries/results/payouts); `(race_id, horse_number)` keying survives a
`horse_id='0000000000'` pair; `available_at` is event-time not download-time;
`source='netkeiba'` stamped; idempotent re-ingest adds no duplicates; the
cross-validation oracle flags an injected mismatch. Save raw fixtures under
`tests/fixtures/`. Run `PYTHONPATH=src ./venv64/bin/python -m pytest -q` — all green.

## Step 7 — commit (not pushed; standing instruction)

```
git add src/keibamon_core/adapters/ src/keibamon_core/ingestion/ \
        tools/scrape_ingest.py tools/validate_scrape_vs_jravan.py \
        tests/test_scrape_adapters.py tests/fixtures/ \
        docs/prompts/ingestion-adapters-scrape-sourced.md
git commit -m "scrape-sourced ingestion: entries/results/payouts adapters + JV-Link cross-val gate (ADR-0004 prereq)"
```

## Guardrails

- Same silver schemas as JV-Link; stages 1/2/4 must not need edits.
- `(race_id, horse_number)` keying only; `available_at` = event time; `source`
  provenance on every row; bronze-first; polite fetch.
- No edge/betting logic. This is data plumbing for honest settlement.
- Do NOT advise switching off the PC until Step 5 passes 0.0000% on a real overlap.
- If a real interface differs from this spec, prefer the code and note the deviation.
```
