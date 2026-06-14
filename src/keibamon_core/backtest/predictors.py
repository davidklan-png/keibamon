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
    """Model 0: de-vigged and favorite-longshot calibrated market probability."""

    name = "calibrated_market_baseline"

    def score_race(
        self, race: dict[str, Any], feature_rows: list[dict[str, Any]]
    ) -> dict[str, float]:
        return {
            row["horse_id"]: float(row.get("calibrated_market_prob") or 0.0)
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
