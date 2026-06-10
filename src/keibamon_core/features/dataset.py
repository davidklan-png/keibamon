from __future__ import annotations

from keibamon_core.features.point_in_time import assert_point_in_time
from keibamon_core.schemas import FeatureRow


def validate_feature_rows(rows: list[FeatureRow]) -> None:
    for row in rows:
        assert_point_in_time(row)

