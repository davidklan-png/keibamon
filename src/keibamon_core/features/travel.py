from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class TravelFeatures:
    international_travel: bool
    distance_travelled_km: float | None
    days_since_previous_start: int | None
    days_since_arrival: int | None
    recovery_days_after_international: int | None
    travel_confidence: str


def build_travel_features(
    previous_country: str | None,
    current_country: str,
    distance_travelled_km: float | None,
    days_since_previous_start: int | None,
    days_since_arrival: int | None,
    inferred_from: str,
) -> TravelFeatures:
    international = previous_country is not None and previous_country != current_country
    confidence = "high" if inferred_from in {"stable", "training_center", "manual"} else "medium"
    if inferred_from == "unknown":
        confidence = "low"

    return TravelFeatures(
        international_travel=international,
        distance_travelled_km=distance_travelled_km,
        days_since_previous_start=days_since_previous_start,
        days_since_arrival=days_since_arrival,
        recovery_days_after_international=days_since_arrival if international else None,
        travel_confidence=confidence,
    )

