# ADR-0004: Retire the capture PC — Mac-only, scrape-sourced ingestion

- **Status:** Accepted
- **Date:** 2026-06-18
- **Deciders:** David Klan
- **Supersedes:** the primary-source decision in [[ADR-0002]]; the *forward* JV-Link
  bronze pull in [[ADR-0001]] (historical bronze is retained, not re-pulled).

## Context

The system was designed around a stationary Windows **capture PC** running JV-Link
(32-bit COM) as the authoritative, licensed source, with a netkeiba scrape on the
Mac as interim/backup (`docs/device-topology.md`, ADR-0001, ADR-0002). Two facts
have made that PC hard to justify:

- The **realtime/速報系 entitlement was never acquired** (ADR-0002 is still BLOCKED),
  so the PC's authoritative *live* path (`JVRTOpen`, `0B41/0B42`) has never been
  available to us. Live odds have run on the **netkeiba feed on the Mac** the whole
  time.
- The **historical/蓄積系 pull is complete** — the lake holds the full JV-Link
  history. The remaining value of JV-Link is the *ongoing weekly* delivery of
  official results, payouts, and entries, not new history.

David's decision: **retire the separate capture PC and run the entire system on the
Mac**, sourcing all ongoing data by scrape (netkeiba primary, Yahoo SportsNavi for
reference/cross-validation). This trades source authority for a single-machine,
zero-Windows operation.

## Decision

1. **The Mac is the sole device.** It owns the lake, dev, the weekend pipeline,
   live capture, and the D1 push. There is no airgap, no USB transfer, and no
   32-bit COM. The Mac runs stationary, lid forced open (`caffeinate -dis` + lid
   sleep disabled), creds preflighted — the stationary-host discipline moves from
   the PC to the Mac.
2. **All ongoing data is scrape-sourced.** netkeiba is the primary feed for odds,
   results, payouts, and entries; Yahoo SportsNavi is reference/cross-validation
   only, fetched occasionally, never hammered. The polite-fetch design from
   ADR-0002 (conditional requests, descriptive UA, robots.txt, strict rate limits,
   archive-raw-once-then-parse) carries over verbatim and is now mandatory, not
   optional.
3. **JV-Link is decommissioned after one final bulk pull**, which is kept as the
   immutable historical record of truth and the cross-validation oracle (D-prereq).
4. **The weekend-pipeline device guards collapse to `mac-dev`.** Stage 3 (`track`)
   no longer allows `capture-pc`; every stage runs on the Mac.

## The prerequisite — do NOT power off the PC until this is true (sequencing)

This is load-bearing and the most common way this decision goes wrong: **the
netkeiba poller today fetches ODDS ONLY.** Results, payouts, and entries currently
exist in the lake solely because JV-Link produced them (`jravan_race_results`,
`jravan_payouts`, `jravan_race_entries`). The settlement spine — stage 4,
`ingestion/settlement.py`, "settle at official final payouts" — reads
`jravan_payouts`. Switch off JV-Link before a scrape replacement exists and
**settlement of every new race goes dark**: no payouts, no results, no calibration
verdict.

Before the PC is retired, all of the following must be built, tested, and running
on the Mac:

- A netkeiba/Yahoo **results** scraper → `jravan_race_results` (finish order,
  final odds). Must preserve the placeholder-id guard
  (`horse_id='0000000000'` non-unique; join on `(race_id, horse_number)`).
- A **payouts** scraper → `jravan_payouts` (one row per winning combo per pool),
  honoring dead-heat and special-payout cases the official table encodes.
- An **entries** scraper → `jravan_race_entries` (runners, gate/wakuban).
- A **cross-validation gate**: over the overlap window where both the final JV-Link
  pull and the scrape exist, scraped payouts/results must match the official rows
  at **0.0000% mismatch** (reuse the `settle_many` settlement-oracle audit from
  `tools/validate_market_baseline.py`). Only after a clean overlap is the PC
  switched off.

Until that lands, we remain in the **hybrid** state (PC docked for the weekly
official pull, Mac for everything else). The PC is *deprecated*, not yet *gone*.

## Consequences

**Positive.** One machine. No Windows, no 32-bit env split, no airgap/USB hop, no
cross-shell `CF_*` portability problem (it was a Windows `setx` artifact). The
topology simplifies dramatically and the stationary-host rule has exactly one home.

