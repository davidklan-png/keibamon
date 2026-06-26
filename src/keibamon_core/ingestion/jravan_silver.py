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
from pathlib import Path
from typing import Any

from keibamon_core.adapters.jravan import (
    JravanSourceAdapter,
    going_label,
    going_wetness,
    track_code_to_surface,
    weather_label,
)
from keibamon_core.ingestion.odds import ODDS_TABLE
from keibamon_core.lake import read_parquet_if_exists, write_dataset
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
JRAVAN_ODDS_TIMESERIES_TABLE = "jravan_odds_timeseries"

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


def _event_at(p: dict) -> datetime:
    """Event-time availability for point-in-time backtests.

    The bulk historical JV-Link pull stamped bronze ``available_at`` with the
    DOWNLOAD time (e.g. 2026), so every historical row looks "not yet available"
    for its own era and the leakage guard skips it -- yielding zero features. But
    the information existed at race time (JRA-VAN serves it live; we merely
    downloaded the history in bulk). So availability for PIT = the race's own
    clock: post time if known, else race date. ``ingested_at`` still records when
    WE pulled it. See adapters.jravan.DATA_TRAPS['available_at_bulk_download'].
    """
    return _post_time(p) or _race_date(p)


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
        "available_at": _event_at(p),        # event-time for PIT (not bulk download)
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
        "available_at": _event_at(p),
    }


def _result_record(p: dict) -> dict[str, Any]:
    pos = p.get("finish_position")
    # horse_number (umaban) is carried alongside horse_id so downstream joins
    # can use (race_id, horse_number) -- the only unique key when horse_id is
    # the '0000000000' placeholder (DATA_TRAPS['SE.ketto_num=0000000000']).
    return {
        "race_id": _race_id(p),
        "horse_id": p.get("ketto_num"),
        "horse_number": p.get("umaban"),
        "finish_position": pos if pos else None,  # 0 = no official placing
        "finish_time_seconds": p.get("finish_time"),
        "margin": (p.get("margin_code") or "").strip() or None,
        "win_odds": p.get("win_odds"),
        "popularity": p.get("popularity"),
        "last_3f_seconds": p.get("last_3f"),
        **_meta_columns(p["_meta"]),
        "available_at": _event_at(p),
    }


def _announce_at(year: int, mdhm: str) -> datetime | None:
    """O-record 発表月日時分 'MMDDhhmm' (JST, intermediate odds only) -> UTC.
    '00000000' on final/确定 odds -> None."""
    mdhm = (mdhm or "").strip()
    if len(mdhm) != 8 or not mdhm.isdigit() or mdhm == "00000000":
        return None
    mo, da, hh, mi = int(mdhm[:2]), int(mdhm[2:4]), int(mdhm[4:6]), int(mdhm[6:8])
    return datetime(year, mo, da, hh, mi, tzinfo=timezone.utc) - timedelta(hours=9)


def _as_utc(value: datetime | str) -> datetime:
    if isinstance(value, str):  # bronze wrappers (e.g. realtime) carry ISO strings
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


def _as_utc_opt(value: datetime | str | None) -> datetime | None:
    """`_as_utc` that passes None through (for nullable provenance fields)."""
    return None if value is None else _as_utc(value)


def _partition_from_race_id(race_id: str) -> tuple[int, str]:
    """Best-effort partition keys for JRA and fallback poller race ids."""
    parts = race_id.split("-")
    if len(parts) >= 4 and parts[0] == "jra":
        return int(parts[1][:4]), parts[2]
    if len(parts) >= 3 and parts[0] == "r":
        return int(parts[1]), parts[3] if len(parts) > 3 else "unknown"
    return 0, "unknown"


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
                    "available_at": announce or _event_at(rec),
                })

    rows.sort(key=lambda r: (r["race_id"], r["bet_type"], r["data_kubun"], r["combo"]))
    _write_silver(lake, "jravan_win_place_odds", rows)
    return {"jravan_win_place_odds": len(rows)}


