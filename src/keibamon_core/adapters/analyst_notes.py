from __future__ import annotations

from dataclasses import replace

from keibamon_core.schemas import SubjectiveAnnotation


class AnalystNotesAdapter:
    source_name = "analyst_notes"

    def normalize_confidence(self, annotation: SubjectiveAnnotation) -> SubjectiveAnnotation:
        confidence = max(0.0, min(1.0, annotation.confidence))
        return replace(annotation, confidence=confidence)

