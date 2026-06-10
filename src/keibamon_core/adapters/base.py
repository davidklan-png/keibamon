from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import Iterable

from keibamon_core.schemas import Race, RaceEntry, RaceResult


class SourceAdapter(ABC):
    source_name: str

    @abstractmethod
    def list_races(self, start: datetime, end: datetime, venue: str | None = None) -> Iterable[str]:
        raise NotImplementedError

    @abstractmethod
    def fetch_race_card(self, race_id: str) -> tuple[Race, list[RaceEntry]]:
        raise NotImplementedError

    @abstractmethod
    def fetch_result(self, race_id: str) -> list[RaceResult]:
        raise NotImplementedError

