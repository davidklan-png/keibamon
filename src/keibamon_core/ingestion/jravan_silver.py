"""Build silver tables from the JRA-VAN bronze lake.

Counterpart to ``ingestion/silver.py`` (which normalizes the CSV/Netkeiba
source). This reads the raw JV-Link snapshots under ``data/raw/jravan/`` and
emits the same canonical silver Parquet tables, so JRA-VAN fundamentals and
Netkeiba market data converge on one schema and join downstream.

STATUS: scaffold. The record *header* fields (race id, horse id) are parsed and
mapped; deep fields (surface, distance, finish position, weights, times) are
gated on the JV-Data spec PDF offsets being filled into
``adapters/jravan.RECORD_LAYOUTS`` -- they are emitted as None until then and
marked TODO(spec) below. Wiring, race_id construction, and the parquet write
path are real and testable now.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from keibamon_core.adapters.jravan import (
    JravanSourceAdapter,
    going_label,
    going_wetness,
    track_code_to_surface,
    weather_label,
)
from keibamon_core.lake import write_dataset
from keibamon_core.paths import LakePaths


def _write_silver(lake: LakePaths, table: str, rows: list[dict[str, Any]]) -> None:
    """Add year/venue partition columns (derived from race_id) and write the table
    as a Hive-partitioned dataset under normalized/<table>/year=.../venue=.../."""
    for r in rows:
        # race_id == "jra-YYYYMMDD-<jyo>-<race_num>"; jyo may be alphanumeric (foreign)
        parts = r["race_id"].split("-")
        r["year"] = int(parts[1][:4])
        r["venue"] = parts[2]
    lake.ensure()
    write_dataset(rows, lake.silver_dataset(table))

SILVER_TABLES = ("jravan_races", "jravan_race_entries", "jravan_race_results")

# JRA-VAN racecourse (jyo) codes -> name. Subset; extend from the spec code table.
JYO_CODES: dict[str, str] = {
    "01": "Sapporo", "02": "Hakodate", "03": "Fukushima", "04": "Niigata",
    "05": "Tokyo", "06": "Nakayama", "07": "Chukyo", "08": "Kyoto",
    "09": "Hanshin", "10": "Kokura",
}


def _race_id(p: dict) -> str:
    """Stable race id from the JV-Data header: jra-YYYYMMDD-<jyo>-<race_num>.

    Uses the confirmed header fields (year, month_day, jyo_code, race_num), so
    it is valid now and is the join key between RA and SE rows.
    """
    return f"jra-{p['year']:04d}{p['month_day']}-{p['jyo_code']}-{int(p['race_num']):02d}"


def _race_date(p: dict) -> datetime:
    mmdd = p["month_day"]
    return datetime(p["year"], int(mmdd[:2]), int(mmdd[2:]), tzinfo=timezone.utc)


def _post_time(p: dict) -> datetime | None:
    """RA 発走時刻 'hhmm' (JST) combined with the race date -> tz-aware UTC."""
    hhmm = (p.get("post_time") or "").strip()
    if len(hhmm) != 4 or not hhmm.isdigit() or hhmm == "0000":
        return None
    d = _race_date(p)
    # hhmm is JST (UTC+9); store UTC for consistency with the rest of the lake.
    jst = d.replace(hour=int(hhmm[:2]), minute=int(hhmm[2:]))
    return jst - timedelta(hours=9)


def _meta_columns(meta: dict) -> dict[str, Any]:
    """Flatten bronze provenance (adapters.jravan parse_record `_meta`)."""
    return {
        "source_name": meta.get("source_name", "jravan"),
        "source_record_id": meta.get("source_record_id"),
        "raw_uri": meta.get("raw_uri"),
        "content_hash": meta.get("content_hash"),
        "ingested_at": meta.get("ingested_at"),
        "published_time": meta.get("published_time"),
        "available_at": meta.get("available_at"),
    }


def _race_record(p: dict) -> dict[str, Any]:
    surface = track_code_to_surface(p.get("track_code", ""))
    going_turf = going_wetness(p.get("turf_going_code"))
    going_dirt = going_wetness(p.get("dirt_going_code"))
    # surface-relevant going (the feature input): turf race -> turf going, etc.
    going_w = going_turf if surface == "turf" else going_dirt if surface == "dirt" else None
    going_code = p.get("turf_going_code") if surface == "turf" else p.get("dirt_going_code")
    return {
        "race_id": _race_id(p),
        "race_date": _race_date(p),
        "racecourse": JYO_CODES.get(p["jyo_code"], p["jyo_code"]),
        "country": "JP",
        "surface": surface,
        "distance_m": p.get("distance_m"),
        "scheduled_post_time": _post_time(p),
        "race_name": (p.get("race_name") or "").strip() or None,
        "grade_code": (p.get("grade_code") or "").strip() or None,
        "last_3f_seconds": p.get("last_3f"),
        # going + weather overlay inputs (official, race-time -- see going-handling design)
        "weather": weather_label(p.get("weather_code")),
        "going_turf": going_turf,
        "going_dirt": going_dirt,
        "going_wetness": going_w,           # surface-relevant ordinal 1(firm)-4(heavy)
        "going": going_label(going_code),   # surface-relevant label
        **_meta_columns(p["_meta"]),
    }


def _entry_record(p: dict) -> dict[str, Any]:
    bw = p.get("body_weight")  # 999=unweighable, 000=scratched -> not a real weight
    return {
        "race_id": _race_id(p),
        "horse_id": p.get("ketto_num"),
        "horse_name": (p.get("bamei") or "").strip() or None,
        "horse_number": p.get("umaban"),
        "gate": p.get("wakuban"),
        "jockey_id": (p.get("jockey_code") or "").strip() or None,
        "trainer_id": (p.get("trainer_code") or "").strip() or None,
        "carried_weight_kg": p.get("carried_weight_kg"),
        "body_weight_kg": bw if bw and bw not in (0, 999) else None,
        **_meta_columns(p["_meta"]),
    }


def _result_record(p: dict) -> dict[str, Any]:
    pos = p.get("finish_position")
    return {
        "race_id": _race_id(p),
        "horse_id": p.get("ketto_num"),
        "finish_position": pos if pos else None,  # 0 = no official placing
        "finish_time_seconds": p.get("finish_time"),
        "margin": (p.get("margin_code") or "").strip() or None,
        "win_odds": p.get("win_odds"),
        "popularity": p.get("popularity"),
        "last_3f_seconds": p.get("last_3f"),
        **_meta_columns(p["_meta"]),
    }


def _announce_at(year: int, mdhm: str) -> datetime | None:
    """O-record 発表月日時分 'MMDDhhmm' (JST, intermediate odds only) -> UTC.
    '00000000' on final/确定 odds -> None."""
    mdhm = (mdhm or "").strip()
    if len(mdhm) != 8 or not mdhm.isdigit() or mdhm == "00000000":
        return None
    mo, da, hh, mi = int(mdhm[:2]), int(mdhm[2:4]), int(mdhm[4:6]), int(mdhm[6:8])
    return datetime(year, mo, da, hh, mi, tzinfo=timezone.utc) - timedelta(hours=9)


def build_jravan_odds(
    lake: LakePaths, specs: tuple[str, ...] = ("O1",), bet_types: tuple[str, ...] = ("win", "place"),
) -> dict[str, int]:
    """Materialize JRA-VAN odds pools into a tidy long table.

    Defaults to O1 win+place -- the per-horse market-implied probability signal.
    Exotics (O2-O6) are opt-in via ``specs`` because of cardinality (O6 trifecta
    alone is ~4,900 combos/race). One row per (race, bet_type, combo, data_kubun,
    announce_time); a race can have several snapshots (中間/最終/確定 = data_kubun).
    """
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    rows: list[dict[str, Any]] = []
    want = set(bet_types)

    for spec in specs:
        for row in adapter.iter_raw(spec="RACE"):
            if row["record_id"] != spec:
                continue
            rec = JravanSourceAdapter.parse_odds_record(row)
            if rec is None:
                continue
            rid = _race_id(rec)
            announce = _announce_at(rec["year"], rec["announce_mdhm"])
            meta = _meta_columns(rec["_meta"])
            for e in rec["entries"]:
                if e["bet_type"] not in want:
                    continue
                rows.append({
                    "race_id": rid,
                    "bet_type": e["bet_type"],
                    "combo": e["combo"],                 # umaban for win/place
                    "odds": e.get("odds"),               # win/quinella/exacta/trio/trifecta
                    "odds_low": e.get("odds_low"),       # place/wide
                    "odds_high": e.get("odds_high"),
                    "popularity": e["popularity"],
                    "data_kubun": rec["data_kubun"],     # 1中間..3最終 4確定 5確定(月)
                    "announce_at": announce,
                    **meta,
                })

    rows.sort(key=lambda r: (r["race_id"], r["bet_type"], r["data_kubun"], r["combo"]))
    _write_silver(lake, "jravan_win_place_odds", rows)
    return {"jravan_win_place_odds": len(rows)}


def build_jravan_payouts(lake: LakePaths) -> dict[str, int]:
    """Materialize HR payout records into a tidy table: one row per winning
    combination per pool (race_id, pool, combo, payout_yen, popularity)."""
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    rows: list[dict[str, Any]] = []
    for row in adapter.iter_raw(spec="RACE"):
        if row["record_id"] != "HR":
            continue
        rec = JravanSourceAdapter.parse_grouped_record(row)
        if rec is None:
            continue
        rid = _race_id(rec)
        meta = _meta_columns(rec["_meta"])
        for e in rec["entries"]:
            if e.get("payout") is None:
                continue
            rows.append({
                "race_id": rid,
                "pool": e["pool"],
                "combo": e["combo"],
                "payout_yen": e["payout"],
                "popularity": e.get("popularity"),
                **meta,
            })
    rows.sort(key=lambda r: (r["race_id"], r["pool"], r["combo"]))
    _write_silver(lake, "jravan_payouts", rows)
    return {"jravan_payouts": len(rows)}


def build_jravan_mining(lake: LakePaths) -> dict[str, int]:
    """Materialize JRA-VAN mining predictions into one tidy table.

    Two model families share the table (model column distinguishes them):
      'time'  (record DM): predicted 走破タイム + confidence error band
      'score' (record TM): predicted 0-100 strength score
    NB: record IDs are inverted vs the letters -- DM=time, TM=score (see
    adapters.jravan.DATA_TRAPS['DM_vs_TM'])."""
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    rows: list[dict[str, Any]] = []
    for row in adapter.iter_raw(spec="MING"):
        if row["record_id"] not in ("DM", "TM"):
            continue
        rec = JravanSourceAdapter.parse_grouped_record(row)
        if rec is None:
            continue
        rid = _race_id(rec)
        created = _announce_at(rec["year"], rec["month_day"] + (rec.get("create_hhmm") or ""))
        meta = _meta_columns(rec["_meta"])
        for e in rec["entries"]:
            model = "time" if e["kind"] == "mining_time" else "score"
            rows.append({
                "race_id": rid,
                "horse_number": int(e["combo"]),
                "model": model,
                "pred_time_seconds": e.get("pred_time"),
                "err_plus_seconds": e.get("err_plus"),
                "err_minus_seconds": e.get("err_minus"),
                "score": e.get("score"),
                "data_kubun": rec["data_kubun"],   # 1前日 2当日 3直前 7成績
                "created_at": created,
                **meta,
            })
    rows.sort(key=lambda r: (r["race_id"], r["model"], r["horse_number"]))
    _write_silver(lake, "jravan_mining", rows)
    return {"jravan_mining": len(rows)}


def build_jravan_silver(lake: LakePaths) -> dict[str, int]:
    """Normalize the JRA-VAN bronze lake into silver Parquet tables."""
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))

    races: dict[str, dict[str, Any]] = {}   # dedupe RA by race_id (latest wins)
    entries: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []

    for row in adapter.iter_raw(spec="RACE"):
        parsed = JravanSourceAdapter.parse_record(row)
        if parsed is None:
            continue
        rec = row["record_id"]
        if rec == "RA":
            r = _race_record(parsed)
            races[r["race_id"]] = r
        elif rec == "SE":
            entries.append(_entry_record(parsed))
            results.append(_result_record(parsed))

    race_rows = sorted(races.values(), key=lambda r: (r["race_date"], r["race_id"]))
    entries.sort(key=lambda r: (r["race_id"], r["horse_number"] or 0))
    results.sort(key=lambda r: (r["race_id"], r["horse_id"] or ""))

    _write_silver(lake, "jravan_races", race_rows)
    _write_silver(lake, "jravan_race_entries", entries)
    _write_silver(lake, "jravan_race_results", results)

    return {
        "jravan_races": len(race_rows),
        "jravan_race_entries": len(entries),
        "jravan_race_results": len(results),
    }


if __name__ == "__main__":  # quick manual run: python -m keibamon_core.ingestion.jravan_silver
    import json
    lake = LakePaths()
    out = build_jravan_silver(lake)
    out.update(build_jravan_odds(lake))      # O1 win+place by default
    out.update(build_jravan_payouts(lake))   # HR payouts
    out.update(build_jravan_mining(lake))    # DM time + TM score predictions
    print(json.dumps(out, indent=2))
