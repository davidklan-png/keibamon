"""Form/context marts (Milestone 4 lookup).

Recreational horse + jockey form, built point-in-time correct from the silver
lake. These are CONTEXT to shape a user's intuition about a race -- not an edge
claim, a tip, or betting advice. See ``app_plan.md`` Milestone 4 + Guardrails.

Two single-Parquet marts under ``data/marts/``:

- ``horse_form.parquet``  -- one row per completed start (result row), enriched
  with race context, a running-style PROXY, and a descriptive market-vs-result
  tag. The API aggregates this per ``horse_name_key`` with a PIT filter.
- ``jockey_form.parquet`` -- one row per completed start (entry with a finish),
  enriched so the API can compute starts / win% / by-course / combos per
  ``jockey_id`` with a PIT filter.

Point-in-time is non-negotiable: every aggregate is "as of" the target race's
post time. The marts carry one row per past start with that start's
``available_at`` (event time = post_time||race_date, per ``jravan_silver``);
the API filters ``available_at < as_of`` so the target race and anything after
it are excluded. A leak here is a correctness bug, not a cosmetic one.
"""
from keibamon_core.marts.form import (  # noqa: F401
    HORSE_FORM_MART,
    JOCKEY_FORM_MART,
    build_form_marts,
    build_horse_card,
    build_jockey_card,
    distance_band,
    normalize_name,
    style_signal,
)
