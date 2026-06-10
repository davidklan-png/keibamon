from __future__ import annotations

from datetime import datetime, timedelta, timezone

UTC = timezone.utc

import pytest

from keibamon_core.features.point_in_time import LeakageError, assert_point_in_time
from keibamon_core.schemas import FeatureRow


def test_feature_row_rejects_future_source_data() -> None:
    as_of = datetime(2026, 1, 1, tzinfo=UTC)
    row = FeatureRow(
        race_id="race-1",
        horse_id="horse-1",
        as_of_time=as_of,
        features={"win_rate": 0.2},
        source_available_ats=(as_of - timedelta(days=1), as_of + timedelta(seconds=1)),
    )

    with pytest.raises(LeakageError):
        assert_point_in_time(row)


def test_feature_row_accepts_available_source_data() -> None:
    as_of = datetime(2026, 1, 1, tzinfo=UTC)
    row = FeatureRow(
        race_id="race-1",
        horse_id="horse-1",
        as_of_time=as_of,
        features={"win_rate": 0.2},
        source_available_ats=(as_of - timedelta(days=1), as_of),
    )

    assert_point_in_time(row)

