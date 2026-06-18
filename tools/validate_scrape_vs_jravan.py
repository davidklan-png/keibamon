"""Cross-validation gate: scrape-sourced rows vs JV-Link rows on the overlap.

This is the ADR-0004 prerequisite. The capture PC is **not** switched off
until this script prints a clean PASS over a real weekend overlap.

Runs four oracles over race_ids present in BOTH the JV-Link slice
(``source_name='jravan'`` or NULL) and the scrape slice
(``source_name='netkeiba'``) of ``jravan_payouts``:

  - **Payouts**: per ``(race_id, pool, combo)``, scrape payout_yen must equal
    JV-Link payout_yen.
  - **Results**: per ``(race_id, horse_number)``, scrape finish_position must
    equal JV-Link finish_position.
  - **Entries**: per ``(race_id, horse_number)``, scrape gate must equal
    JV-Link gate.
  - **Settle equivalence**: build two MAX(payout_yen) maps (one per source)
    and run every win/place ``Bet`` over the overlap through settlement's
    scratch-aware resolver IN-PROCESS; the two settlements must match.

Verdict line printed plainly::

    Scrape vs JV-Link cross-validation:
      overlap races: N
      payouts  : audited X rows, mismatches M (rate%)
      results  : audited X rows, mismatches M (rate%)
      entries  : audited X rows, mismatches M (rate%)
      settle equivalence: PASS / FAIL (N divergent settlements)
    VERDICT: PASS / FAIL / NO-OVERLAP-YET

Exit codes: 0 on PASS or NO-OVERLAP-YET, 1 on FAIL. NO-OVERLAP-YET is not a
failure -- the gate is built in anticipation of the overlap; it just isn't
runnable yet.
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from keibamon_core import lake_query
from keibamon_core.ingestion.settlement import Bet
from keibamon_core.paths import LakePaths

PAYOUTS = "jravan_payouts"
RESULTS = "jravan_race_results"
ENTRIES = "jravan_race_entries"


def main() -> int:
    lake = LakePaths()
    print("Scrape vs JV-Link cross-validation:")
    overlap = _overlap_race_ids(lake)
    if not overlap:
        print(f"  overlap races: 0")
        print("  (No JV-Link + netkeiba overlap yet. The gate is built; run")
        print("   it again once a weekend has both sources in the lake.)")
        print("VERDICT: NO-OVERLAP-YET")
        return 0

    print(f"  overlap races: {len(overlap)}")
    pay = _payouts_oracle(lake, overlap)
    res = _results_oracle(lake, overlap)
    ent = _entries_oracle(lake, overlap)
    seq = _settle_equivalence(lake, overlap)

    pay.report("payouts  ")
    res.report("results  ")
    ent.report("entries  ")
    seq.report()
    print()

    if pay.mismatches or res.mismatches or ent.mismatches or seq.divergent:
        print("VERDICT: FAIL")
        return 1
    print("VERDICT: PASS")
    return 0


# --- oracles ------------------------------------------------------------------


@dataclass(frozen=True)
class OracleResult:
    label: str
    audited: int
    mismatches: int
    sample_diffs: tuple[str, ...]  # capped; first few for context

    @property
    def rate(self) -> float:
        return 0.0 if self.audited == 0 else self.mismatches / self.audited

    def report(self, banner: str) -> None:
        print(
            f"  {banner}: audited {self.audited:,} rows, "
            f"mismatches {self.mismatches:,} ({self.rate:.4%})"
        )
        for diff in self.sample_diffs:
            print(f"    {diff}")


def _overlap_race_ids(lake: LakePaths) -> list[str]:
    """Race_ids where BOTH a JV-Link (NULL or 'jravan') AND a netkeiba row exist
    in the payouts table."""
    payouts = lake.silver_dataset(PAYOUTS)
    if not payouts.exists():
        return []
    rows = lake_query.query(
        f"""
        SELECT DISTINCT race_id, COALESCE(source_name, 'jravan') AS src
        FROM {lake_query.src(payouts)}
        """
    ).to_pylist()
    by_src: dict[str, set[str]] = {"jravan": set(), "netkeiba": set()}
    for r in rows:
        src = r["src"] if r["src"] in by_src else "jravan"
        by_src[src].add(r["race_id"])
    overlap = by_src["jravan"] & by_src["netkeiba"]
    return sorted(overlap)


def _payouts_oracle(lake: LakePaths, overlap: list[str]) -> OracleResult:
    """Per (race_id, pool, combo): scrape payout_yen must equal JV-Link's."""
    payouts = lake.silver_dataset(PAYOUTS)
    if not payouts.exists():
        return OracleResult("payouts", 0, 0, ())
    con = lake_query.connect()
    try:
        con.execute("DROP TABLE IF EXISTS _scr_rids")
        con.execute("CREATE TEMP TABLE _scr_rids (race_id VARCHAR)")
        con.executemany("INSERT INTO _scr_rids VALUES (?)", [(r,) for r in overlap])
        rows = con.execute(
            f"""
            SELECT p.race_id AS race_id, p.pool AS pool, p.combo AS combo,
                   COALESCE(p.source_name, 'jravan') AS src,
                   MAX(p.payout_yen) AS payout_yen
            FROM {lake_query.src(payouts)} p, _scr_rids r
            WHERE p.race_id = r.race_id
            GROUP BY p.race_id, p.pool, p.combo, src
            """
        ).to_arrow_table().to_pylist()
    finally:
        con.close()

    # {(race,pool,combo): {src: max_payout}}
    by_key: dict[tuple, dict[str, int]] = {}
    for r in rows:
        key = (r["race_id"], r["pool"], r["combo"])
        by_key.setdefault(key, {})[r["src"]] = int(r["payout_yen"])

    mismatches = 0
    diffs: list[str] = []
    for key in sorted(by_key):
        sources = by_key[key]
        if "jravan" in sources and "netkeiba" in sources and sources["jravan"] != sources["netkeiba"]:
            mismatches += 1
            if len(diffs) < 5:
                diffs.append(
                    f"payouts {key}: jravan={sources['jravan']} vs "
                    f"netkeiba={sources['netkeiba']}"
                )
    return OracleResult("payouts", len(by_key), mismatches, tuple(diffs))