def build_jravan_odds_timeseries(lake: LakePaths) -> dict[str, int]:
    """Materialize intraday odds curves from JRA-VAN 0B41/0B42 and netkeiba.

    This table is long and point-in-time: ``available_at`` is the odds event
    timestamp, not the download time. JRA-VAN time-series records carry that as
    ``announce_mdhm``; netkeiba rows already store the official source timestamp
    in ``available_at``.
    """
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    rows: list[dict[str, Any]] = []

    for spec in ("0B41", "0B42"):
        for row in adapter.iter_raw(spec=spec):
            if row["record_id"] not in ("O1", "O2"):
                continue
            rec = JravanSourceAdapter.parse_odds_record(row)
            if rec is None:
                continue
            announce = _announce_at(rec["year"], rec["announce_mdhm"])
            if announce is None:
                continue
            rid = _race_id(rec)
            meta = _meta_columns(rec["_meta"])
            # Bronze _meta timestamps can be ISO strings; coerce to datetime so
            # they don't collide with netkeiba's datetime column at write time
            # (same fix as the realtime path below, commit d5527e5).
            meta["ingested_at"] = _as_utc_opt(meta.get("ingested_at"))
            meta["published_time"] = _as_utc_opt(meta.get("published_time"))
            for e in rec["entries"]:
                pool = e["bet_type"]
                if pool == "win":
                    odds, low, high = e.get("odds"), None, None
                elif pool == "place":
                    odds, low, high = None, e.get("odds_low"), e.get("odds_high")
                elif pool in ("bracket_quinella", "quinella"):
                    odds, low, high = e.get("odds"), None, None
                else:
                    continue
                rows.append(
                    {
                        "race_id": rid,
                        "pool": pool,
                        "sel": e["combo"],
                        "announce_at": announce,
                        "win_odds": odds,
                        "place_odds_low": low,
                        "place_odds_high": high,
                        "popularity": e.get("popularity"),
                        **meta,
                        "source_name": "jravan",
                        "available_at": announce,
                    }
                )

    # JV-Link realtime 0B30 (official live capture). The wrapper carries the true
    # snapshot time in available_at -- finer and more reliable than the
    # minute-resolution announce_mdhm -- so it anchors the point-in-time stamp.
    # Absent on machines with no realtime export (iter_raw yields nothing).
    rt_adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan_rt"))
    for spec in ("O1", "O2"):
        for row in rt_adapter.iter_raw(spec=spec):
            if row["record_id"] not in ("O1", "O2"):
                continue
            rec = JravanSourceAdapter.parse_odds_record(row)
            if rec is None:
                continue
            available = _as_utc(row["available_at"])
            rid = _race_id(rec)
            meta = _meta_columns(rec["_meta"])
            # realtime bronze carries ISO-string timestamps; coerce the two that
            # land in this table so they match the datetime-typed netkeiba rows
            # (mixed str/datetime in one pyarrow column is a write-time collision).
            meta["ingested_at"] = _as_utc_opt(meta.get("ingested_at"))
            meta["published_time"] = _as_utc_opt(meta.get("published_time"))
            for e in rec["entries"]:
                pool = e["bet_type"]
                if pool == "win":
                    odds, low, high = e.get("odds"), None, None
                elif pool == "place":
                    odds, low, high = None, e.get("odds_low"), e.get("odds_high")
                elif pool in ("bracket_quinella", "quinella"):
                    odds, low, high = e.get("odds"), None, None
                else:
                    continue
                rows.append(
                    {
                        "race_id": rid,
                        "pool": pool,
                        "sel": e["combo"],
                        "announce_at": available,
                        "win_odds": odds,
                        "place_odds_low": low,
                        "place_odds_high": high,
                        "popularity": e.get("popularity"),
                        **meta,
                        "source_name": "jravan_rt",
                        "available_at": available,
                    }
                )

    for s in read_parquet_if_exists(lake.silver_table(ODDS_TABLE)):
        available = _as_utc(s["available_at"])
        base = {
            "race_id": s["race_id"],
            "sel": f"{int(s['horse_number']):02d}",
            "announce_at": available,
            "popularity": s.get("popularity"),
            "available_at": available,
            "source_name": s.get("source_name", "netkeiba"),
            "source_record_id": s.get("source_record_id"),
            "raw_uri": s.get("raw_uri"),
            "content_hash": s.get("content_hash"),
            "ingested_at": s.get("ingested_at"),
            "published_time": s.get("published_time"),
        }
        if s.get("win_odds") is not None:
            rows.append(
                {
                    **base,
                    "pool": "win",
                    "win_odds": s.get("win_odds"),
                    "place_odds_low": None,
                    "place_odds_high": None,
                }
            )
        if s.get("place_odds_low") is not None or s.get("place_odds_high") is not None:
            rows.append(
                {
                    **base,
                    "pool": "place",
                    "win_odds": None,
                    "place_odds_low": s.get("place_odds_low"),
                    "place_odds_high": s.get("place_odds_high"),
                }
            )

    deduped: dict[tuple[str, str, str, datetime], dict[str, Any]] = {}
    for row in rows:
        key = (row["race_id"], row["pool"], row["sel"], _as_utc(row["announce_at"]))
        deduped[key] = row
    records = sorted(deduped.values(), key=lambda r: (r["race_id"], r["pool"], r["sel"], r["announce_at"]))
    for r in records:
        r["year"], r["venue"] = _partition_from_race_id(r["race_id"])
    lake.ensure()
    write_dataset(records, lake.silver_dataset(JRAVAN_ODDS_TIMESERIES_TABLE))
    return {JRAVAN_ODDS_TIMESERIES_TABLE: len(records)}


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
                "available_at": _event_at(rec),
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
                "available_at": created or _event_at(rec),
            })
    rows.sort(key=lambda r: (r["race_id"], r["model"], r["horse_number"]))
    _write_silver(lake, "jravan_mining", rows)
    return {"jravan_mining": len(rows)}


