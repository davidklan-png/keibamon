from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RelationshipFeatures:
    pair_history_count: int
    pair_top3_rate: float | None
    pair_win_rate: float | None
    first_time_pairing: bool
    pair_top3_lift_vs_horse: float | None
    pair_top3_lift_vs_jockey: float | None


def build_relationship_features(
    pair_starts: int,
    pair_wins: int,
    pair_top3: int,
    horse_top3_rate: float | None,
    jockey_top3_rate: float | None,
) -> RelationshipFeatures:
    pair_win_rate = pair_wins / pair_starts if pair_starts else None
    pair_top3_rate = pair_top3 / pair_starts if pair_starts else None

    return RelationshipFeatures(
        pair_history_count=pair_starts,
        pair_top3_rate=pair_top3_rate,
        pair_win_rate=pair_win_rate,
        first_time_pairing=pair_starts == 0,
        pair_top3_lift_vs_horse=(
            pair_top3_rate - horse_top3_rate
            if pair_top3_rate is not None and horse_top3_rate is not None
            else None
        ),
        pair_top3_lift_vs_jockey=(
            pair_top3_rate - jockey_top3_rate
            if pair_top3_rate is not None and jockey_top3_rate is not None
            else None
        ),
    )

