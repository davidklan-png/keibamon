"""Validate settlement and calibrated market baseline sanity checks."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.ingestion.market_baseline import MARKET_BASELINE_FEATURE_SET
from keibamon_core.ingestion.settlement import Bet, settle
from keibamon_core.paths import LakePaths


def main() -> None:
    lake = LakePaths()
    if not lake.silver_dataset("jravan_payouts").exists():
        print("No jravan_payouts table found; build JRA-VAN payouts first.")
        return

    _settlement_oracle(lake)

    if not lake.gold_dataset(MARKET_BASELINE_FEATURE_SET).exists():
        print("No market_baseline gold dataset found; run build_market_probs(lake) first.")
        return
    _market_takeout_sanity(lake)


def _settlement_oracle(lake: LakePaths) -> None:
    total = lake_query.query(
        f"""
        SELECT COUNT(*) AS n
        FROM {lake_query.src(lake.silver_dataset("jravan_payouts"))}
        WHERE pool IN ('win', 'place')
        """
    ).to_pylist()[0]["n"]
    rows = lake_query.query(
        f"""
        SELECT race_id, pool, combo, payout_yen
        FROM {lake_query.src(lake.silver_dataset("jravan_payouts"))}
        WHERE pool IN ('win', 'place')
        ORDER BY race_id, pool, combo
        LIMIT 500
        """
    ).to_pylist()
    mismatches = 0
    for row in rows:
        got = settle(lake, Bet(row["race_id"], row["pool"], row["combo"])).returned_yen
        mismatches += 1 if got != row["payout_yen"] else 0
    rate = mismatches / len(rows) if rows else 0.0
    print(
        "Settlement oracle: "
        f"sampled {len(rows):,}/{total:,} win/place payout rows, "
        f"mismatches={mismatches:,} ({rate:.4%})"
    )


def _market_takeout_sanity(lake: LakePaths) -> None:
    rows = lake_query.query(
        f"""
        WITH joined AS (
            SELECT
                mb.race_id,
                mb.horse_number,
                mb.calibrated_market_prob,
                pay.payout_yen
            FROM {lake_query.src(lake.gold_dataset(MARKET_BASELINE_FEATURE_SET))} mb
            LEFT JOIN {lake_query.src(lake.silver_dataset("jravan_payouts"))} pay
              ON pay.race_id = mb.race_id
             AND pay.pool = 'win'
             AND CAST(pay.combo AS INTEGER) = mb.horse_number
        )
        SELECT
            COUNT(DISTINCT race_id) AS races,
            SUM(calibrated_market_prob * COALESCE(payout_yen, 0)) AS returned_per_100_race
        FROM joined
        """
    ).to_pylist()
    row = rows[0] if rows else {"races": 0, "returned_per_100_race": 0}
    races = row["races"] or 0
    if not races:
        print("Market takeout sanity: no overlapping market/payout races.")
        return
    roi = (row["returned_per_100_race"] / (100.0 * races)) - 1.0
    print(
        "Market takeout sanity: "
        f"{races:,} races, proportional-market ROI={roi:.3f} "
        "(should be near negative takeout; profit suggests leakage)"
    )


if __name__ == "__main__":
    main()