JRAVAN_TRAINING_TABLE = "jravan_training"

# Unified timing columns across HC (slope) and WC (woodchip). HC has sections
# 4F→1F; WC has 10F→1F. Upper distances (5F+) are NULL for HC and commonly NULL
# for WC (horses run partial distances). ``last_1f`` is the money field.
_TRAINING_TIMING_COLS = [
    "f10_total", "f10_lap", "f9_total", "f9_lap", "f8_total", "f8_lap",
    "f7_total", "f7_lap", "f6_total", "f6_lap", "f5_total", "f5_lap",
    "f4_total", "f4_lap", "f3_total", "f3_lap", "f2_total", "f2_lap",
    "last_1f",
]
_HC_LAP_RENAME = {"lap_800_600": "f4_lap", "lap_600_400": "f3_lap", "lap_400_200": "f2_lap"}
_TRAINING_CENTER_CODES = {"0": "Miho", "1": "Ritto"}


def _train_event_at(p: dict) -> datetime | None:
    """available_at = train_date + train_time (JST) → UTC.

    NEVER make_date — the bulk-delivery make_date is ~2026 even for a 2003 work
    (same PIT trap as ``available_at_bulk_download``). Training availability for
    PIT = the work's own clock. See DATA_TRAPS['training.available_at'].
    """
    date_str = p.get("train_date") or ""
    hhmm = (p.get("train_time") or "").strip()
    if len(date_str) != 10:
        return None
    y, mo, da = int(date_str[:4]), int(date_str[5:7]), int(date_str[8:10])
    hh = mi = 0
    if len(hhmm) == 4 and hhmm.isdigit() and hhmm != "0000":
        hh, mi = int(hhmm[:2]), int(hhmm[2:])
    # Build JST wall-clock, shift to UTC (same idiom as _post_time).
    jst = datetime(y, mo, da, hh, mi, tzinfo=timezone.utc)
    return jst - timedelta(hours=9)


