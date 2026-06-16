"""Validate odds-curve signals with final-payout settlement.

Selections are made from PIT curve features at a pre-post decision time. Returns
are settled against official final payouts, never against the early odds seen at
decision time (DATA_TRAPS['odds_curve.early_price']).

The bar to clear is the de-vigged market net of JRA takeout (≈-23% for win).
Anything less is no edge. Reports ROI with plain thin-sample messaging when the
curve coverage is below the threshold required for a stable read.
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

# Thresholds for honest reporting. Below these we print the count and skip the
# metric rather than report a flattering number off a tiny sample.
MIN_RACES_FOR_ROI = 200
MIN_RACES_PER_DECISION = 100


@dataclass(frozen=True)
class SettlementReport:
    bets: int
    infinitesimal_roi: float
    capacity_adjusted_roi: float
    hit_rate: float


def main() -> None:
    lake = LakePaths()
    if not lake.gold_dataset(CURVE_FEATURE_SET).exists():
        print(
            f"No {CURVE_FEATURE_SET} gold dataset. "
            "Run `python -m keibamon_core.ingestion.curve_features` first."
        )
        return

    rows = _load_rows(lake)
    races = {r["race_id"] for r in rows}
    decisions = {int(r["decision_minutes_to_post"]) for r in rows}
    print(
        f"Odds-curve gold: {len(races):,} races, {len(rows):,} runner-decision rows, "
        f"decision points = {sorted(decisions)}"
    )

    if len(races) < MIN_RACES_FOR_ROI:
        print(
            "Insufficient sample for an honest ROI read: "
            f"{len(races)} races < {MIN_RACES_FOR_ROI} required. "
            "Coverage is gated on the JRA-VAN live entitlement (ADR-0002): "
            "0B41/0B42 backfill or sustained live snapshot history is required "
            "to clear this bar. No metrics reported."
        )
        _per_decision_thin_report(rows)
        return

    payouts = _load_win_payouts(lake)
    if not payouts:
        print("No win payouts available for settlement.")
        return

    selected = _select_top_curve_gap(rows)
    report = settle_win_bets(selected, payouts, capacity_fraction=0.002)
    print("=" * 72)
    print(
        f"Odds-curve validation: top-pick (shortening into decision time), "
        f"{report.bets:,} bets, settled at FINAL official payouts"
    )
    print("=" * 72)
    print(f"Infinitesimal ROI: {report.infinitesimal_roi:+.3f}")
    print(f"Capacity-adjusted ROI (0.2% pool share haircut): {report.capacity_adjusted_roi:+.3f}")
    print(f"Hit rate: {report.hit_rate:.3f}")
    print("JRA win takeout is ~23%; ROI > -0.23 is the bar to clear.")
    print("Robustness (remove top-N payoffs):")
    for n in (1, 3, 5, 10):
        trimmed = settle_win_bets(_remove_top_payoffs(selected, payouts, n), payouts)
        print(f"  remove top {n:>2}: ROI={trimmed.infinitesimal_roi:+.3f}")
    _per_decision_report(rows, payouts)


def _per_decision_thin_report(rows: list[dict]) -> None:
    """Even when the overall sample is too thin, show how coverage splits across
    decision points so the operator knows which slice is closest to useful."""
    by_decision: dict[int, set[str]] = {}
    for r in rows:
        by_decision.setdefault(int(r["decision_minutes_to_post"]), set()).add(r["race_id"])
    if not by_decision:
        return
    print("Per-decision coverage (races with at least one odds snapshot):")
    for dm in sorted(by_decision):
        n = len(by_decision[dm])
        flag = "" if n >= MIN_RACES_PER_DECISION else "  (need ≥100)"
        print(f"  {dm:>3}-min-to-post: {n:>4,} races{flag}")


def _per_decision_report(rows: list[dict], payouts: list[dict]) -> None:
    by_decision: dict[int, list[dict]] = {}
    for r in rows:
        by_decision.setdefault(int(r["decision_minutes_to_post"]), []).append(r)
    print("Per-decision ROI:")
    for dm in sorted(by_decision):
        bets = _select_top_curve_gap(by_decision[dm])
        if len(bets) < MIN_RACES_PER_DECISION:
            print(
                f"  {dm:>3}-min-to-post: {len(bets):>4} bets "
                f"(thin -- need ≥{MIN_RACES_PER_DECISION})"
            )
            continue
        rep = settle_win_bets(bets, payouts)
        print(
            f"  {dm:>3}-min-to-post: {rep.bets:>4,} bets, "
            f"ROI={rep.infinitesimal_roi:+.3f}, hit_rate={rep.hit_rate:.3f}"
        )


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