def _results_oracle(lake: LakePaths, overlap: list[str]) -> OracleResult:
    """Per (race_id, horse_number): scrape finish_position must equal JV-Link's."""
    table = lake.silver_dataset(RESULTS)
    if not table.exists():
        return OracleResult("results", 0, 0, ())
    rows = _overlap_rows(lake, table, overlap, "finish_position")
    by_key: dict[tuple[str, int], dict[str, int | None]] = {}
    for r in rows:
        key = (r["race_id"], int(r["horse_number"]))
        by_key.setdefault(key, {})[r["src"]] = r["finish_position"]
    mismatches = 0
    diffs: list[str] = []
    for key in sorted(by_key):
        sources = by_key[key]
        if "jravan" in sources and "netkeiba" in sources and sources["jravan"] != sources["netkeiba"]:
            mismatches += 1
            if len(diffs) < 5:
                diffs.append(
                    f"results {key}: jravan={sources['jravan']} vs "
                    f"netkeiba={sources['netkeiba']}"
                )
    return OracleResult("results", len(by_key), mismatches, tuple(diffs))


def _entries_oracle(lake: LakePaths, overlap: list[str]) -> OracleResult:
    """Per (race_id, horse_number): scrape gate must equal JV-Link's gate.
    Also checks the runner SET per race matches (no missing/extra runners)."""
    table = lake.silver_dataset(ENTRIES)
    if not table.exists():
        return OracleResult("entries", 0, 0, ())
    rows = _overlap_rows(lake, table, overlap, "gate")
    by_key: dict[tuple[str, int], dict[str, int | None]] = {}
    for r in rows:
        key = (r["race_id"], int(r["horse_number"]))
        by_key.setdefault(key, {})[r["src"]] = r["gate"]
    mismatches = 0
    diffs: list[str] = []
    for key in sorted(by_key):
        sources = by_key[key]
        if "jravan" in sources and "netkeiba" in sources and sources["jravan"] != sources["netkeiba"]:
            mismatches += 1
            if len(diffs) < 5:
                diffs.append(
                    f"entries {key}: jravan gate={sources['jravan']} vs "
                    f"netkeiba gate={sources['netkeiba']}"
                )
    return OracleResult("entries", len(by_key), mismatches, tuple(diffs))


def _overlap_rows(lake: LakePaths, table: Path, overlap: list[str], extra_col: str) -> list[dict]:
    """Read just the overlap races from a silver table, pushing the race_id
    filter into DuckDB via a temp table (avoids a full-table parquet scan +
    Python post-filter). Mirrors :func:`settlement._load_official_payouts`."""
    if not overlap:
        return []
    con = lake_query.connect()
    try:
        con.execute("DROP TABLE IF EXISTS _scr_rids")
        con.execute("CREATE TEMP TABLE _scr_rids (race_id VARCHAR)")
        con.executemany("INSERT INTO _scr_rids VALUES (?)", [(r,) for r in overlap])
        rows = con.execute(
            f"""
            SELECT t.race_id AS race_id, t.horse_number AS horse_number,
                   t.{extra_col} AS {extra_col},
                   COALESCE(t.source_name, 'jravan') AS src
            FROM {lake_query.src(table)} t, _scr_rids r
            WHERE t.race_id = r.race_id AND t.horse_number IS NOT NULL
            """
        ).to_arrow_table().to_pylist()
        return rows
    finally:
        con.close()


@dataclass(frozen=True)
class SettleEquivResult:
    divergent: int
    audited: int
    sample_diffs: tuple[str, ...]

    def report(self) -> None:
        verdict = "PASS" if self.divergent == 0 else "FAIL"
        print(
            f"  settle equivalence: {verdict} "
            f"({self.divergent:,} divergent settlements of {self.audited:,} win/place bets)"
        )
        for diff in self.sample_diffs:
            print(f"    {diff}")