def _training_row(p: dict, rec_id: str, meta: dict) -> dict[str, Any]:
    center_code = (p.get("center") or "").strip()
    row: dict[str, Any] = {
        "horse_id": p.get("horse_id"),
        "training_date": p.get("train_date"),
        "training_time": (p.get("train_time") or "").strip() or None,
        "center": _TRAINING_CENTER_CODES.get(center_code),
        "center_code": center_code or None,
        "course_type": "slope" if rec_id == "HC" else "woodchip",
        "course_code": None,
        "around": None,
        **{c: None for c in _TRAINING_TIMING_COLS},
        **_meta_columns(meta),
    }
    if rec_id == "HC":
        row["f4_total"] = p.get("f4_total")
        row["f3_total"] = p.get("f3_total")
        row["f2_total"] = p.get("f2_total")
        row["f4_lap"] = p.get("lap_800_600")
        row["f3_lap"] = p.get("lap_600_400")
        row["f2_lap"] = p.get("lap_400_200")
    else:  # WC
        row["course_code"] = p.get("course_code")
        row["around"] = p.get("around")
        for prefix in ("f10", "f9", "f8", "f7", "f6", "f5", "f4", "f3", "f2"):
            row[f"{prefix}_total"] = p.get(f"{prefix}_total")
            row[f"{prefix}_lap"] = p.get(f"{prefix}_lap")
    row["last_1f"] = p.get("last_1f")
    row["available_at"] = _train_event_at(p)  # PIT: train clock, not download
    date_str = p.get("train_date") or ""
    row["year"] = int(date_str[:4]) if len(date_str) >= 4 and date_str[:4].isdigit() else 0
    row["venue"] = center_code or "unknown"  # partition key (= center code; "0"/"1")
    return row


def build_jravan_training(lake: LakePaths) -> dict[str, int]:
    """Parse HC (坂路/slope) and WC (ウッドチップ/woodchip) training records into
    the ``jravan_training`` silver table.

    Point-in-time correct: ``available_at`` = train_date + train_time (JST→UTC),
    never the bulk-delivery make_date. Partitioned by (year, venue) where venue
    = training center code ("0"=Miho, "1"=Ritto) — reuses the lake's standard
    hive layout so read_dataset/lake_query work unchanged.
    """
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    rows: list[dict[str, Any]] = []

    for spec, record_id in (("SLOP", "HC"), ("WOOD", "WC")):
        for raw_row in adapter.iter_raw(spec=spec):
            if raw_row["record_id"] != record_id:
                continue
            parsed = JravanSourceAdapter.parse_record(raw_row)
            if parsed is None:
                continue
            if (parsed.get("data_kubun") or "").strip() != "1":
                continue  # skip deletes
            if (parsed.get("horse_id") or "").strip() in ("", "0000000000"):
                continue  # DATA_TRAPS: pre-IC-tag placeholder
            rows.append(_training_row(parsed, record_id, parsed["_meta"]))

    _epoch = datetime.min.replace(tzinfo=timezone.utc)
    rows.sort(key=lambda r: (r["available_at"] or _epoch, r["horse_id"] or ""))
    lake.ensure()
    write_dataset(rows, lake.silver_dataset(JRAVAN_TRAINING_TABLE))
    return {JRAVAN_TRAINING_TABLE: len(rows)}


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
    results.sort(key=lambda r: (r["race_id"], r["horse_number"] or 0, r["horse_id"] or ""))

    _write_silver(lake, "jravan_races", race_rows)
    _write_silver(lake, "jravan_race_entries", entries)
    _write_silver(lake, "jravan_race_results", results)

    return {
        "jravan_races": len(race_rows),
        "jravan_race_entries": len(entries),
        "jravan_race_results": len(results),
    }


# --------------------------------------------------------------------------- #
# Masters (KS 騎手マスタ / CH 調教師マスタ)
# --------------------------------------------------------------------------- #
# See docs/prompts/jvlink-master-named-patternoflife.md (PC counterpart) +
# docs/prompts/mac-import-named-patternoflife.md. Idempotent, content-hashed via
# the bronze-to-silver row hash. NOT Hive-partitioned (no race_id to derive
# year/venue from); written flat to data/normalized/{jockey,trainer}_master.parquet.
# DATA_TRAP: '00000' codes are placeholders, never real names.

PLACEHOLDER_LABEL = "(unknown/placeholder)"


