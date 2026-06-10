from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlencode


@dataclass(frozen=True)
class NewsQuery:
    query: str
    start: datetime
    end: datetime
    max_records: int = 250


class NewsSourceAdapter:
    source_name = "gdelt"

    def build_doc_api_url(self, query: NewsQuery) -> str:
        params = {
            "query": query.query,
            "mode": "ArtList",
            "format": "json",
            "maxrecords": query.max_records,
            "startdatetime": query.start.strftime("%Y%m%d%H%M%S"),
            "enddatetime": query.end.strftime("%Y%m%d%H%M%S"),
        }
        return "https://api.gdeltproject.org/api/v2/doc/doc?" + urlencode(params)

