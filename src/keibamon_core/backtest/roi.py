"""ROI backtesting with official pari-mutuel settlement."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from keibamon_core import lake_query
from keibamon_core.backtest.engine import rank_horses
from keibamon_core.backtest.predictors import Predictor
from keibamon_core.features.point_in_time import LeakageError
from keibamon_core.ingestion.market_baseline import MARKET_BASELINE_FEATURE_SET
from keibamon_core.ingestion.settlement import Bet, settle
from keibamon_core.paths import LakePaths

Staking = Literal["flat", "fractional_kelly"]


@dataclass(frozen=True)
class RoiBacktestReport:
    bets: int
    stake_yen: float
    returned_yen: float
    infinitesimal_roi: float | None
    capacity_adjusted_roi: float | None
    hit_rate: float | None
    remove_top_payoffs_roi: dict[int, float | None]


def run_roi_backtest(
    lake: LakePaths,
    predictor: Predictor,
    *,
    feature_set: str = MARKET_BASELINE_FEATURE_SET,
    pool: str = "win",
    stake_yen: int = 100,
    staking: Staking = "flat",
    kelly_fraction: float = 0.25,
    capacity_fraction: float = 0.0,
) -> RoiBacktestReport:
    """Backtest top-pick win/place ROI using final official payouts."""
    feature_path = lake.gold_dataset(feature_set)
    if not feature_path.exists():
        return _empty_report()

    returns: list[float] = []
    stakes: list[float] = []
    hits = 0

    for race_id, rows in lake_query.iter_groups(
        f"SELECT * FROM {lake_query.src(feature_path)} ORDER BY race_id, horse_number",
        key="race_id",
    ):
        if not rows:
            continue
        as_of_time = rows[0]["as_of_time"]
        _assert_no_leakage(str(race_id), as_of_time, rows)
        scores = predictor.score_race({"race_id": race_id}, rows)
        ranking = rank_horses(scores)
        if not ranking:
            continue
        top_horse = ranking[0]
        top = next(r for r in rows if r["horse_id"] == top_horse)
        stake = _stake_for(top, stake_yen, staking, kelly_fraction)
        if stake <= 0:
            continue
        result = settle(
            lake,
            Bet(
                race_id=str(race_id),
                pool=pool,  # type: ignore[arg-type]
                selection=str(top["horse_number"]),
                stake_yen=round(stake),
            ),
        )
        stakes.append(stake)
        returns.append(float(result.returned_yen))
        hits += 1 if result.payout_yen > 0 else 0

    if not stakes:
        return _empty_report()
    total_stake = sum(stakes)
    total_return = sum(returns)
    roi = total_return / total_stake - 1.0
    adjusted_roi = total_return * max(0.0, 1.0 - capacity_fraction) / total_stake - 1.0
    return RoiBacktestReport(
        bets=len(stakes),
        stake_yen=round(total_stake, 2),
        returned_yen=round(total_return, 2),
        infinitesimal_roi=round(roi, 4),
        capacity_adjusted_roi=round(adjusted_roi, 4),
        hit_rate=round(hits / len(stakes), 4),
        remove_top_payoffs_roi={
            n: _trimmed_roi(stakes, returns, n)
            for n in (1, 5, 10)
        },
    )


def _stake_for(row: dict[str, Any], stake_yen: int, staking: Staking, fraction: float) -> float:
    if staking == "flat":
        return float(stake_yen)
    prob = float(row.get("calibrated_market_prob") or row.get("devigged_market_prob") or 0.0)
    odds = float(row.get("win_odds") or 0.0)
    if odds <= 1.0 or prob <= 0:
        return 0.0
    edge = prob * odds - 1.0
    if edge <= 0:
        return 0.0
    kelly = edge / (odds - 1.0)
    return stake_yen * min(1.0, max(0.0, kelly * fraction))


def _trimmed_roi(stakes: list[float], returns: list[float], remove_n: int) -> float | None:
    pairs = sorted(zip(stakes, returns, strict=True), key=lambda p: p[1], reverse=True)[remove_n:]
    if not pairs:
        return None
    stake = sum(p[0] for p in pairs)
    if stake <= 0:
        return None
    return round(sum(p[1] for p in pairs) / stake - 1.0, 4)


def _assert_no_leakage(race_id: str, as_of_time, rows: list[dict[str, Any]]) -> None:
    for row in rows:
        if row["as_of_time"] > as_of_time or row["max_source_available_at"] > row["as_of_time"]:
            raise LeakageError(
                f"ROI backtest aborted: feature row {race_id}/{row['horse_id']} uses future data"
            )


def _empty_report() -> RoiBacktestReport:
    return RoiBacktestReport(
        bets=0,
        stake_yen=0.0,
        returned_yen=0.0,
        infinitesimal_roi=None,
        capacity_adjusted_roi=None,
        hit_rate=None,
        remove_top_payoffs_roi={1: None, 5: None, 10: None},
    )
