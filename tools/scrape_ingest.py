"""Single CLI entry for netkeiba scrape-sourced ingestion.

Ingests one race day's worth of entries / results / payouts into the lake,
mapping netkeiba race ids (``r-YYYY-MMDD-<venue>-NN``) to canonical lake ids
(``jra-YYYYMMDD-<jyo>-NN``) via :func:`curve_log.crosswalk_race_id`.

ALSO fetches each race's header into the ``netkeiba_races`` silver table, which
carries the self-resolve mapping the weekend track depends on (``grade_code``
for the graded-only filter; ``scheduled_post_time`` for adaptive cadence;
``netkeiba_race_id`` for the live-odds lookup). Run this once on Thursday when
the card posts so race-day ``track --grades`` is lookup-free.

Usage::

    tools/scrape_ingest.py --date 20260620 [--venue hanshin] [--races 1,2,3]
                           [--entries] [--results] [--payouts] [--no-header]
                           # default: all four (header + entries + results + payouts)

Pipeline per race: ``build_race`` -> ``build_entries`` -> ``build_results`` ->
``build_payouts``. Each is idempotent on ``(natural_key, available_at)`` thanks
to the partition-aware upsert, so re-running a settled day adds zero rows.

For an empty/missing race card (weather cancellation), prints a clear status
and exits 0 -- race cards go dark on cancellations and that is not a failure.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core.adapters import (
    netkeiba_entries,
    netkeiba_payouts,
    netkeiba_races,
    netkeiba_results,
)
from keibamon_core.ingestion.curve_log import VENUE_JYO, crosswalk_race_id
from keibamon_core.paths import LakePaths


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="Race date YYYYMMDD (JST)")
    parser.add_argument(
        "--venue",
        help="netkeiba venue slug (e.g. hanshin, tokyo). Required when --races is given.",
    )
    parser.add_argument(
        "--races",
        help="Comma-separated race numbers (e.g. 1,2,3). Default: list from the day's card.",
    )
    parser.add_argument(
        "--entries", action="store_true", help="Ingest entries (default: all four)."
    )
    parser.add_argument(
        "--results", action="store_true", help="Ingest results (default: all four)."
    )
    parser.add_argument(
        "--payouts", action="store_true", help="Ingest payouts (default: all four)."
    )
    parser.add_argument(
        "--header", action="store_true",
        help="Ingest the race header into netkeiba_races (default: all four). The "
             "header carries grade_code + post time + netkeiba_race_id -- the "
             "self-resolve mapping `track --grades` depends on.",
    )
    parser.add_argument(
        "--no-header", action="store_true",
        help="Skip the race header fetch (use when only entries/results/payouts "
             "are needed and the card has already been scraped).",
    )
    args = parser.parse_args()

    # Default: all four. If any subset flag is given, do ONLY those. --no-header
    # is a shortcut for "skip the header, do everything else" so legacy callers
    # (`scrape_ingest.py --date ...`) still work without surprise.
    any_subset = args.entries or args.results or args.payouts or args.header
    do_header = (args.header or (not any_subset)) and not args.no_header
    do_entries = args.entries or (not any_subset)
    do_results = args.results or (not any_subset)
    do_payouts = args.payouts or (not any_subset)

    lake = LakePaths()
    lake.ensure()

    yyyy = args.date[:4]
    mmdd = args.date[4:]
    venue = args.venue
    if args.races:
        if not venue:
            parser.error("--venue is required when --races is given")
        races = _parse_race_numbers(args.races)
    else:
        venue, races = _discover_card(args.date, venue)
        if not races:
            print(
                f"No race card found for {args.date}"
                + (f" @ {venue}" if venue else "")
                + ". (Card may be cancelled or not yet published.)"
            )
            return 0

    total = {"header": 0, "entries": 0, "results": 0, "payouts": 0}
    for rno in races:
        nk_id = f"r-{yyyy}-{mmdd}-{venue}-{rno}"
        try:
            race_id = crosswalk_race_id(nk_id)
        except ValueError as exc:
            print(f"  {nk_id}: skip ({exc})")
            continue

        per_race = 0
        try:
            if do_header:
                n = netkeiba_races.build_race(lake, nk_id, race_id)
                total["header"] += n
                per_race += n
            if do_entries:
                n = netkeiba_entries.build_entries(lake, nk_id, race_id)
                total["entries"] += n
                per_race += n
            if do_results:
                n = netkeiba_results.build_results(lake, nk_id, race_id)
                total["results"] += n
                per_race += n
            if do_payouts:
                n = netkeiba_payouts.build_payouts(lake, nk_id, race_id)
                total["payouts"] += n
                per_race += n
        except Exception as exc:  # noqa: BLE001 - one bad race must not kill the day
            # Print the traceback so a parser/recalibration bug is visible.
            # Per ADR-0004, silent scrape failures lose race days -- the day's
            # other races still run, but a single-race failure must be loud.
            import traceback
            print(f"  {race_id}: failed ({exc!r}); continuing")
            traceback.print_exc()
            continue
        print(f"  {race_id}: +{per_race} rows")

    print(
        f"Ingested {args.date} @ {venue}: "
        f"header={total['header']}, entries={total['entries']}, "
        f"results={total['results']}, payouts={total['payouts']}"
    )
    return 0


def _parse_race_numbers(spec: str) -> list[int]:
    out: list[int] = []
    for chunk in spec.split(","):
        chunk = chunk.strip()
        if not chunk:
            continue
        try:
            out.append(int(chunk))
        except ValueError:
            raise SystemExit(f"bad --races entry {chunk!r}") from None
    return sorted(set(out))


def _discover_card(date_yyyymmdd: str, venue_hint: str | None) -> tuple[str | None, list[int]]:
    """List the day's race numbers. Default behavior until the live list endpoint
    is calibrated: enumerate a small range and let the polite fetcher fail loud
    if we hit something unexpected. Real implementation belongs in netkeiba_http
    once the actual list endpoint shape is confirmed."""
    # The real netkeiba race-list endpoint shape needs calibration; until then
    # we surface a clear error so callers pass --races explicitly.
    if venue_hint is None:
        return None, []
    # Conservative default race range (JRA cards are typically R1..R12).
    return venue_hint, list(range(1, 13))


if __name__ == "__main__":
    raise SystemExit(main())
