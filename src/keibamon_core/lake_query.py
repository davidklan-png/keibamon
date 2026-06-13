"""DuckDB-backed read path for the lake -- the scalable alternative to
``lake.read_parquet`` (which fully materializes a table as ``list[dict]``).

Why this exists
---------------
The current hot loops (backtest feature load, gold build, cross-checks) read
WHOLE tables into Python dicts and join them in Python. That caps the lake at
"fits in RAM as dicts" -- a ceiling we already hit (OOM on 1.47M mining rows).

DuckDB reads Parquet lazily and columnar: filters, joins, ordering and grouping
run inside the engine, and only the rows a loop actually needs cross into
Python. Same Parquet files, same medallion layout -- only the access path
changes. This module is additive; nothing in ``lake.py`` is removed, so callers
migrate one hot loop at a time.

Entry points
------------
- ``query()``      run SQL over lake Parquet, get back an Arrow table.
- ``iter_groups()``  stream a key-ordered query one group at a time, so peak
  Python memory is ~one group, not the whole result. This is the primitive the
  backtest feature load needs: write the race join as SQL ``ORDER BY race_id``
  and score each race as its rows arrive.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any, Iterator

from keibamon_core.paths import LakePaths  # noqa: F401  (re-exported for callers)


def connect():
    """A fresh in-process DuckDB connection. Cheap; one per task is fine."""
    try:
        import duckdb
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("duckdb is required for the query read path") from exc
    return duckdb.connect()


# Pinned partition-column types so jyo codes keep leading zeros / stay strings
# (lake convention: year=int, venue=string). See lake.write_dataset.
_HIVE = "hive_partitioning=true, hive_types={'year': 'INTEGER', 'venue': 'VARCHAR'}"


def src(path: Path) -> str:
    """A ``read_parquet`` source expression. Handles three forms:

    - a single ``.parquet`` file       -> plain read
    - a Hive-partitioned dataset dir    -> recursive read with pinned year/venue
    - an explicit glob                  -> recursive read, union_by_name
    """
    p = Path(path)
    posix = p.as_posix()
    if any(ch in posix for ch in "*?["):
        return f"read_parquet('{posix}', union_by_name=true)"
    if p.is_dir():  # partitioned dataset
        glob = (p / "**" / "*.parquet").as_posix()
        return f"read_parquet('{glob}', {_HIVE}, union_by_name=true)"
    return f"read_parquet('{posix}')"


def query(sql_template: str, con=None, **tables: Path):
    """Run ``sql_template`` and return an Arrow table.

    Reference lake tables in the SQL by ``{name}`` placeholders; pass each as a
    keyword whose value is the Parquet Path::

        query("SELECT surface, count(*) n FROM {races} GROUP BY surface",
              races=lake.silver_table("jravan_races"))
    """
    owned = con is None
    con = con or connect()
    try:
        sql = _expand(sql_template, tables)
        return _to_arrow(con.execute(sql))
    finally:
        if owned:
            con.close()


def _expand(sql_template: str, tables: dict) -> str:
    """Substitute ``{name}`` table placeholders, or pass the SQL through untouched
    when no tables are given. Skipping ``str.format`` when there is nothing to
    substitute avoids choking on SQL that legitimately contains braces (e.g. a
    ``read_parquet(..., hive_types={'year': 'INTEGER'})`` expression or a DuckDB
    struct/map literal)."""
    if not tables:
        return sql_template
    return sql_template.format(**{k: src(v) for k, v in tables.items()})


def _to_arrow(result):
    """Arrow table from a DuckDB result, across API renames (1.3 -> 1.5)."""
    fn = getattr(result, "to_arrow_table", None) or result.fetch_arrow_table
    return fn()


def iter_groups(
    sql_template: str,
    key: str = "race_id",
    con=None,
    batch_rows: int = 50_000,
    **tables: Path,
) -> Iterator[tuple[Any, list[dict[str, Any]]]]:
    """Stream a key-ordered query, yielding ``(key_value, [row, ...])`` per group.

    ``sql_template`` MUST order by ``key`` (within any other ordering) so a
    group's rows are contiguous. Rows arrive as Arrow record batches and are
    regrouped on the fly, so peak Python memory is ~one batch + one group --
    independent of total table size. Use ``{name}`` placeholders for lake tables.
    """
    owned = con is None
    con = con or connect()
    try:
        sql = _expand(sql_template, tables)
        result = con.execute(sql)

        current_key = _UNSET = object()
        bucket: list[dict[str, Any]] = []
        if hasattr(result, "to_arrow_reader"):           # duckdb >= 1.3
            batches = (b.to_pylist() for b in result.to_arrow_reader(batch_rows))
        elif hasattr(result, "fetch_record_batch"):      # older duckdb
            batches = (b.to_pylist() for b in result.fetch_record_batch(batch_rows))
        else:  # pragma: no cover - last-resort fallback
            batches = (result.fetch_arrow_table().to_pylist(),)

        for rows in batches:
            for row in rows:
                k = row[key]
                if current_key is _UNSET:
                    current_key = k
                elif k != current_key:
                    yield current_key, bucket
                    bucket = []
                    current_key = k
                bucket.append(row)
        if current_key is not _UNSET:
            yield current_key, bucket
    finally:
        if owned:
            con.close()
