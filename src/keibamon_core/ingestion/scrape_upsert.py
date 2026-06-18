"""Partition-aware upsert for scrape-sourced silver tables.

WHY THIS EXISTS -- the load-bearing upsert constraint.

``lake.write_dataset`` is a partition-scoped overwrite
(``existing_data_behavior='delete_matching'``). Calling it with rows for ONE
race would DELETE the entire ``(year=YYYY, venue=VV)`` partition and write
only those rows -- nuking every other race in that year+venue. This is the
catastrophic failure mode the scrape adapters must avoid: a single
``_write_silver(lake, 'jravan_race_entries', scrape_rows)`` with one race's
worth of entries rows would erase every JV-Link entry in the same year+venue
partition.

This module does per-touched-partition read-merge-write:

  1. Read existing rows from ``silver_dataset(<table>)/year=Y/venue=V/*.parquet``
  2. Merge with new rows, deduping on ``(natural_key..., available_at)`` --
     the same key + the same event time is the same row.
  3. Write the merged partition back via ``write_dataset`` (which scopes to
     that partition thanks to ``delete_matching``).

Pattern lifted from ``ingestion/curve_log.upsert_curve_log`` (single-file RMW)
but extended to the ``(year, venue)`` axis. Re-running a settled day adds zero
rows; re-running after the source republished an identical snapshot also adds
zero rows.
"""
from __future__ import annotations

from typing import Any

from keibamon_core.lake import write_dataset
from keibamon_core.paths import LakePaths


def scrape_upsert(
    lake: LakePaths,
    table: str,
    new_rows: list[dict[str, Any]],
    *,
    natural_key: tuple[str, ...],
) -> int:
    """Upsert ``new_rows`` into a ``(year, venue)``-partitioned silver dataset.

    For each touched partition:

      1. Read existing rows from ``silver_dataset(<table>)/year=Y/venue=V/``.
      2. Merge, deduping on ``(natural_key..., available_at)`` -- same business
         identity + same event time is the same row.
      3. Write the merged partition back via :func:`lake.write_dataset`.

    ``natural_key`` is the per-row business identity -- e.g.
    ``('race_id', 'horse_number')`` for entries/results or
    ``('race_id', 'pool', 'combo')`` for payouts. ``available_at`` is always
    appended to the key so a republished snapshot with a newer event time is a
    new row, not an overwrite of the old one.

    Returns the count of NEW rows added (rows whose key was not already in the
    partition). Re-running with the same input returns 0; re-running after the
    source republished an identical snapshot also returns 0. This is the
    regression-test contract for the load-bearing upsert constraint.

    The partition key columns (``year``, ``venue``) MUST be present on every
    row in ``new_rows`` -- the per-table adapter stamps them before calling.
    """
    if not new_rows:
        return 0
    lake.ensure()
    base = lake.silver_dataset(table)

    changed = 0
    for year, venue in _touched_partitions(new_rows):
        partition_rows = [
            r for r in new_rows if r.get("year") == year and r.get("venue") == venue
        ]
        existing = _read_partition(base, year, venue)
        merged, n_new = _merge_partition(existing, partition_rows, natural_key)
        if n_new > 0:
            write_dataset(merged, base)
        changed += n_new
    return changed


# --- internals ----------------------------------------------------------------


def _touched_partitions(rows: list[dict[str, Any]]) -> list[tuple[Any, Any]]:
    """Distinct ``(year, venue)`` pairs in insertion order."""
    seen: set[tuple[Any, Any]] = set()
    ordered: list[tuple[Any, Any]] = []
    for r in rows:
        key = (r.get("year"), r.get("venue"))
        if key not in seen:
            seen.add(key)
            ordered.append(key)
    return ordered


def _read_partition(base, year, venue) -> list[dict[str, Any]]:
    """Read just one partition's parquet files.

    Partition columns (``year``, ``venue``) live in the directory path, not in
    the parquet schema -- we re-inject them on read so downstream merge logic
    keys them correctly. Type matches the lake convention (year=int, venue=str).
    """
    try:
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pyarrow is required for the partition-aware upsert") from exc

    partition_dir = base / f"year={year}" / f"venue={venue}"
    if not partition_dir.exists():
        return []
    rows: list[dict[str, Any]] = []
    for path in sorted(partition_dir.glob("*.parquet")):
        for row in pq.read_table(path).to_pylist():
            row["year"] = year
            row["venue"] = venue
            rows.append(row)
    return rows


def _merge_partition(
    existing: list[dict[str, Any]],
    new_rows: list[dict[str, Any]],
    natural_key: tuple[str, ...],
) -> tuple[list[dict[str, Any]], int]:
    """Dedupe on ``(natural_key..., available_at)``; same key overwrites in place.

    Returns the merged list (which may be ``existing`` mutated in place) and the
    count of rows that were genuinely new (a key+available_at pair not present
    before). Rows whose key matches an existing row overwrite in place -- this
    includes provenance fields (raw_uri, content_hash, ingested_at), so a
    re-ingest with a different bronze artifact for the same business identity
    DOES update those fields; only the NEW-key count stays 0 so the caller can
    skip a no-op write.

    Semantic note: a row's identity is (natural_key, source_name, available_at).
    If a source republishes a row with a DIFFERENT ``available_at``, that is a
    NEW row by definition (the available_at is the load-bearing PIT instant).
    If a source republishes with the SAME ``available_at`` but different
    content, the in-memory list reflects the new content but ``n_new`` stays 0;
    callers that want to persist that kind of correction must widen the dedupe
    key (e.g. include ``content_hash``) or always write.
    """
    def row_key(r: dict[str, Any]) -> tuple:
        return tuple(r.get(k) for k in natural_key) + (r.get("available_at"),)

    index = {row_key(r): i for i, r in enumerate(existing)}
    n_new = 0
    for r in new_rows:
        k = row_key(r)
        if k in index:
            existing[index[k]] = r  # same key, last write wins
        else:
            index[k] = len(existing)
            existing.append(r)
            n_new += 1
    return existing, n_new
