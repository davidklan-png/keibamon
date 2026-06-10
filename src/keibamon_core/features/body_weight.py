from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class BodyWeightFeatures:
    current_body_weight_kg: float | None
    body_weight_delta_kg: float | None
    body_weight_delta_pct: float | None
    carried_to_body_weight_ratio: float | None
    extreme_body_weight_delta: bool


def build_body_weight_features(
    current_body_weight_kg: float | None,
    previous_body_weight_kg: float | None,
    carried_weight_kg: float | None,
    extreme_delta_kg: float = 10.0,
) -> BodyWeightFeatures:
    delta = None
    delta_pct = None
    if current_body_weight_kg is not None and previous_body_weight_kg:
        delta = current_body_weight_kg - previous_body_weight_kg
        delta_pct = delta / previous_body_weight_kg

    ratio = None
    if current_body_weight_kg and carried_weight_kg is not None:
        ratio = carried_weight_kg / current_body_weight_kg

    return BodyWeightFeatures(
        current_body_weight_kg=current_body_weight_kg,
        body_weight_delta_kg=delta,
        body_weight_delta_pct=delta_pct,
        carried_to_body_weight_ratio=ratio,
        extreme_body_weight_delta=abs(delta) >= extreme_delta_kg if delta is not None else False,
    )

