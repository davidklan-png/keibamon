from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class Predictor(Protocol):
    """Scores one race using only point-in-time feature rows.

    ``score_race`` receives the race mart record and the gold feature rows
    for that race (all guaranteed available at or before the race's
    ``as_of_time``) and returns a score per ``horse_id``. Higher is better.
    Predictors must be deterministic: same inputs, same scores.
    """

    name: str

    def score_race(
        self, race: dict[str, Any], feature_rows: list[dict[str, Any]]
    ) -> dict[str, float]: ...


class CareerWinRatePredictor:
    """Baseline: rank horses by historical win rate known before post time.

    This is the floor every model must beat. It uses only
    ``career_win_rate`` from the gold feature set; horses without history
    score 0.
    """

    name = "career_win_rate_baseline"

    def score_race(
        self, race: dict[str, Any], feature_rows: list[dict[str, Any]]
    ) -> dict[str, float]:
        return {row["horse_id"]: float(row.get("career_win_rate") or 0.0) for row in feature_rows}


class MarketBaselinePredictor:
    """Market baseline: rank horses by the win odds the market set pre-race.

    Score is the implied win probability (1/odds) from the last odds
    snapshot available before post time. This is the bar that actually
    matters: a model that cannot out-rank the betting market has no edge,
    regardless of how it does against simpler baselines. Horses with no
    odds data score 0.
    """

    name = "market_odds_baseline"

    def score_race(
        self, race: dict[str, Any], feature_rows: list[dict[str, Any]]
    ) -> dict[str, float]:
        scores: dict[str, float] = {}
        for row in feature_rows:
            win_odds = row.get("win_odds")
            scores[row["horse_id"]] = 1.0 / float(win_odds) if win_odds else 0.0
        return scores


class CalibratedMarketBaselinePredictor:
    """Model 0 (retained variant): de-vigged + favorite-longshot calibrated.

    The walk-forward beta is inert on the JRA win pool -- both the aggregate
    ``calibration_quality`` and the longshot-tail slice show no OOS benefit over
    plain de-vigged (see market_baseline.calibration_by_prob_bin). It is kept
    because the exotic-pricing frontier (trifecta/trio) compounds probabilities
    across the field, where a residual bias correction may yet matter; the
    active win-pool baseline is :class:`DeviggedMarketBaselinePredictor`.
    """

    name = "calibrated_market_baseline"

    def score_race(
        self, race: dict[str, Any], feature_rows: list[dict[str, Any]]
    ) -> dict[str, float]:
        return {
            row["horse_id"]: float(row.get("calibrated_market_prob") or 0.0)
            for row in feature_rows
        }


class DeviggedMarketBaselinePredictor:
    """Model 0 (active): plain within-race de-vigged win probability.

    Scores by ``devigged_market_prob``. This is the simpler, equally-good
    baseline now that the favorite-longshot beta has been measured inert on the
    win pool (aggregate and tail). The calibrated predictor and the beta
    machinery are retained for the exotic frontier, so this is the default only
    for win/place ROI.
    """

    name = "devigged_market_baseline"

    def score_race(
        self, race: dict[str, Any], feature_rows: list[dict[str, Any]]
    ) -> dict[str, float]:
        return {
            row["horse_id"]: float(row.get("devigged_market_prob") or 0.0)
            for row in feature_rows
        }


class UniformPredictor:
    """Null baseline: no signal at all.

    Every horse scores 0, so ranking falls back to the engine's
    deterministic tiebreak (ascending ``horse_id``). Useful as a sanity
    floor: any predictor that cannot beat this is worthless.
    """

    name = "uniform_baseline"

    def score_race(
        self, race: dict[str, Any], feature_rows: list[dict[str, Any]]
    ) -> dict[str, float]:
        return {row["horse_id"]: 0.0 for row in feature_rows}
