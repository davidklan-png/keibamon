"""settle_curve_log.py -- freeze live odds curves, then settle them vs results.

The settle logger in two passes (see ingestion/curve_log.py for the why):

  FREEZE (default) -- snapshot each runner's curve at a pre-post decision time
  from the banked ``odds_snapshots`` and write to silver ``curve_log`` with the
  result fields NULL. Run it once near post, when the odds are mature:

    PYTHONPATH=src ./venv64/bin/python tools/jravan/settle_curve_log.py \
        --date 2026-0614 --venue hanshin --lead-min 5

  SETTLE (--settle) -- read the frozen rows, join to the official finish, pay
  each 1-unit win bet at the official FINAL odds, and print the
  firming/draining/neutral ROI. Run after the JV-Link pull lands results in the
  lake, or pass --results-csv to settle by hand the same night:

    PYTHONPATH=src ./venv64/bin/python tools/jravan/settle_curve_log.py --settle \
        --date 2026-0614 --venue hanshin
    # or, same night, from a hand-typed finish order:
    # race_id,horse_number,finish_position,final_odds   (race_id may be r-... or jra-...)
    ... --settle --results-csv today_results.csv

One card proves nothing. This just makes every card accumulate into the only
evidence that can confirm or kill the odds-curve edge. Not a bet recommender.
"""
from __future__ import annotations

import argparse
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
from keibamon_core import lake_query  # noqa: E402
from keibamon_core.ingestion.curve_log import (  # noqa: E402
    build_curve_records,
    crosswalk_race_id,
    read_curve_log,
    settle_curve_records,
    summarize,
    upsert_curve_log,
)
from keibamon_core.ingestion.odds import ODDS_TABLE  # noqa: E402
from keibamon_core.lake import read_parquet_if_exists  # noqa: E402
from keibamon_core.paths import LakePaths  # noqa: E402


def _results_from_lake(lake: LakePaths, canon_ids: set[str]) -> dict:
    results_dir = lake.silver_dataset("jravan_race_results")
    entries_dir = lake.silver_dataset("jravan_race_entries")
    if not canon_ids or not results_dir.is_dir() or not entries_dir.is_dir():
        return {}
    in_list = ",".join(f"'{c}'" for c in sorted(canon_ids))
    sql = (
        "SELECT e.race_id rid, e.horse_number hn, r.finish_position fp, r.win_odds fo "
        "FROM {results} r JOIN {entries} e "
        "ON r.race_id = e.race_id AND r.horse_id = e.horse_id "
        f"WHERE e.horse_id <> '0000000000' AND e.race_id IN ({in_list})"
    )
    tbl = lake_query.query(sql, results=results_dir, entries=entries_dir)
    out = {}
    for row in tbl.to_pylist():
        if row["fp"] is None:
            continue
        out[(row["rid"], int(row["hn"]))] = (int(row["fp"]), row["fo"])
    return out


def _results_from_csv(path: str) -> dict:
    out = {}
    with open(path, newline="") as f:
        for row in csv.DictReader(f):
            rid = row["race_id"].strip()
            if rid.startswith("r-"):
                rid = crosswalk_race_id(rid)
            fo = (row.get("final_odds") or "").strip()
            out[(rid, int(row["horse_number"]))] = (
                int(row["finish_position"]), float(fo) if fo else None,
            )
    return out


def _print_summary(settled: list[dict]) -> None:
    s = summarize(settled)
    if not s:
        print("  (no settled rows yet)")
        return
    print(f"  {'tag':<10}{'n':>6}{'win_rate':>10}{'ROI':>9}")
    for tag in ("firming", "draining", "neutral"):
        if tag in s:
            r = s[tag]
            print(f"  {tag:<10}{r['n']:>6}{r['win_rate']:>10}{r['roi']:>+9.3f}")
    print("  NOTE: tiny-sample, provisional. The market floor is ~ -0.20 (takeout).")
    print("  A firming-bucket ROI above neutral, sustained over many cards, is the")
    print("  only thing that confirms the curve edge. One day means nothing.")


def main() -> None:
    ap = argparse.ArgumentParser(description="Freeze/settle odds-curve records.")
    ap.add_argument("--date", required=True, help="feed date token, e.g. 2026-0614")
    ap.add_argument("--venue", required=True, help="e.g. hanshin")
    ap.add_argument("--lead-min", type=float, default=5.0,
                    help="decision time = post (or last snap) minus this many minutes")
    ap.add_argument("--settle", action="store_true", help="settle frozen rows vs results")
    ap.add_argument("--results-csv", help="settle from a CSV instead of the lake")
    ap.add_argument("--dry-run", action="store_true", help="compute but do not write")
    args = ap.parse_args()

    lake = LakePaths()
    prefix = f"r-{args.date}-{args.venue}-"

    if not args.settle:
        snaps = [r for r in read_parquet_if_exists(lake.silver_table(ODDS_TABLE))
                 if str(r.get("race_id", "")).startswith(prefix)]
        if not snaps:
            print(f"no odds_snapshots rows for {prefix}* -- is the feed running/banked?")
            return
        recs = build_curve_records(snaps, lead_min=args.lead_min)
        flags = sum(1 for r in recs if r["drift_dir"])
        races = sorted({r["race_id"] for r in recs})
        print(f"FREEZE {prefix}*: {len(recs)} runner-curves across {len(races)} races, "
              f"{flags} residual flag(s), decision = post/last - {args.lead_min:g}min")
        for r in recs:
            if r["drift_dir"]:
                print(f"  {r['race_id']} #{r['horse_number']}: {r['drift_dir']} "
                      f"{r['drift_resid_pct']*100:+.0f}% vs field (open {r['open_odds']} "
                      f"-> @t {r['decision_odds']})")
        if args.dry_run:
            print("(dry-run: nothing written)")
            return
        n = upsert_curve_log(lake, recs)
        print(f"wrote {n} rows to curve_log. Run with --settle once results land.")
        return

    # SETTLE
    rows = [r for r in read_curve_log(lake) if str(r.get("race_id", "")).startswith(prefix)]
    if not rows:
        print(f"no frozen curve_log rows for {prefix}* -- run the freeze pass first.")
        return
    canon = {crosswalk_race_id(r["race_id"]) for r in rows}
    results = (_results_from_csv(args.results_csv) if args.results_csv
               else _results_from_lake(lake, canon))
    if not results:
        src = args.results_csv or "the lake (jravan_race_results)"
        print(f"no results found in {src} for these races yet. "
              "Settle later once the JV-Link pull lands, or pass --results-csv.")
        return
    settled = settle_curve_records(rows, results)
    done = sum(1 for r in settled if r["settled"])
    print(f"SETTLE {prefix}*: {done}/{len(settled)} runner-curves settled\n")
    _print_summary(settled)
    if not args.dry_run:
        upsert_curve_log(lake, settled)
        print("\ncurve_log updated with results.")


if __name__ == "__main__":
    main()
