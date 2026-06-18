"""settle_card.py -- settle frozen model_card rows at official payouts.

The sibling table to ``model_card`` (ADR-0003 D2). ``model_card`` is immutable;
it has no result columns and must never gain any. ``model_card_settled`` is the
join: the frozen key ``(race_id, horse_number, card_version)`` + the official
outcome (finish_position, won, top3, final_odds) + a hypothetical 1-unit win
settlement on the model's top pick per ``(race_id, card_version)``.

Discipline:

  - **model_card stays byte-identical forever.** ``settle_card`` reads it but
    never writes it; a runtime assertion re-reads after the settle write and
    fails loudly if any byte moved. Outcomes live in the sibling table.
  - **model_card_settled upserts on key** (mirroring
    ``curve_log.upsert_curve_log``). Settlement is idempotent: re-running with
    the same results replaces rows in place rather than appending duplicates.
    The frozen ``card_version`` is part of the key, so a re-posted card (new
    version) settles as a separate row -- the old version's settled row is
    preserved just like its frozen card.
  - **Official payouts only** (modeling-spine.md step 1). ``settlement.settle_many``
    looks up ``(race_id, pool, combo)`` in ``jravan_payouts`` and scales per
    100-yen stake. Missing payouts are a loss; a single-runner win/place bet on
    a scratched runner (in entries, absent from results) is a refund. We do not
    reconstruct payouts from odds.

This is calibration evidence, not a bet recommender. The lake's 6-for-6 null on
public-data edges stands; no edge is claimed here.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from keibamon_core import lake_query
from keibamon_core.ingestion.settlement import Bet, settle_many
from keibamon_core.lake import read_parquet_if_exists, write_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.weekend.model_card import MODEL_CARD_TABLE

MODEL_CARD_SETTLED_TABLE = "model_card_settled"

# One row per (race_id, horse_number, card_version). Every runner carries the
# official outcome; only the top pick (is_top_pick=True) carries the settlement
# columns -- one hypothetical 1-unit win bet per (race_id, card_version).
MODEL_CARD_SETTLED_COLUMNS = (
    "race_id", "horse_number", "card_version",   # join key to model_card
    "model_p",                                    # carried through from the frozen card
    "posted_at", "posted_before_market",          # PIT flag -- the calibration slicer
    "predictor_name",                             # provenance
    "is_top_pick",                                # True only on the bet row
    "finish_position", "won", "top3", "final_odds",  # official outcome
    "stake_yen", "payout_yen", "refund_yen", "settle_reason",  # settlement
    "settled_at",                                 # row write time (UTC iso)
)

_STAKE_YEN = 100  # hypothetical 1-unit win bet (JRA payouts are per 100 yen)


def settle_card(
    lake: Any,
    race_ids: list[str],
    *,
    results: dict[tuple[str, int], tuple[int, float | None]] | None = None,
    settle_fn: Any = None,
) -> list[dict[str, Any]]:
    """Settle frozen model_card rows for ``race_ids`` against official results.

    Returns the new / updated ``model_card_settled`` rows (one per runner per
    ``(race_id, card_version)``). Re-running with the same inputs is idempotent
    (upsert-on-key).

    Pipeline:

      1. Snapshot ``model_card`` bytes (runtime immutability assertion).
      2. Read the frozen ``model_card`` rows via ``lake_query`` scoped to
         ``race_ids`` (predicate pushdown -- not a whole-table scan).
      3. Read official results from the lake, or use the injected ``results``
         dict. Shape: ``{(canonical_race_id, horse_number): (finish_position,
         final_odds)}`` -- the same shape ``curve_log.settle_curve_records``
         consumes.
      4. Pick the top-``model_p`` runner per ``(race_id, card_version)``, build
         one ``Bet(race_id=..., pool="win", selection=<horse_number>)`` per top
         pick, and settle the batch via ``settlement.settle_many``. ``settle_fn``
         is an injection seam for tests; production resolves to ``settle_many``.
      5. Build ``model_card_settled`` rows: every runner carries the outcome
         (finish/won/top3/final_odds from results); only the top pick carries
         the settlement columns. Upsert on key.
      6. Assert ``model_card`` bytes unchanged.
    """
    lake_paths: LakePaths = lake

    # 1. Snapshot model_card bytes BEFORE we touch anything. model_card is the
    #    immutable artifact; settle_card must never write to it.
    model_card_before = read_parquet_if_exists(lake_paths.silver_table(MODEL_CARD_TABLE))

    # 2. Frozen model_card rows for these races.
    card_rows = _read_model_card_rows(lake_paths, race_ids)
    if not card_rows:
        return []

    # 3. Official results (lake read unless the caller injected them).
    if results is None:
        results = _read_results(lake_paths, set(race_ids))

    # 4. Top pick per (race_id, card_version) + one batch settle for all of them.
    top_picks = _top_picks(card_rows)  # {(race_id, card_version): row}
    bets = [
        Bet(
            race_id=row["race_id"], pool="win",
            selection=str(int(row["horse_number"])),
            stake_yen=_STAKE_YEN,
        )
        for row in top_picks.values()
    ]
    resolve = settle_fn or settle_many
    settlements = resolve(lake_paths, bets) if bets else []
    settle_by_key = dict(zip(top_picks.keys(), settlements))

    # 5. Build settled rows. Every runner carries the outcome; only the top
    #    pick carries the settlement (stake / payout / refund / reason).
    settled_at = datetime.now(timezone.utc).isoformat()
    new_rows: list[dict[str, Any]] = []
    for row in card_rows:
        rid = row["race_id"]
        hn = int(row["horse_number"])
        cv = int(row["card_version"])
        # model_card uses canonical race_ids ("jra-YYYYMMDD-jyo-NN"); no
        # crosswalk needed. The placeholder-safe results join already matched
        # on (race_id, horse_number) so two runners sharing horse_id
        # '0000000000' cannot cross-map (DATA_TRAPS).
        outcome = results.get((rid, hn))
        finish_position = outcome[0] if outcome else None
        final_odds = outcome[1] if outcome else None
        won = finish_position == 1
        top3 = finish_position is not None and finish_position <= 3
        top_pick_row = top_picks.get((rid, cv))
        is_top = bool(top_pick_row and int(top_pick_row["horse_number"]) == hn)
        settlement = settle_by_key.get((rid, cv)) if is_top else None
        new_rows.append({
            "race_id": rid,
            "horse_number": hn,
            "card_version": cv,
            "model_p": row["model_p"],
            "posted_at": row["posted_at"],
            "posted_before_market": bool(row["posted_before_market"]),
            "predictor_name": row["predictor_name"],
            "is_top_pick": is_top,
            "finish_position": finish_position,
            "won": won,
            "top3": top3,
            "final_odds": final_odds,
            "stake_yen": _STAKE_YEN if is_top else 0,
            "payout_yen": int(settlement.payout_yen) if settlement else 0,
            "refund_yen": int(settlement.refund_yen) if settlement else 0,
            "settle_reason": settlement.reason if settlement else "no_bet",
            "settled_at": settled_at,
        })

    # 6. Upsert settled rows on key + assert model_card untouched.
    _upsert_settled(lake_paths, new_rows)
    _assert_model_card_untouched(lake_paths, model_card_before)
    return new_rows


# --- internals ----------------------------------------------------------------


def _read_model_card_rows(lake: LakePaths, race_ids: list[str]) -> list[dict[str, Any]]:
    """Columnar read of frozen model_card rows for the given races."""
    if not race_ids:
        return []
    in_list = ",".join(f"'{rid}'" for rid in race_ids)
    sql = (
        "SELECT race_id, horse_number, card_version, model_p, posted_at, "
        f"posted_before_market, predictor_name FROM {{t}} WHERE race_id IN ({in_list})"
    )
    return lake_query.query(sql, t=lake.silver_table(MODEL_CARD_TABLE)).to_pylist()


def _read_results(
    lake: LakePaths, race_ids: set[str]
) -> dict[tuple[str, int], tuple[int, float | None]]:
    """``{(canon_rid, hn): (finish_position, final_odds)}`` from official results.

    Placeholder-safe: joins results to entries on ``(race_id, horse_id)`` AND
    ``(results.horse_number IS NULL OR results.horse_number = entries.horse_number)``
    so two runners in the same race sharing the placeholder id
    ``'0000000000'`` cannot cross-match (DATA_TRAPS). Mirrors the join
    ``settlement._load_scratched_runner_keys`` uses.
    """
    if not race_ids:
        return {}
    results_ds = lake.silver_dataset("jravan_race_results")
    entries_ds = lake.silver_dataset("jravan_race_entries")
    if not results_ds.exists() or not entries_ds.exists():
        return {}
    in_list = ",".join(f"'{rid}'" for rid in sorted(race_ids))
    sql = f"""
        SELECT e.race_id AS rid, e.horse_number AS hn,
               r.finish_position AS fp, r.win_odds AS fo
        FROM {{results}} r JOIN {{entries}} e
          ON r.race_id = e.race_id
         AND r.horse_id = e.horse_id
         AND (r.horse_number IS NULL OR r.horse_number = e.horse_number)
        WHERE e.race_id IN ({in_list})
    """
    tbl = lake_query.query(sql, results=results_ds, entries=entries_ds)
    out: dict[tuple[str, int], tuple[int, float | None]] = {}
    for row in tbl.to_pylist():
        if row["fp"] is None:
            continue
        out[(row["rid"], int(row["hn"]))] = (int(row["fp"]), row["fo"])
    return out


def _top_picks(
    card_rows: list[dict[str, Any]]
) -> dict[tuple[str, int], dict[str, Any]]:
    """The highest-``model_p`` runner per ``(race_id, card_version)``.

    Ties broken by smallest horse_number for determinism -- the calibration
    report must reproduce bit-for-bit across runs on the same card.
    """
    out: dict[tuple[str, int], dict[str, Any]] = {}
    for row in card_rows:
        key = (row["race_id"], int(row["card_version"]))
        cur = out.get(key)
        if cur is None:
            out[key] = row
            continue
        p_new = float(row.get("model_p") or 0.0)
        p_cur = float(cur.get("model_p") or 0.0)
        if p_new > p_cur or (
            p_new == p_cur and int(row["horse_number"]) < int(cur["horse_number"])
        ):
            out[key] = row
    return out


def _key(r: dict[str, Any]) -> tuple:
    return (r["race_id"], int(r["horse_number"]), int(r["card_version"]))


def _upsert_settled(lake: LakePaths, new_rows: list[dict[str, Any]]) -> None:
    """Upsert on ``(race_id, horse_number, card_version)``; idempotent re-settle.

    Mirrors ``curve_log.upsert_curve_log``'s shape (read-modify-write on the
    single parquet file). Existing rows whose key matches a new row are
    replaced; all others are kept verbatim. The frozen ``card_version`` is part
    of the key, so an old version's settled row survives a re-post's settle.
    """
    if not new_rows:
        return
    existing = read_parquet_if_exists(lake.silver_table(MODEL_CARD_SETTLED_TABLE))
    new_keys = {_key(r) for r in new_rows}
    keep = [r for r in existing if _key(r) not in new_keys]
    combined = keep + new_rows
    combined.sort(key=lambda r: (r["race_id"], int(r["card_version"]), int(r["horse_number"])))
    write_parquet(combined, lake.silver_table(MODEL_CARD_SETTLED_TABLE))


def _assert_model_card_untouched(
    lake: LakePaths, before: list[dict[str, Any]]
) -> None:
    """Runtime D2 check: re-read model_card after the settle write, fail loudly
    if any byte moved. model_card is immutable; outcomes live in the sibling."""
    after = read_parquet_if_exists(lake.silver_table(MODEL_CARD_TABLE))
    if after != before:
        raise RuntimeError(
            "model_card D2 violation: settle_card mutated model_card rows. "
            "model_card is immutable; outcomes live in model_card_settled."
        )
