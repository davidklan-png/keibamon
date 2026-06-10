from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class WeatherRequest:
    latitude: float
    longitude: float
    start: datetime
    end: datetime
    variables: tuple[str, ...] = (
        "temperature_2m",
        "relative_humidity_2m",
        "precipitation",
        "wind_speed_10m",
    )


class WeatherSourceAdapter:
    source_name = "open_meteo"

    def build_url(self, request: WeatherRequest) -> str:
        variables = ",".join(request.variables)
        start_date = request.start.date().isoformat()
        end_date = request.end.date().isoformat()
        return (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={request.latitude}"
            f"&longitude={request.longitude}"
            f"&start_date={start_date}"
            f"&end_date={end_date}"
            f"&hourly={variables}"
            "&timezone=Asia%2FTokyo"
        )