def _normalize_master_name(raw_name: str | None) -> str | None:
    """Trim trailing full/half-width space padding the spec leaves on the field.

    JV-Data spec fills the name field to its full byte width with full-width
    spaces (U+3000); a typical "秋元\u3000松雄\u3000\u3000...\u3000" comes through.
    We keep a SINGLE internal U+3000 as the surname/given separator (the spec
    says: 姓 + 全角空白1文字 + 名) and strip the rest. Returns None if the
    field is empty after trimming.
    """
    if raw_name is None:
        return None
    # Replace the SEPARATOR U+3000 with a regular space so downstream tools
    # (DuckDB / Pandas / shell) handle the field cleanly. External consumers
    # split on whitespace anyway; keeping U+3000 buys nothing.
    s = raw_name.rstrip(" \u3000").replace("\u3000", " ").strip()
    return s or None


def _master_records(
    lake: LakePaths,
    *,
    spec: str,
    id_field: str,
) -> list[dict[str, Any]]:
    """Read + parse one master spec from bronze into silver-shaped dicts.

    Shared by :func:`build_jockey_master` and :func:`build_trainer_master`.
    Latest record per id wins (data_kubun=0 = delete -> dropped; 1/2 = upsert).
    """
    from keibamon_core.adapters.jravan import (
        RECORD_LENGTHS,
        RECORD_LAYOUTS,
        parse_master,
    )

    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    layout = RECORD_LAYOUTS[spec]
    expected_len = RECORD_LENGTHS.get(spec)
    by_id: dict[str, dict[str, Any]] = {}
    for row in adapter.iter_raw(spec=spec):
        parsed = parse_master(row["raw"], layout, expected_len=expected_len)
        # spec item 2: 0 = record-deletion (提供ミス). Drop on delete.
        if parsed.get("data_kubun") == 0:
            continue
        rec_id = parsed[id_field]
        if not rec_id:
            continue
        name_raw = parsed.get("name")
        # DATA_TRAP: '00000' is the non-unique placeholder. Label it, never an
        # invented name (per DATA_TRAPS["KS.jockey_id=00000"] / CH equivalent).
        if rec_id == "00000":
            name = PLACEHOLDER_LABEL
            name_kana = PLACEHOLDER_LABEL
        else:
            name = _normalize_master_name(name_raw)
            name_kana = _normalize_master_name(parsed.get("name_kana"))
        by_id[rec_id] = {
            id_field: rec_id,
            "name": name,
            "name_kana": name_kana,
            "name_romanji": (parsed.get("name_romanji") or "").strip() or None,
            "name_abbrev": _normalize_master_name(parsed.get("name_abbrev")),
            "retire_flag": parsed.get("retire_flag"),
            "license_issue_date": parsed.get("license_issue_date"),
            "license_cancel_date": parsed.get("license_cancel_date"),
            "birthdate": parsed.get("birthdate"),
            "make_date": parsed.get("make_date"),
            "source_name": "jravan",
            "ingested_at": row.get("ingested_at"),
        }
    return sorted(by_id.values(), key=lambda r: r[id_field])


def _write_master_parquet(rows: list[dict[str, Any]], path: Path) -> None:
    """Write a flat (non-partitioned) master parquet atomically."""
    try:
        import pyarrow as pa
        import pyarrow.parquet as pq
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("pyarrow is required to write master parquet") from exc
    path.parent.mkdir(parents=True, exist_ok=True)
    table = pa.Table.from_pylist(rows)
    # Atomic via tmp-file rename (single-file parquet; safe for the master size).
    tmp = path.with_name(f".{path.name}.tmp")
    pq.write_table(table, tmp, compression="snappy")
    import os
    os.replace(tmp, path)


def build_jockey_master(lake: LakePaths) -> dict[str, int]:
    """KS 騎手マスタ -> data/normalized/jockey_master.parquet.

    Columns: jockey_id, name, name_kana, name_romanji, name_abbrev,
    retire_flag, license_issue_date, license_cancel_date, birthdate, make_date,
    source_name, ingested_at. ``jockey_id='00000'`` is labelled
    '(unknown/placeholder)' per DATA_TRAPS['KS.jockey_id=00000'].
    """
    lake.ensure()
    rows = _master_records(lake, spec="KS", id_field="jockey_id")
    _write_master_parquet(rows, lake.normalized / "jockey_master.parquet")
    return {"jockey_master": len(rows)}


