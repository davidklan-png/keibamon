"""Pari-mutuel settlement against official JRA-VAN payouts.

The rule is simple and non-negotiable for backtests: historical bets settle at
the official payout table, never at odds observed before the race. Payout rows
already encode dead-heats and special cases; this module just maps a hypothetical
selection to the correct official row and handles single-runner refunds when a
runner did not start.

Why a batch API
---------------
The one-bet-at-a-time path opens a fresh DuckDB connection and Parquet scan per
bet, which is ~12 ms/bet on this lake. A full payout audit (≈220K win/place
rows) at that rate is ~45 minutes, and the ROI backtest inherits the cost when
it settles one bet per race. ``settle_many`` opens one connection, materializes
the relevant payout / entry / result rows once into Python dicts, and resolves
the whole bet list in memory. ``settle`` is preserved for single-bet callers and
delegates to the batch path.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from keibamon_core import lake_query
from keibamon_core.paths import LakePaths

Pool = Literal["win", "place", "bracket_quinella", "quinella", "wide", "exacta", "trio", "trifecta"]


@dataclass(frozen=True)
class Bet:
    race_id: str
    pool: Pool
    selection: str
    stake_yen: int = 100


@dataclass(frozen=True)
class Settlement:
    payout_yen: int
    refund_yen: int = 0
    official_payout_yen: int | None = None
    reason: str = "loss"

    @property
    def returned_yen(self) -> int:
        return self.payout_yen + self.refund_yen


def settle(lake: LakePaths, bet: Bet) -> Settlement:
    """Settle one bet. Delegates to :func:`settle_many`; for many bets use that
    directly so the lake is scanned once for the whole batch."""
    return settle_many(lake, [bet])[0]


def settle_many(lake: LakePaths, bets: list[Bet]) -> list[Settlement]:
    """Settle a batch of bets using official final payout rows.

    JRA payout amounts are per 100 yen stake. A missing payout row is a loss
    unless this is a single-runner win/place bet whose selected runner has no
    result row, which indicates a scratch/refund in the available silver model.
    """
    if not bets:
        return []

    con = lake_query.connect()
    try:
        payouts = _load_official_payouts(con, lake, bets)
        outcomes: list[Settlement | None] = [None] * len(bets)
        unresolved: list[int] = []
        for i, bet in enumerate(bets):
            combo = _normalize_selection(bet.selection, bet.pool)
            key = (bet.race_id, bet.pool, combo)
            official = payouts.get(key)
            if official is not None:
                outcomes[i] = Settlement(
                    payout_yen=round(official * bet.stake_yen / 100),
                    official_payout_yen=official,
                    reason="official_payout",
                )
            elif bet.pool in ("win", "place"):
                unresolved.append(i)
            else:
                outcomes[i] = Settlement(payout_yen=0, reason="loss")

        if unresolved:
            scratch_keys = _load_scratched_runner_keys(
                con, lake, [bets[i] for i in unresolved]
            )
            for i in unresolved:
                bet = bets[i]
                combo = _normalize_selection(bet.selection, bet.pool)
                if (bet.race_id, int(combo)) in scratch_keys:
                    outcomes[i] = Settlement(
                        payout_yen=0, refund_yen=bet.stake_yen, reason="refund"
                    )
                else:
                    outcomes[i] = Settlement(payout_yen=0, reason="loss")

        return [o for o in outcomes if o is not None]
    finally:
        con.close()


def _load_official_payouts(
    con, lake: LakePaths, bets: list[Bet]
) -> dict[tuple[str, str, str], int]:
    """One scan of jravan_payouts for all bet races.

    Returns the MAX payout per (race_id, pool, combo) so a dead-heat's two
    payout rows collapse to the larger one (matching the previous ORDER BY
    DESC LIMIT 1 behavior for win/place; for win there is only one row).
    """
    table = lake.silver_dataset("jravan_payouts")
    if not table.exists():
        return {}
    race_ids = sorted({b.race_id for b in bets})
    if not race_ids:
        return {}
    con.execute("DROP TABLE IF EXISTS _settle_rids")
    con.execute("CREATE TEMP TABLE _settle_rids (race_id VARCHAR)")
    con.executemany(
        "INSERT INTO _settle_rids VALUES (?)", [(rid,) for rid in race_ids]
    )
    sql = f"""
    SELECT p.race_id AS race_id, p.pool AS pool, p.combo AS combo,
           MAX(p.payout_yen) AS payout_yen
    FROM {lake_query.src(table)} p, _settle_rids r
    WHERE p.race_id = r.race_id
    GROUP BY p.race_id, p.pool, p.combo
    """
    rows = con.execute(sql).to_arrow_table().to_pylist()
    return {(r["race_id"], r["pool"], r["combo"]): int(r["payout_yen"]) for r in rows}


def _load_scratched_runner_keys(
    con, lake: LakePaths, bets: list[Bet]
) -> set[tuple[str, int]]:
    """Set of ``(race_id, horse_number)`` for single-runner win/place bets whose
    selected runner is in entries but absent from results (= scratch/refund).

    Joins results on (race_id, horse_id) AND, when results carries
    ``horse_number``, on that too. The horse_number condition protects against
    the placeholder trap (DATA_TRAPS['SE.ketto_num=0000000000']): when several
    runners share the placeholder id, joining on horse_id alone would let one
    runner's result row satisfy the join for another runner, hiding a refund.
    """
    entries_table = lake.silver_dataset("jravan_race_entries")
    if not entries_table.exists():
        return set()
    race_ids = sorted({b.race_id for b in bets if b.pool in ("win", "place")})
    if not race_ids:
        return set()
    con.execute("DROP TABLE IF EXISTS _scratch_rids")
    con.execute("CREATE TEMP TABLE _scratch_rids (race_id VARCHAR)")
    con.executemany(
        "INSERT INTO _scratch_rids VALUES (?)", [(rid,) for rid in race_ids]
    )
    results_table = lake.silver_dataset("jravan_race_results")
    # Detect whether the results table exposes horse_number (added when
    # _result_record was upgraded to carry umaban). Pre-upgrade partitions and
    # legacy test fixtures lack it; fall back to the horse_id-only join there.
    # The horse_number branch protects against the placeholder trap
    # (DATA_TRAPS['SE.ketto_num=0000000000']); the fallback keeps old data
    # readable at the cost of that protection until the silver is rebuilt.
    has_horse_number = False
    if results_table.exists():
        schema = con.execute(
            f"DESCRIBE SELECT * FROM {lake_query.src(results_table)}"
        ).to_arrow_table().to_pylist()
        has_horse_number = any(row["column_name"] == "horse_number" for row in schema)
    if results_table.exists() and has_horse_number:
        results_select = (
            "SELECT race_id, horse_id, horse_number FROM "
            f"{lake_query.src(results_table)}"
        )
    elif results_table.exists():
        results_select = (
            "SELECT race_id, horse_id, NULL::INTEGER AS horse_number FROM "
            f"{lake_query.src(results_table)}"
        )
    else:
        results_select = (
            "SELECT NULL::VARCHAR AS race_id, NULL::VARCHAR AS horse_id, "
            "NULL::INTEGER AS horse_number WHERE false"
        )
    sql = f"""
    WITH rids AS (SELECT race_id FROM _scratch_rids),
    en AS (
        SELECT en.race_id AS race_id, en.horse_id AS horse_id, en.horse_number AS horse_number
        FROM {lake_query.src(entries_table)} en, rids
        WHERE en.race_id = rids.race_id
    ),
    rr AS (
        SELECT rr.race_id AS race_id, rr.horse_id AS horse_id, rr.horse_number AS horse_number
        FROM ({results_select}) rr, rids
        WHERE rr.race_id = rids.race_id
    )
    SELECT en.race_id AS race_id, en.horse_number AS horse_number
    FROM en
    LEFT JOIN rr
      ON rr.race_id = en.race_id
     AND rr.horse_id = en.horse_id
     AND (rr.horse_number IS NULL OR rr.horse_number = en.horse_number)
    WHERE rr.race_id IS NULL
    """
    rows = con.execute(sql).to_arrow_table().to_pylist()
    return {(r["race_id"], int(r["horse_number"])) for r in rows if r["horse_number"] is not None}


def _normalize_selection(selection: str, pool: str) -> str:
    """Normalize a bet selection into the canonical payout-table combo form.

    Payout combos are stored as concatenated digits (no dashes):
    - win/place:   ``'01'``
    - quinella/wide: ``'0108'`` (2-digit per horse, ascending)
    - exacta:       ``'1109'`` (2-digit per horse, finishing order)
    - trifecta:     ``'110910'`` (3 x 2-digit, finishing order)
    - trio:         ``'040507'`` (3 x 2-digit, ascending)
    - bracket_quinella: ``'23'`` (single-digit brackets, ascending)

    Callers may pass either the payout-format string directly (passthrough) or
    a dash-separated form (``'01-08'`` -> ``'0108'``). The single-int path that
    used to mangle ``'0208'`` quinella into ``'208'`` is gone -- exotics are
    multi-digit by construction and any concatenated digit string is already
    canonical.
    """
    parts = [p for p in str(selection).replace("-", " ").split() if p]
    if pool in ("win", "place"):
        return f"{int(parts[0]):02d}"
    if len(parts) == 1:
        return parts[0]
    return "".join(f"{int(p):02d}" for p in parts)


def _sql(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
