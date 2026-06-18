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
from typing import Any

from keibamon_core.ingestion.curve_log import devig
from keibamon_core.lake import read_parquet_if_exists, write_parquet
from keibamon_core import lake_query
from keibamon_core.paths import LakePaths

MODEL_CARD_TABLE = "model_card"

# Sentinel distinguishing "caller didn't supply first_market_available_at --
# please read it from the lake" from "caller supplied None -- the market has not
# printed, the card is trivially pre-market." ``None`` alone can't tell those
# apart, and the production caller (pipeline.post) wants the lake read while
# tests want to inject the no-market case directly.
_MARKET_UNSET = object()

# Canonical read sources for the default (Model 0) flow. Predictor-specific
# feature sets can be supplied via ``feature_rows``; these are what
# ``DeviggedMarketBaselinePredictor`` consumes.
_FEATURES_GOLD = "market_baseline"          # gold feature set for Model 0
_ENTRIES_SILVER = "jravan_race_entries"     # gate / wakuban
_WIN_ODDS_SILVER = "jravan_win_place_odds"  # earliest market snapshot available_at

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
    feature_rows: list[dict[str, Any]] | None = None,
    entries: list[dict[str, Any]] | None = None,
    first_market_available_at: Any = _MARKET_UNSET,
) -> list[dict[str, Any]]:
    """Freeze our pre-market model odds for one race. Append-only, never overwrite.

    Pipeline:

      1. Read the race's gold feature rows + entries (gate/wakuban) + earliest
         market snapshot ``available_at`` columnar via ``lake_query`` -- NOT a
         list[dict] scan over whole tables (CLAUDE.md read-path rule). Each of
         the three reads is scoped to this one ``race_id``, so the result is at
         most one field of runners. Callers can override any of the three
         (``feature_rows`` / ``entries`` / ``first_market_available_at``) -- the
         tests use this to inject deterministic fixtures.
      2. Score with ``predictor.score_race(race, feature_rows)`` ->
         ``{horse_id: score}``. Map back to ``horse_number`` PER ROW (never via a
         ``{horse_id: horse_number}`` dict) so the DATA_TRAPS case
         ``horse_id='0000000000'`` -- which is non-unique within a race -- cannot
         cross-map two runners. De-vig the within-race scores to ``model_p``
         (sums to 1.0) via :func:`curve_log.devig`; ``model_fair_odds = 1 / model_p``.
      3. ``first_market_available_at`` is the earliest win-odds ``available_at``
         for the race (NULL if the market has not printed -> the card is
         trivially pre-market).
      4. ``posted_before_market`` per ADR-0003 D3 (pure helper below).
         ``card_version = max(existing for race) + 1`` so re-posts append.
      5. ``write_parquet`` append to ``lake.silver_table(MODEL_CARD_TABLE)``;
         prior rows are read, kept verbatim, and re-read after the write to
         assert none mutated (D2 immutability, runtime-checked).

    Returns the new rows it wrote (for the dashboard push and tests).
    """
    posted_at = _as_utc(posted_at) if posted_at else datetime.now(timezone.utc)
    lake_paths: LakePaths = lake  # the Any-typed param is the lake paths object

    # 1. Pull this race's inputs. Each read is a WHERE race_id = ? filter on a
    #    partitioned dataset, so DuckDB pushes the filter down -- this is NOT a
    #    whole-table list[dict] scan.
    if feature_rows is None:
        feature_rows = _read_feature_rows(lake_paths, race_id)
    if entries is None:
        entries = _read_entries(lake_paths, race_id)
    if first_market_available_at is _MARKET_UNSET:
        first_market_available_at = _read_first_market_available_at(lake_paths, race_id)
    if not feature_rows:
        raise ValueError(
            f"freeze_model_card: no feature rows for race {race_id!r}; "
            "cannot freeze a card without runners."
        )

    # 2. Score and map back to horse_number PER ROW. The Predictor protocol
    #    returns ``{horse_id: score}``; we pair each row's own horse_id with its
    #    own horse_number so a non-unique horse_id ('0000000000') can never
    #    cross-map. Scores of 0 (UniformPredictor / missing data) survive -- the
    #    normalizer falls back to a uniform distribution in that case.
    scores = predictor.score_race({"race_id": race_id}, feature_rows)
    raw_by_hn: dict[int, float] = {}
    for row in feature_rows:
        hn = int(row["horse_number"])
        raw_by_hn[hn] = float(scores.get(row.get("horse_id"), 0.0) or 0.0)
    model_p = _within_race_normalize(raw_by_hn)
    gate_by_hn = {int(e["horse_number"]): e.get("gate") for e in entries}

    # 3-4. card_version + soft-gate flag.
    existing = read_parquet_if_exists(lake_paths.silver_table(MODEL_CARD_TABLE))
    prior_for_race = [r for r in existing if r.get("race_id") == race_id]
    prior_versions = {r.get("card_version") for r in prior_for_race}
    card_version = (max(v for v in prior_versions if v is not None) + 1) if prior_versions else 1
    pbm = posted_before_market(posted_at, first_market_available_at)

    # 5. Build the new rows; every MODEL_CARD_COLUMNS field populated.
    posted_at_iso = posted_at.isoformat()
    fma_iso = first_market_available_at.isoformat() if first_market_available_at else None
    logged_at = _utc_now_iso()
    new_rows: list[dict[str, Any]] = []
    for hn in sorted(model_p):
        p = model_p[hn]
        new_rows.append({
            "race_id": race_id,
            "horse_number": hn,
            "card_version": card_version,
            "gate": gate_by_hn.get(hn),
            "model_p": p,
            "model_fair_odds": (1.0 / p) if p > 0 else None,
            "predictor_name": getattr(predictor, "name", type(predictor).__name__),
            "posted_at": posted_at_iso,
            "first_market_available_at": fma_iso,
            "posted_before_market": pbm,
            "logged_at": logged_at,
        })

    # 6. Append-only write + D2 immutability assertion. We snapshot the prior
    #    rows for this race, append, write, then re-read and assert byte-equality
    #    on every prior row. A future re-post that mutates a v1 row fails loudly.
    prior_snapshot = [dict(r) for r in prior_for_race]
    combined = existing + new_rows
    write_parquet(combined, lake_paths.silver_table(MODEL_CARD_TABLE))
    _assert_prior_rows_unchanged(lake_paths, race_id, card_version, prior_snapshot)
    return new_rows


