from __future__ import annotations

from datetime import datetime, timezone

UTC = timezone.utc

import pytest

from keibamon_core.features.body_weight import build_body_weight_features
from keibamon_core.features.psychology import validate_subjective_annotation
from keibamon_core.features.relationship import build_relationship_features
from keibamon_core.features.travel import build_travel_features
from keibamon_core.schemas import SourceMetadata, SubjectiveAnnotation


def test_body_weight_features_flag_extreme_delta_and_ratio() -> None:
    features = build_body_weight_features(
        current_body_weight_kg=510.0,
        previous_body_weight_kg=496.0,
        carried_weight_kg=57.0,
    )

    assert features.body_weight_delta_kg == 14.0
    assert features.extreme_body_weight_delta is True
    assert round(features.carried_to_body_weight_ratio or 0, 4) == 0.1118


def test_travel_features_capture_international_recovery() -> None:
    features = build_travel_features(
        previous_country="HK",
        current_country="JP",
        distance_travelled_km=2900.0,
        days_since_previous_start=35,
        days_since_arrival=8,
        inferred_from="previous_race",
    )

    assert features.international_travel is True
    assert features.recovery_days_after_international == 8
    assert features.travel_confidence == "medium"


def test_relationship_features_compare_pair_to_baselines() -> None:
    features = build_relationship_features(
        pair_starts=10,
        pair_wins=2,
        pair_top3=5,
        horse_top3_rate=0.4,
        jockey_top3_rate=0.3,
    )

    assert features.first_time_pairing is False
    assert features.pair_top3_rate == 0.5
    assert round(features.pair_top3_lift_vs_horse or 0, 3) == 0.1
    assert round(features.pair_top3_lift_vs_jockey or 0, 3) == 0.2


def test_subjective_annotations_require_approved_labels_and_evidence() -> None:
    now = datetime(2026, 1, 1, tzinfo=UTC)
    metadata = SourceMetadata(
        source_name="analyst_notes",
        source_record_id="note-1",
        raw_uri="notes://note-1",
        content_hash="abc",
        ingested_at=now,
        published_time=now,
        available_at=now,
    )
    annotation = SubjectiveAnnotation(
        annotation_id="a1",
        race_id="r1",
        horse_id="h1",
        label="paddock_agitation",
        value="mild",
        confidence=0.7,
        evidence_uri="https://example.test/evidence",
        annotator_type="human",
        available_at=now,
        metadata=metadata,
    )

    validate_subjective_annotation(annotation)

    bad_annotation = SubjectiveAnnotation(
        annotation_id="a2",
        race_id="r1",
        horse_id="h1",
        label="looks_ready_to_win",
        value="yes",
        confidence=0.7,
        evidence_uri="https://example.test/evidence",
        annotator_type="human",
        available_at=now,
        metadata=metadata,
    )

    with pytest.raises(ValueError):
        validate_subjective_annotation(bad_annotation)

