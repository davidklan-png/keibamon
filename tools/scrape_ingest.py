"""Single CLI entry for netkeiba scrape-sourced ingestion.

Ingests one race day's worth of entries / results / payouts into the lake.
Numeric netkeiba race ids are DISCOVERED from the day's race-list page (one
polite GET) via :func:`netkeiba_discovery.discover_card` — they cannot be
synthesized from ``(date, venue, raceno)`` because the id encodes
``kai``/``nichi``, which aren't recoverable from the calendar date.

Discovery persists canonical_race_id -> numeric_nk_id into the
``netkeiba_races`` silver table (via :func:`netkeiba_races.build_race`), which
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
from keibamon_core.adapters.netkeiba_discovery import DiscoveredRace, discover_card
from keibamon_core.ingestion.curve_log import VENUE_JYO
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

    # STEP 1: discover the day's card (one polite GET of race_list_sub.html).
    # The numeric netkeiba id encodes kai/nichi which aren't derivable from
    # the date alone -- they must be READ off the day's race-list hrefs. This
    # replaces the old synthetic-id construction (``r-YYYY-MMDD-<venue>-NN``)
    # which netkeiba's server didn't recognize and returned an empty shell.
    discovered_all = discover_card(args.date)
    if not discovered_all:
        print(
            f"No race card published for {args.date}. "
            "(Card may be cancelled or not yet posted.)"
        )
        return 0

    # Filter by --venue and --races if given. The venue filter matches the
    # numeric id's venue digits (positions 5-6), which ARE the JRA track
    # codes (per ADR-0004 -- no netkeiba-vs-JRA remap).
    if args.venue:
        target_code = VENUE_JYO.get(args.venue.lower())
        if target_code is None:
            parser.error(
                f"unknown venue {args.venue!r}; known slugs: {sorted(VENUE_JYO)}"
            )
        discovered = [d for d in discovered_all if d.venue_code == target_code]
        venue_label = args.venue
    else:
        discovered = list(discovered_all)
        venue_label = "(all venues)"

    if args.races:
        race_set = set(_parse_race_numbers(args.races))
        discovered = [d for d in discovered if d.race_no in race_set]

    if not discovered:
        print(
            f"No races selected for {args.date} @ {venue_label} "
            f"(after --venue/--races filter)."
        )
        return 0

    print(
        f"Discovered {len(discovered)} race(s) for {args.date} @ {venue_label}"
    )

    total = {"header": 0, "entries": 0, "results": 0, "payouts": 0}
    for d in discovered:
        # STEP 2: each adapter fetches by the DISCOVERED numeric id. The
        # numeric id is what every netkeiba ``?race_id=`` endpoint expects;
        # the canonical race_id is the lake key. The persisted
        # ``netkeiba_race_id`` silver column carries the numeric form so
        # self-resolving ``track --grades`` reads it back unchanged.
        per_race = 0
        try:
            if do_header:
                n = netkeiba_races.build_race(lake, d.numeric_id, d.canonical_race_id)
                total["header"] += n
                per_race += n
            if do_entries:
                n = netkeiba_entries.build_entries(lake, d.numeric_id, d.canonical_race_id)
                total["entries"] += n
                per_race += n
            if do_results:
                n = netkeiba_results.build_results(lake, d.numeric_id, d.canonical_race_id)
                total["results"] += n
                per_race += n
            if do_payouts:
                n = netkeiba_payouts.build_payouts(lake, d.numeric_id, d.canonical_race_id)
                total["payouts"] += n
                per_race += n
        except Exception as exc:  # noqa: BLE001 - one bad race must not kill the day
            # Print the traceback so a parser/recalibration bug is visible.
            # Per ADR-0004, silent scrape failures lose race days -- the day's
            # other races still run, but a single-race failure must be loud.
            import traceback
            print(f"  {d.canonical_race_id}: failed ({exc!r}); continuing")
            traceback.print_exc()
            continue
        print(f"  {d.canonical_race_id} (nk={d.numeric_id}): +{per_race} rows")

    print(
        f"Ingested {args.date} @ {venue_label}: "
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


if __name__ == "__main__":
    raise SystemExit(main())