def build_trainer_master(lake: LakePaths) -> dict[str, int]:
    """CH 調教師マスタ -> data/normalized/trainer_master.parquet.

    Same shape as :func:`build_jockey_master` but keyed by ``trainer_id``.
    """
    lake.ensure()
    rows = _master_records(lake, spec="CH", id_field="trainer_id")
    _write_master_parquet(rows, lake.normalized / "trainer_master.parquet")
    return {"trainer_master": len(rows)}


# --------------------------------------------------------------------------- #
# H1 票数 (per-pool yen vote counts) + JG 競走馬除外情報 (declarations)
# --------------------------------------------------------------------------- #
# H1 unlocks TRUE pool liquidity for the odds-flow anomaly detector (replaces
# the inferred-liquidity proxy from odds movement). JG carries pre-race
# declarations + exclusions -- the exclusion subset is the #1 innocent
# explanation for a false drift flag (a late scratch reshaping the pool). Both
# specs lack an explicit 発表時分 field, so available_at = _event_at
# (post_time || race_date); NEVER make_date, which drifts (H1.make_date_drift).

JRAVAN_VOTES_TABLE = "jravan_votes"
JRAVAN_DECLARATIONS_TABLE = "jravan_declarations"


def build_jravan_votes(lake: LakePaths) -> dict[str, int]:
    """H1 票数 -> silver/jravan_votes (one row per race × pool × combo).

    True yen liquidity per pool combo (11-digit 単位百円 vote count × 100). All
    7 pools (win/place/bracket_quinella/quinella/wide/exacta/trio); pre-2003
    races only carry win/place/bracket_quinella (the exotics weren't offered
    then -- those slots are whitespace, dropped by the parser's combo skip).
    available_at = _event_at (post_time || race_date); NEVER make_date
    (H1.make_date_drift DATA_TRAP). data_kubun='0' (delete) rows dropped;
    latest record per (race, pool, combo) wins to dedup across data_kubun
    variants. H1 lives in its own file in the master pull AND may be bundled in
    RACE.* in race snapshots, so both specs are streamed.
    """
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    by_key: dict[tuple[str, str, str], dict[str, Any]] = {}
    for spec in ("RACE", "H1"):
        for row in adapter.iter_raw(spec=spec):
            if row["record_id"] != "H1":
                continue
            rec = JravanSourceAdapter.parse_grouped_record(row)
            if rec is None or str(rec.get("data_kubun")) == "0":
                continue
            rid = _race_id(rec)
            meta = _meta_columns(rec["_meta"])
            event_at = _event_at(rec)
            for e in rec["entries"]:
                by_key[(rid, e["pool"], e["combo"])] = {
                    "race_id": rid,
                    "pool": e["pool"],
                    "combo": e["combo"],
                    "vote_yen": e.get("vote_yen"),
                    "popularity": e.get("popularity"),
                    **meta,
                    "available_at": event_at,
                }
    rows = sorted(by_key.values(),
                  key=lambda r: (r["race_id"], r["pool"], r["combo"]))
    _write_silver(lake, JRAVAN_VOTES_TABLE, rows)
    return {JRAVAN_VOTES_TABLE: len(rows)}


# shutan_kubun (出馬区分) -> label. {2,5,6,9} are the exclusion/withdrawal set.
_SHUTAN_LABELS: dict[str, str] = {
    "1": "declared",          # 投票馬 (declared + ran)
    "2": "excluded_close",    # 締切での除外馬
    "4": "revote",            # 再投票馬
    "5": "revote_excluded",   # 再投票除外馬
    "6": "withdrawn_no_num",  # 馬番を付さない出走取消馬
    "9": "withdrawn",         # 取消馬
}
# jogai_jotai_kubun (除外状態) -> label. {1,2} mark a ballot-loss exclusion.
_JOGAI_LABELS: dict[str, str] = {"0": "none", "1": "ballot_lost", "2": "ballot_excluded"}
_EXCLUDED_SHUTAN: set[str] = {"2", "5", "6", "9"}
_EXCLUDED_JOGAI: set[str] = {"1", "2"}


