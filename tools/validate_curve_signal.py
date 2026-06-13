"""Validate odds-curve signals with final-payout settlement.

Selections are made from PIT curve features at a pre-post decision time. Returns
are settled against official final payouts, never against the early odds seen at
decision time.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path
from statistics import mean

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.ingestion.curve_features import CURVE_FEATURE_SET
from keibamon_core.paths import LakePaths


@dataclass(frozen=True)
class SettlementReport:
    bets: int
    infinitesimal_roi: float
    capacity_adjusted_roi: float
    hit_rate: float


def main() -> None:
    lake = LakePaths()
    if not lake.gold_dataset(CURVE_FEATURE_SET).exists():
        print("No odds_curve gold dataset found. Run build_curve_features(lake) first.")
        return

    rows = _load_rows(lake)
    races = {r["race_id"] for r in rows}
    if len(races) < 20:
        print(
            "Insufficient odds-curve validation sample: "
            f"{len(races)} races / {len(rows)} runner-decision rows. "
            "Meaningful ROI needs accumulated 0B41/0B42 or live snapshot history."
        )
        return

    selected = _select_top_curve_gap(rows)
    payouts = _load_win_payouts(lake)
    report = settle_win_bets(selected, payouts, capacity_fraction=0.002)
    print("Odds-curve validation, selected pre-post and settled at final payouts")
    print(f"Bets: {report.bets:,}")
    print(f"Infinitesimal ROI: {report.infinitesimal_roi:.3f}")
    print(f"Capacity-adjusted ROI: {report.capacity_adjusted_roi:.3f}")
    print(f"Hit rate: {report.hit_rate:.3f}")
    print("Robustness:")
    for n in (1, 3, 5):
        trimmed = settle_win_bets(_remove_top_payoffs(selected, payouts, n), payouts)
        print(f"  remove top {n} payoffs: ROI={trimmed.infinitesimal_roi:.3f}")


def settle_win_bets(
    bets: list[dict],
    payouts: list[dict],
    *,
    stake_yen: int = 100,
    capacity_fraction: float = 0.0,
) -> SettlementReport:
    """Settle win bets from final payout rows.

    ``capacity_fraction`` is a simple pool-impact haircut: a 0.2% pool share
    reduces gross returns by approximately that share before ROI is computed.
    It is intentionally conservative and reported separately from the
    infinitesimal-stake ROI.
    """
    payout_by_race = {
        (p["race_id"], str(p.get("combo", "")).zfill(2)): float(p["payout_yen"])
        for p in payouts
        if p.get("pool") == "win" and p.get("payout_yen")
    }
    if not bets:
        return SettlementReport(0, 0.0, 0.0, 0.0)

    returns = []
    hits = 0
    for bet in bets:
        combo = f"{int(bet['horse_number']):02d}"
        payout = payout_by_race.get((bet["race_id"], combo), 0.0)
        if payout:
            hits += 1
        returns.append(payout / stake_yen)

    gross = mean(returns)
    infinitesimal_roi = gross - 1.0
    adjusted_roi = gross * max(0.0, 1.0 - capacity_fraction) - 1.0
    return SettlementReport(
        bets=len(bets),
        infinitesimal_roi=infinitesimal_roi,
        capacity_adjusted_roi=adjusted_roi,
        hit_rate=hits / len(bets),
    )


def _select_top_curve_gap(rows: list[dict]) -> list[dict]:
    by_race_decision: dict[tuple[str, int], list[dict]] = {}
    for row in rows:
        if row.get("devigged_prob_at_t") is None or row.get("recent_velocity") is None:
            continue
        by_race_decision.setdefault(
            (row["race_id"], int(row["decision_minutes_to_post"])), []
        ).append(row)
    selected = []
    for key, runners in by_race_decision.items():
        # Negative velocity means odds are shortening into decision time.
        selected.append(min(runners, key=lambda r: (r["recent_velocity"], -r["devigged_prob_at_t"])))
    return selected


def _remove_top_payoffs(bets: list[dict], payouts: list[dict], n: int) -> list[dict]:
    payout_by_race = {
        (p["race_id"], str(p.get("combo", "")).zfill(2)): float(p["payout_yen"])
        for p in payouts
        if p.get("pool") == "win" and p.get("payout_yen")
    }
    ranked = sorted(
        bets,
        key=lambda b: payout_by_race.get((b["race_id"], f"{int(b['horse_number']):02d}"), 0.0),
        reverse=True,
    )
    return ranked[n:]


def _load_rows(lake: LakePaths) -> list[dict]:
    sql = f"""
    SELECT *
    FROM {lake_query.src(lake.gold_dataset(CURVE_FEATURE_SET))}
    WHERE win_odds_at_t IS NOT NULL
      AND devigged_prob_at_t IS NOT NULL
    """
    return lake_query.query(sql).to_pylist()


def _load_win_payouts(lake: LakePaths) -> list[dict]:
    if not lake.silver_dataset("jravan_payouts").exists():
        return []
    sql = f"""
    SELECT race_id, pool, combo, payout_yen
    FROM {lake_query.src(lake.silver_dataset("jravan_payouts"))}
    WHERE pool = 'win'
    """
    return lake_query.query(sql).to_pylist()


if __name__ == "__main__":
    main()