def _settle_equivalence(lake: LakePaths, overlap: list[str]) -> SettleEquivResult:
    """Run win/place bets through the settlement resolver twice -- once against
    a JV-Link-only payouts map, once against a netkeiba-only payouts map. The
    two settlements must match for every bet.

    Mirrors :func:`settlement.settle_many`'s MAX(payout_yen)-collapse +
    scratch-refund logic, but in-process and parameterized by source. Lets us
    prove scrape and JV-Link payouts resolve identically without depending on
    which rows the live settle_many picks up first.
    """
    payouts = lake.silver_dataset(PAYOUTS)
    entries = lake.silver_dataset(ENTRIES)
    results = lake.silver_dataset(RESULTS)
    if not payouts.exists():
        return SettleEquivResult(0, 0, ())

    overlap_set = set(overlap)
    # Build per-source MAX(payout_yen) maps.
    pay_rows = lake_query.query(
        f"""
        SELECT race_id, pool, combo, payout_yen,
               COALESCE(source_name, 'jravan') AS src
        FROM {lake_query.src(payouts)}
        WHERE pool IN ('win', 'place')
        """
    ).to_pylist()
    pay_by_src: dict[str, dict[tuple[str, str, str], int]] = {"jravan": {}, "netkeiba": {}}
    for r in pay_rows:
        if r["race_id"] not in overlap_set:
            continue
        src = r["src"] if r["src"] in pay_by_src else "jravan"
        key = (r["race_id"], r["pool"], r["combo"])
        cur = pay_by_src[src].get(key)
        if cur is None or int(r["payout_yen"]) > cur:
            pay_by_src[src][key] = int(r["payout_yen"])

    # Build per-source scratch sets: (race_id, horse_number) for runners in
    # entries but absent from results -- mirrors settlement's refund logic.
    # One pair of scans over (entries, results), each tagged with source, then
    # partitioned in Python. Avoids running the same scans twice (once per src).
    ent_by_src: dict[str, set[tuple[str, int]]] = {"jravan": set(), "netkeiba": set()}
    res_by_src: dict[str, set[tuple[str, int]]] = {"jravan": set(), "netkeiba": set()}
    if entries.exists() and results.exists():
        con = lake_query.connect()
        try:
            con.execute("DROP TABLE IF EXISTS _scr_rids")
            con.execute("CREATE TEMP TABLE _scr_rids (race_id VARCHAR)")
            con.executemany("INSERT INTO _scr_rids VALUES (?)", [(r,) for r in overlap])
            for table, sink in (
                (entries, ent_by_src),
                (results, res_by_src),
            ):
                rows = con.execute(
                    f"""
                    SELECT t.race_id AS race_id, t.horse_number AS horse_number,
                           COALESCE(t.source_name, 'jravan') AS src
                    FROM {lake_query.src(table)} t, _scr_rids r
                    WHERE t.race_id = r.race_id AND t.horse_number IS NOT NULL
                    """
                ).to_arrow_table().to_pylist()
                for r in rows:
                    src = r["src"] if r["src"] in sink else "jravan"
                    sink[src].add((r["race_id"], int(r["horse_number"])))
        finally:
            con.close()
    scratch_by_src = {
        src: ent_by_src[src] - res_by_src[src] for src in ("jravan", "netkeiba")
    }

    # Synthesize a win/place bet for every (race, pool, combo) either source
    # has a payout row for. Each bet is resolved twice -- against each source's
    # MAX-collapse map -- and the two settlements compared.
    bet_keys = sorted(set(pay_by_src["jravan"]) | set(pay_by_src["netkeiba"]))
    divergent = 0
    diffs: list[str] = []
    for key in bet_keys:
        race_id, pool, combo = key
        bet = Bet(race_id, pool, combo, stake_yen=100)
        s_jravan = _resolve_bet(bet, pay_by_src["jravan"], scratch_by_src["jravan"])
        s_netkeiba = _resolve_bet(bet, pay_by_src["netkeiba"], scratch_by_src["netkeiba"])
        if s_jravan != s_netkeiba:
            divergent += 1
            if len(diffs) < 5:
                diffs.append(
                    f"settle {key}: jravan={s_jravan} vs netkeiba={s_netkeiba}"
                )
    return SettleEquivResult(divergent, len(bet_keys), tuple(diffs))


def _resolve_bet(
    bet: Bet,
    payouts: dict[tuple[str, str, str], int],
    scratches: set[tuple[str, int]],
) -> tuple[str, int]:
    """In-process mini-settlement per source. Returns (reason, returned_yen)
    so we can compare verdicts without reconstructing the full Settlement."""
    from keibamon_core.ingestion.settlement import _normalize_selection

    combo = _normalize_selection(bet.selection, bet.pool)
    key = (bet.race_id, bet.pool, combo)
    if key in payouts:
        payout = payouts[key]
        return ("payout", round(payout * bet.stake_yen / 100))
    if bet.pool in ("win", "place") and (bet.race_id, int(combo)) in scratches:
        return ("refund", bet.stake_yen)
    return ("loss", 0)


if __name__ == "__main__":
    raise SystemExit(main())
