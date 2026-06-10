from __future__ import annotations

from keibamon_core.schemas import SubjectiveAnnotation


APPROVED_PROXY_LABELS = {
    "paddock_agitation",
    "gate_behavior",
    "sweating",
    "poor_start_history",
    "equipment_change",
    "layoff_context",
    "travel_stress_indicator",
    "stable_comment",
    "article_sentiment",
}


def validate_subjective_annotation(annotation: SubjectiveAnnotation) -> None:
    if annotation.label not in APPROVED_PROXY_LABELS:
        raise ValueError(f"Unsupported subjective label: {annotation.label}")
    if not 0.0 <= annotation.confidence <= 1.0:
        raise ValueError("Annotation confidence must be between 0 and 1")
    if not annotation.evidence_uri:
        raise ValueError("Subjective annotations require evidence_uri")

