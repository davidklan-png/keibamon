"""Pari-mutuel settlement against official JRA-VAN payouts.

The rule is simple and non-negotiable for backtests: historical bets settle at
the official payout table, never at odds observed before the race. Payout rows
already encode dead-heats and special cases; this module just maps a hypothetical
selection to the correct official row and handles single-runner refunds when a
runner did not start.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

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
    """Settle one bet using official final payout rows.

    JRA payout amounts are per 100 yen stake. A missing payout row is a loss
    unless this is a single-runner win/place bet whose selected runner has no
    result row, which indicates a scratch/refund in the available silver model.
    """
    combo = _normalize_selection(bet.selection, bet.pool)
    official = _official_payout(lake, bet.race_id, bet.pool, combo)
    if official is not None:
        return Settlement(
            payout_yen=round(official * bet.stake_yen / 100),
            official_payout_yen=official,
            reason="official_payout",
        )

    if bet.pool in ("win", "place") and _is_refunded_single_runner(lake, bet.race_id, combo):
        return Settlement(payout_yen=0, refund_yen=bet.stake_yen, reason="refund")

    return Settlement(payout_yen=0, reason="loss")


def _official_payout(lake: LakePaths, race_id: str, pool: str, combo: str) -> int | None:
    if not lake.silver_dataset("jravan_payouts").exists():
        return None
    sql = f"""
    SELECT payout_yen
    FROM {lake_query.src(lake.silver_dataset("jravan_payouts"))}
    WHERE race_id = {_sql(race_id)}
      AND pool = {_sql(pool)}
      AND combo = {_sql(combo)}
    ORDER BY payout_yen DESC
    LIMIT 1
    """
    rows = lake_query.query(sql).to_pylist()
    return int(rows[0]["payout_yen"]) if rows else None


def _is_refunded_single_runner(lake: LakePaths, race_id: str, combo: str) -> bool:
    if not lake.silver_dataset("jravan_race_entries").exists():
        return False
    horse_number = int(combo)
    result_source = (
        lake_query.src(lake.silver_dataset("jravan_race_results"))
        if lake.silver_dataset("jravan_race_results").exists()
        else "(SELECT NULL::VARCHAR AS race_id, NULL::VARCHAR AS horse_id WHERE false)"
    )
    sql = f"""
    SELECT
        COUNT(*) AS entries,
        COUNT(rr.race_id) AS results
    FROM {lake_query.src(lake.silver_dataset("jravan_race_entries"))} en
    LEFT JOIN {result_source} rr
      ON rr.race_id = en.race_id
     AND rr.horse_id = en.horse_id
    WHERE en.race_id = {_sql(race_id)}
      AND en.horse_number = {horse_number}
    """
    row = lake_query.query(sql).to_pylist()[0]
    return row["entries"] > 0 and row["results"] == 0


def _normalize_selection(selection: str, pool: str) -> str:
    parts = [p for p in str(selection).replace("-", " ").split() if p]
    if pool in ("win", "place"):
        return f"{int(parts[0]):02d}"
    return "-".join(f"{int(p):02d}" for p in parts)


def _sql(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"
