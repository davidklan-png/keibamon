from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone

UTC = timezone.utc  # compatible alias for datetime.UTC (3.11+)
from typing import Literal


def utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class SourceMetadata:
    source_name: str
    source_record_id: str
    raw_uri: str
    content_hash: str
    ingested_at: datetime
    published_time: datetime | None
    available_at: datetime


@dataclass(frozen=True)
class Race:
    race_id: str
    race_date: datetime
    racecourse: str
    country: str
    surface: Literal["turf", "dirt", "synthetic", "unknown"]
    distance_m: int
    scheduled_post_time: datetime | None
    metadata: SourceMetadata


@dataclass(frozen=True)
class RaceEntry:
    race_id: str
    horse_id: str
    horse_name: str
    jockey_id: str | None
    trainer_id: str | None
    gate: int | None
    carried_weight_kg: float | None
    metadata: SourceMetadata
    horse_number: int | None = None


@dataclass(frozen=True)
class OddsSnapshot:
    """One point-in-time odds observation for a horse in a race.

    Odds are keyed by ``horse_number`` (umaban) because that is how betting
    pools identify runners; the join to ``horse_id`` happens through race
    entries once the draw is published. ``available_at`` is the official
    odds timestamp from the source; ``captured_at`` is when we polled.
    """

    race_id: str
    horse_number: int
    win_odds: float | None
    place_odds_low: float | None
    place_odds_high: float | None
    popularity: int | None
    status: str
    captured_at: datetime
    available_at: datetime
    metadata: SourceMetadata


@dataclass(frozen=True)
class RaceResult:
    race_id: str
    horse_id: str
    finish_position: int | None
    finish_time_seconds: float | None
    margin: str | None
    metadata: SourceMetadata


@dataclass(frozen=True)
class BodyWeight:
    race_id: str
    horse_id: str
    body_weight_kg: float
    body_weight_delta_kg: float | None
    available_at: datetime
    metadata: SourceMetadata


@dataclass(frozen=True)
class TravelContext:
    race_id: str
    horse_id: str
    previous_race_id: str | None
    previous_racecourse: str | None
    previous_country: str | None
    current_racecourse: str
    current_country: str
    distance_travelled_km: float | None
    days_since_previous_start: int | None
    days_since_arrival: int | None
    inferred_from: Literal["stable", "training_center", "previous_race", "manual", "unknown"]
    available_at: datetime
    metadata: SourceMetadata


@dataclass(frozen=True)
class SubjectiveAnnotation:
    annotation_id: str
    race_id: str
    horse_id: str | None
    label: str
    value: str
    confidence: float
    evidence_uri: str
    annotator_type: Literal["human", "llm", "source"]
    available_at: datetime
    metadata: SourceMetadata


@dataclass(frozen=True)
class FeatureRow:
    race_id: str
    horse_id: str
    as_of_time: datetime
    features: dict[str, float | int | str | bool | None]
    source_available_ats: tuple[datetime, ...]

