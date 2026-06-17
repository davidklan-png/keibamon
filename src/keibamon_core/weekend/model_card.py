"""model_card.py -- freeze OUR model's fair-odds, pre-market, as immutable evidence.

This is the calibration spine (ADR-0003 D2). It is the deliberate twin of
``curve_log``: where ``curve_log`` freezes the *market* odds curve at a decision
time, ``model_card`` freezes *our* pre-market belief -- one row per runner, our
win probability and fair odds, the gate, a ``posted_at`` stamp, and the
``posted_before_market`` provenance flag.

Two rules make the dataset trustworthy; both are non-negotiable:

  1. **Immutable, append-only.** A posted card is never overwritten. Re-posting
     writes a new ``card_version`` row; the original pre-market belief is
     preserved verbatim. The entire value of the table is that each row records
     what we believed at a fixed instant -- an in-place edit silently destroys
     the comparison this table exists to make.

  2. **Soft pre-market gate (ADR-0003 D3).** We ALWAYS write the card, even if it
     lands after the market prints, and stamp ``posted_before_market`` =
     (``posted_at`` < the first market snapshot's ``available_at`` for the race).
     Calibration filters on that flag downstream; a late run yields a *flagged*
     row, never *no* row. PIT correctness is enforced at analysis time, not by
     refusing to capture.

The honest verdict -- where and how much our model diverges from the market --
comes later, over many weekends, by joining settled ``model_card`` rows to
``curve_log``/results and grouping by ``posted_before_market``. One card proves
nothing; this just makes every card count. No edge is claimed (the lake's
6-for-6 null stands); divergence is measured, never bet.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

MODEL_CARD_TABLE = "model_card"

# One row per (race_id, horse_number, card_version). Append-only: re-posting a
# race bumps card_version, never mutates an existing row.
MODEL_CARD_COLUMNS = (
    "race_id", "horse_number",
    "card_version",                 # bumped per re-post; 1 on first freeze
    "gate",                         # wakuban / post position from entries
    "model_p",                      # our de-vigged win probability for the runner
    "model_fair_odds",             # 1 / model_p (decimal), the "our odds" we post
    "predictor_name",              # which Predictor produced model_p (provenance)
    "posted_at",                    # when WE froze this belief (UTC iso)
    "first_market_available_at",   # earliest market snapshot available_at, or NULL
    "posted_before_market",        # bool: posted_at < first_market_available_at
    "logged_at",                   # row write time (UTC iso)
)


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def freeze_model_card(
    lake: Any,
    race_id: str,
    *,
    predictor: Any,
    posted_at: datetime | None = None,
) -> list[dict[str, Any]]:
    """Freeze our pre-market model odds for one race. Append-only, never overwrite.

    STUB (ADR-0003). Intended shape, to be implemented on the Mac (venv64):

      1. Read the race's gold feature rows + entries (gate/wakuban) columnar via
         ``lake_query`` -- NOT a list[dict] scan (CLAUDE.md read-path rule).
      2. Score with ``predictor.score_race(...)`` -> per-runner score; de-vig
         within race to get ``model_p`` (sums to 1.0). Reuse the de-vig logic in
         ``ingestion/market_baseline`` so our probs are calibrated the same way
         the market baseline is. ``model_fair_odds = 1 / model_p``.
      3. Look up the earliest market snapshot ``available_at`` for the race from
         ``odds_snapshots`` (NULL if the market has not printed yet -> then the
         card is trivially pre-market).
      4. Set ``posted_before_market`` per ADR-0003 D3. Compute ``card_version`` as
         max(existing for race) + 1 so re-posts append, never overwrite.
      5. ``write_parquet`` append to the ``model_card`` table; assert no existing
         (race_id, horse_number, card_version) row is mutated.

    Returns the rows it wrote (for the dashboard push and tests).
    """
    raise NotImplementedError(
        "freeze_model_card is a stub; implement on the Mac per ADR-0003 D2/D3."
    )


def posted_before_market(posted_at: datetime, first_market_available_at: datetime | None) -> bool:
    """Provenance flag (ADR-0003 D3): is our card frozen before the market printed?

    No market snapshot yet -> trivially pre-market (True). This is pure and
    testable; the freeze path delegates the boolean to it.
    """
    if first_market_available_at is None:
        return True
    return posted_at < first_market_available_at