**Costs (accepted, eyes open).**
- **Source authority is downgraded.** A ToS-gray, *derived*, brittle scrape becomes
  the record of truth. "Settle at official payouts" (modeling-spine.md step 1)
  becomes "settle at *scraped* payouts" — a real caveat on every post-cutover
  calibration number. The integrity claim weakens from *licensed-official* to
  *scraped-and-cross-checked*.
- **Brittleness.** netkeiba/Yahoo can change format, rate-limit, or block without
  notice. Loud monitoring on scrape failure is now mandatory; a silent scrape
  outage means a lost race day, and (per below) some of that is unrecoverable.
- **No 1-year backfill safety net.** The `0B41/0B42` time-series retention that
  ADR-0002 noted as backfillable dies with JV-Link. Intraday curves now genuinely
  cannot be backfilled — the "capture live early, on a host that does not sleep"
  discipline is back in full force and applies to the Mac.
- **Reverses ADR-0002.** The deliberate move *away* from scraping (to remove ToS
  risk) is undone. That tradeoff is now reaccepted intentionally.

**Naming debt (follow-up).** The silver tables are named `jravan_*` but will no
longer come from JV-Link. Recommend keeping the names short-term to avoid a
migration, and adding a `source` provenance column (`jravan` | `netkeiba` |
`yahoo`) to every ingested row so post-cutover data is distinguishable from the
licensed history. A rename to source-neutral names is a separate, later decision.

## Alternatives considered

- **Consolidate to Mac + Windows VM (keep JV-Link).** Rejected by David: keeps a
  Windows dependency. Would have preserved the licensed feed on one physical
  machine.
- **Hybrid indefinitely.** This is the *transitional* state we occupy until the
  prerequisite is met; not the end state.

Related: [[ADR-0001]], [[ADR-0002]], [[ADR-0003]] (the weekend pipeline whose
`track` guard this collapses to `mac-dev`). `docs/device-topology.md` is updated to
mark the PC deprecated and point here.

## Status — implementation progress

The scrape-sourced ingestion adapters and cross-validation gate are implemented:

- `src/keibamon_core/adapters/netkeiba_entries.py` / `netkeiba_results.py` /
  `netkeiba_payouts.py` — three-layer adapters (parse → record-build → upsert),
  producing silver rows byte-identical to `jravan_silver`'s JV-Link shape.
- `src/keibamon_core/ingestion/scrape_upsert.py` — partition-aware RMW helper
  (the load-bearing upsert constraint: `write_dataset`'s `delete_matching` would
  clobber unrelated races in the same `(year, venue)` partition).
- `src/keibamon_core/adapters/netkeiba_http.py` — polite fetch + bronze archive
  primitives (descriptive UA, conditional GET, mandatory rate floor).
- `tools/scrape_ingest.py` — single CLI entry.
- `tools/validate_scrape_vs_jravan.py` — the gate (four oracles + settle
  equivalence).

PC cutover status:

- [x] Scrape adapters built and fixture-tested (12 tests, 159 passed overall).
- [x] Cross-validation gate built; runs and prints `VERDICT: NO-OVERLAP-YET`
      on a lake with no overlap (exit 0).
- [ ] Step 5 cross-validation gate passed 0.0000% on a real weekend overlap
      (YYYY-MM-DD). **The PC is NOT switched off until this prints PASS over a
      real weekend overlap window.**
- [x] Parser recalibrated against live netkeiba payloads. All four adapters
      (races / entries / results / payouts) drive REAL captured HTML fixtures
      end-to-end: `shutuba_202605030611.html` (2026-06-21 Tokyo R11, G3),
      `shutuba_202609030611.html` (2026-06-21 Hanshin R11, G3),
      `result_202609030411.html` (2026-06-14 宝塚記念 G1, 18 finishers).
      Synthetic JSON fixtures retired. **Encoding note:** pages are served
      UTF-8 (Content-Type charset=UTF-8), not EUC-JP as the spec draft
      claimed — `_charset_from_content_type` defaults to UTF-8 and the
      bytes decode cleanly under it; EUC-JP/Shift-JIS/CP932 all fail.
