from __future__ import annotations

from datetime import datetime

from keibamon_core.schemas import FeatureRow


class LeakageError(ValueError):
    pass


def assert_point_in_time(row: FeatureRow) -> None:
    future_times = [value for value in row.source_available_ats if value > row.as_of_time]
    if future_times:
        raise LeakageError(
            f"Feature row {row.race_id}/{row.horse_id} uses {len(future_times)} future records"
        )


def is_available(available_at: datetime, as_of_time: datetime) -> bool:
    return available_at <= as_of_time