def _declaration_row(p: dict, meta: dict) -> dict[str, Any]:
    """JG -> one silver jravan_declarations row with derived exclusion flags.

    is_excluded is True for shutan_kubun in {2,5,6,9} (the four exclusion /
    withdrawal kubun) OR jogai_jotai_kubun in {1,2} (ballot loss / exclusion).
    The ~91% of rows with shutan=1+jogai=0 (declared, ran) have
    is_excluded=False (JG.is_not_pure_exclusions DATA_TRAP). exclusion_kind
    prefers the shutan label, falling back to the jogai label.
    """
    shutan = p.get("shutan_kubun") or "0"
    jogai = p.get("jogai_jotai_kubun") or "0"
    is_excluded = shutan in _EXCLUDED_SHUTAN or jogai in _EXCLUDED_JOGAI
    if shutan in _EXCLUDED_SHUTAN:
        exclusion_kind = _SHUTAN_LABELS.get(shutan)
    elif jogai in _EXCLUDED_JOGAI:
        exclusion_kind = _JOGAI_LABELS.get(jogai)
    else:
        exclusion_kind = None
    return {
        "race_id": _race_id(p),
        "horse_id": p.get("ketto_num"),
        "ketto_num": p.get("ketto_num"),
        "bamei": (p.get("bamei") or "").strip() or None,
        "vote_accept_order": p.get("vote_accept_order"),
        "shutan_kubun": shutan,
        "shutan_label": _SHUTAN_LABELS.get(shutan),
        "jogai_jotai_kubun": jogai,
        "jogai_label": _JOGAI_LABELS.get(jogai),
        "is_excluded": is_excluded,
        "exclusion_kind": exclusion_kind,
        **meta,
        "available_at": _event_at(p),
    }


def build_jravan_declarations(lake: LakePaths) -> dict[str, int]:
    """JG 競走馬除外情報 -> silver/jravan_declarations.

    The cumulative pre-race declarations master (NOT just exclusions -- ~91% of
    rows are shutan_kubun=1 投票馬 that ran). The exclusion subset is a one-
    liner downstream: WHERE is_excluded=true. The ketto_num='0000000000'
    placeholder is PRESERVED (not filtered) so downstream joins still see the
    scratch via (race_id, horse_id) -- horse_number is NULL for placeholders
    (JG.ketto_num=0000000000 DATA_TRAP). JG lives in its own file in the master
    pull AND may be bundled in RACE.* in race snapshots, so both specs streamed.
    """
    adapter = JravanSourceAdapter(lake.bronze_source_dir("jravan"))
    rows: list[dict[str, Any]] = []
    for spec in ("RACE", "JG"):
        for row in adapter.iter_raw(spec=spec):
            if row["record_id"] != "JG":
                continue
            p = JravanSourceAdapter.parse_record(row)
            if p is None or str(p.get("data_kubun")) == "0":
                continue
            rows.append(_declaration_row(p, _meta_columns(p["_meta"])))
    rows.sort(key=lambda r: (r["race_id"], r["horse_id"] or ""))
    _write_silver(lake, JRAVAN_DECLARATIONS_TABLE, rows)
    return {JRAVAN_DECLARATIONS_TABLE: len(rows)}


if __name__ == "__main__":  # quick manual run: python -m keibamon_core.ingestion.jravan_silver
    import json
    lake = LakePaths()
    out = build_jravan_silver(lake)
    out.update(build_jravan_odds(lake))      # O1 win+place by default
    out.update(build_jravan_odds_timeseries(lake))  # 0B41/0B42 + netkeiba time series
    out.update(build_jravan_payouts(lake))   # HR payouts
    out.update(build_jravan_mining(lake))    # DM time + TM score predictions
    out.update(build_jravan_training(lake))  # HC slope + WC woodchip training times
    out.update(build_jockey_master(lake))    # KS 騎手マスタ
    out.update(build_trainer_master(lake))   # CH 調教師マスタ
    out.update(build_jravan_votes(lake))         # H1 票数 (yen vote counts, 7 pools)
    out.update(build_jravan_declarations(lake))  # JG 競走馬除外情報
    print(json.dumps(out, indent=2))