def _within_race_normalize(scores: dict[int, float]) -> dict[int, float]:
    """Within-race normalize predictor scores to a probability distribution.

    Reuses :func:`curve_log.devig` via the pseudo-odds trick: devig inverts its
    inputs (treating them as odds), so passing ``{h: 1/score}`` cancels the
    inversion and devig's normalization (divide by sum) applies directly to the
    scores. For Model 0 the scores are already ``devigged_market_prob`` (which
    sums to 1.0 within race in the gold), so this is essentially a no-op; for
    fundamental predictors with raw ratings it normalizes them within race. We
    do not hand-roll a third de-vig -- this is the same arithmetic devig uses.

    The all-zero case (e.g. UniformPredictor) falls back to a uniform
    distribution so the card still records one row per runner rather than none.
    """
    pseudo_odds = {h: 1.0 / s for h, s in scores.items() if s and s > 0}
    if not pseudo_odds:
        n = len(scores) or 1
        return {h: 1.0 / n for h in scores}
    probs, _ = devig(pseudo_odds)
    return probs


def _as_utc(v: datetime) -> datetime:
    return v if v.tzinfo else v.replace(tzinfo=timezone.utc)


def _read_feature_rows(lake: LakePaths, race_id: str) -> list[dict[str, Any]]:
    """This race's market_baseline gold rows (the Model 0 feature set)."""
    sql = (
        "SELECT race_id, horse_id, horse_number, win_odds, "
        "       devigged_market_prob, calibrated_market_prob, as_of_time "
        f"FROM {{t}} WHERE race_id = '{race_id}'"
    )
    arrow = lake_query.query(sql, t=lake.gold_dataset(_FEATURES_GOLD))
    return arrow.to_pylist()


def _read_entries(lake: LakePaths, race_id: str) -> list[dict[str, Any]]:
    """This race's entry rows -- we need horse_number -> gate (wakuban)."""
    sql = (
        "SELECT race_id, horse_id, horse_number, gate "
        f"FROM {{t}} WHERE race_id = '{race_id}'"
    )
    arrow = lake_query.query(sql, t=lake.silver_dataset(_ENTRIES_SILVER))
    return arrow.to_pylist()


def _read_first_market_available_at(lake: LakePaths, race_id: str) -> datetime | None:
    """Earliest win-odds available_at for the race, or None if market hasn't printed."""
    sql = (
        "SELECT MIN(available_at) AS first_at "
        f"FROM {{t}} WHERE race_id = '{race_id}' AND bet_type = 'win'"
    )
    arrow = lake_query.query(sql, t=lake.silver_dataset(_WIN_ODDS_SILVER))
    rows = arrow.to_pylist()
    if not rows or rows[0].get("first_at") is None:
        return None
    return _as_utc(rows[0]["first_at"])


def _assert_prior_rows_unchanged(
    lake: LakePaths, race_id: str, this_version: int, prior_snapshot: list[dict[str, Any]]
) -> None:
    """D2 runtime check: re-read after write, fail loudly if any prior row moved."""
    after = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
    after_prior = [
        r for r in after
        if r.get("race_id") == race_id and r.get("card_version") != this_version
    ]
    if len(after_prior) != len(prior_snapshot):
        raise RuntimeError(
            f"model_card D2 violation: race {race_id!r} had {len(prior_snapshot)} "
            f"prior rows before write, {len(after_prior)} after -- a row was added "
            "or dropped under an existing card_version."
        )
    # Order-independent compare: each prior snapshot row must still exist verbatim.
    after_by_tuple = {tuple(sorted(r.items())) for r in after_prior}
    for orig in prior_snapshot:
        if tuple(sorted(orig.items())) not in after_by_tuple:
            raise RuntimeError(
                f"model_card D2 violation: a prior row for race {race_id!r} was "
                f"mutated by the write of card_version={this_version}."
            )


def posted_before_market(posted_at: datetime, first_market_available_at: datetime | None) -> bool:
    """Provenance flag (ADR-0003 D3): is our card frozen before the market printed?

    No market snapshot yet -> trivially pre-market (True). This is pure and
    testable; the freeze path delegates the boolean to it.
    """
    if first_market_available_at is None:
        return True
    return posted_at < first_market_available_at
