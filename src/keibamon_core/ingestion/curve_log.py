"""curve_log.py -- the settle logger: turn live odds curves into scored evidence.

This is the falsification engine for the project's one surviving edge hypothesis:
*does a horse that firms late actually beat its closing-implied probability, net
of takeout?* Mining and going-handling both failed the market test; the odds
curve is the only thing left, and it can only be judged on data we accumulate
going forward. This module is how that data accumulates honestly.

Two stages, deliberately separated so a result can never contaminate a decision:

  1. FREEZE (before the race is settled) -- snapshot each runner's curve at a
     pre-post decision time ``t`` from ``odds_snapshots``: open / odds@t / close,
     de-vigged probabilities at each cross-section, and the residual-drift tag at
     ``t`` (same logic the dashboard uses; see polling/drift.py). Result fields
     are NULL. Nothing here looks at the finish.

  2. SETTLE (after results land) -- join the frozen rows to the official result
     and pay each hypothetical 1-unit win bet at the **official FINAL win odds**
     (pari-mutuel: you are paid at the close, never at the price you saw at ``t``).
     CLV (close vs ``t``) is recorded as a *diagnostic*, never as realized profit.

The honest verdict comes later, over many race days: group settled rows by drift
tag and compare ROI to the ~-20% takeout floor. One card proves nothing; this
just makes every card count. A "firming" tag is a thing to measure, not a bet.
"""
from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any, Iterable

from keibamon_core.lake import read_parquet_if_exists, write_parquet
from keibamon_core.paths import LakePaths
from keibamon_core.polling.drift import residual_edges

CURVE_LOG_TABLE = "curve_log"

CURVE_LOG_COLUMNS = (
    "race_id", "horse_number",
    "open_odds", "decision_odds", "close_odds",
    "decision_at", "close_at",
    "p_open", "p_decision", "p_close",
    "drift_dir", "drift_resid_pct", "drift_z",
    "clv_logdrift",
    "weather", "going", "going_wetness", "going_transition",
    "finish_position", "won", "top3",
    "settle_odds", "settled_payout", "settled",
    "logged_at",
)

# JRA course (競馬場) codes used in the canonical race_id "jra-YYYYMMDD-<jyo>-NN".
VENUE_JYO = {
    "sapporo": "01", "hakodate": "02", "fukushima": "03", "niigata": "04",
    "tokyo": "05", "nakayama": "06", "chukyo": "07", "kyoto": "08",
    "hanshin": "09", "kokura": "10",
}


def crosswalk_race_id(synthetic: str) -> str:
    """Live-feed id -> canonical lake id (idempotent).

    "r-2026-0614-hanshin-11" -> "jra-20260614-09-11". The netkeiba feed coins a
    human id; the JV-Link silver keys on jra-YYYYMMDD-<jyo>-NN. The official
    realtime (jravan_rt) is *already* canonical, so a "jra-" id passes through
    untouched -- this is the bridge from either curve source to the result.
    """
    if synthetic.startswith("jra-"):
        return synthetic
    parts = synthetic.split("-")
    if len(parts) != 5 or parts[0] != "r":
        raise ValueError(f"unrecognized feed race_id: {synthetic!r}")
    _, yyyy, mmdd, venue, rno = parts
    jyo = VENUE_JYO.get(venue.lower())
    if jyo is None:
        raise ValueError(f"unknown venue {venue!r} in {synthetic!r}")
    return f"jra-{yyyy}{mmdd}-{jyo}-{int(rno):02d}"


def snapshot_rows_from_timeseries(ts_rows, *, source=None, pool="win"):
    """Adapt jravan_odds_timeseries rows to build_curve_records' input shape.

    The timeseries keys odds by ``sel`` ('05') and ``pool``; this yields the
    ``(race_id, horse_number, win_odds, available_at)`` dicts the curve builder
    wants, for one source's win pool. Use it to score the **official** jravan_rt
    curve (canonical race_ids, dense to post) exactly like the netkeiba feed.
    ``source``/``pool`` filters are skipped when those keys are absent (e.g. when
    the caller already filtered in SQL).
    """
    out = []
    for r in ts_rows:
        if source is not None and r.get("source_name") != source:
            continue
        if "pool" in r and r["pool"] != pool:
            continue
        try:
            hn = int(r.get("sel"))
        except (TypeError, ValueError):
            continue
        if r.get("win_odds") is None:
            continue
        out.append({
            "race_id": r["race_id"], "horse_number": hn,
            "win_odds": r["win_odds"], "available_at": r["available_at"],
        })
    return out


def _as_utc(v: Any) -> datetime:
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    return datetime.fromisoformat(str(v).replace("Z", "+00:00"))


def devig(odds_map: dict[Any, float]) -> tuple[dict[Any, float], float]:
    """1/odds normalized to a proper distribution. Returns (probs, overround)."""
    inv = {k: 1.0 / v for k, v in odds_map.items() if v and v > 0}
    total = sum(inv.values()) or 1.0
    return {k: v / total for k, v in inv.items()}, total


def _decision_pick(snaps: list[tuple[datetime, float]], t: datetime) -> tuple[float | None, datetime | None]:
    """PIT pick: the latest snapshot at or before ``t``. Never peeks past ``t``."""
    cand = [(c, o) for c, o in snaps if c <= t and o and o > 0]
    if not cand:
        return None, None
    c, o = max(cand, key=lambda x: x[0])
    return o, c


def build_curve_records(
    snapshot_rows: Iterable[dict[str, Any]],
    *,
    lead_min: float = 5.0,
    post_times: dict[str, datetime] | None = None,
    race_context: dict[str, dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """FREEZE stage. Turn raw odds_snapshots rows into one curve record per runner.

    ``snapshot_rows``: dicts with race_id, horse_number, win_odds, available_at
    (the source timestamp). Decision time ``t`` = post_time - lead_min if a post
    time is known for the race, else (last snapshot - lead_min) so there is always
    a measurable gap between the decision and the close. Result fields are NULL.

    ``race_context``: optional ``{race_id: {weather, going, going_wetness,
    going_transition}}`` stamped onto each record so accumulated curves can later
    be split by whether the track was changing -- the only way to tell a pure
    slow-reaction curve move from a rational reprice on deteriorating going.
    """
    post_times = post_times or {}
    race_context = race_context or {}
    # group by race -> horse -> sorted (time, odds)
    by_race: dict[str, dict[int, list[tuple[datetime, float]]]] = {}
    for r in snapshot_rows:
        win = r.get("win_odds")
        if not win or win <= 0:
            continue
        rid, hn = r["race_id"], int(r["horse_number"])
        by_race.setdefault(rid, {}).setdefault(hn, []).append((_as_utc(r["available_at"]), float(win)))

    out: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    for rid, horses in by_race.items():
        for snaps in horses.values():
            snaps.sort(key=lambda x: x[0])
        last_cap = max(s[-1][0] for s in horses.values())
        if rid in post_times:
            t = post_times[rid] - _timedelta_min(lead_min)
        else:
            t = last_cap - _timedelta_min(lead_min)

        open_odds = {hn: s[0][1] for hn, s in horses.items()}
        close_odds = {hn: s[-1][1] for hn, s in horses.items()}
        close_at = {hn: s[-1][0] for hn, s in horses.items()}
        dec = {hn: _decision_pick(s, t) for hn, s in horses.items()}
        decision_odds = {hn: v[0] for hn, v in dec.items() if v[0]}

        p_open, _ = devig(open_odds)
        p_close, _ = devig(close_odds)
        p_dec, _ = devig(decision_odds)

        # residual-drift tag at the decision: how each runner moved open->t vs field
        edges = residual_edges([(hn, decision_odds.get(hn), open_odds.get(hn)) for hn in horses])
        ctx = race_context.get(rid, {})

        for hn in horses:
            d_odds, d_at = dec[hn]
            c_odds = close_odds[hn]
            flag = edges.get(hn)
            clv = math.log(c_odds / d_odds) if (d_odds and c_odds) else None
            out.append({
                "race_id": rid, "horse_number": hn,
                "open_odds": open_odds[hn], "decision_odds": d_odds, "close_odds": c_odds,
                "decision_at": d_at.isoformat() if d_at else None,
                "close_at": close_at[hn].isoformat(),
                "p_open": p_open.get(hn), "p_decision": p_dec.get(hn), "p_close": p_close.get(hn),
                "drift_dir": flag.direction if flag else None,
                "drift_resid_pct": round(flag.resid_pct, 4) if flag else None,
                "drift_z": round(flag.z, 2) if flag else None,
                "clv_logdrift": round(clv, 4) if clv is not None else None,
                "weather": ctx.get("weather"), "going": ctx.get("going"),
                "going_wetness": ctx.get("going_wetness"),
                "going_transition": ctx.get("going_transition"),
                "finish_position": None, "won": None, "top3": None,
                "settle_odds": None, "settled_payout": None, "settled": False,
                "logged_at": now.isoformat(),
            })
    return out


def settle_curve_records(
    records: Iterable[dict[str, Any]],
    results: dict[tuple[str, int], tuple[int, float | None]],
) -> list[dict[str, Any]]:
    """SETTLE stage. Fill result fields from official finishes.

    ``results``: {(canonical_race_id, horse_number): (finish_position, final_odds)}.
    Pays a 1-unit win bet at the **official final odds** (or the close as a proxy
    if the official final is missing) -- never the decision-time price. Records
    whose race isn't in ``results`` pass through unsettled. Idempotent.
    """
    settled = []
    for rec in records:
        rec = dict(rec)
        try:
            key = (crosswalk_race_id(rec["race_id"]), int(rec["horse_number"]))
        except ValueError:
            settled.append(rec)
            continue
        if key in results:
            finish, final_odds = results[key]
            settle_odds = final_odds or rec.get("close_odds")
            won = finish == 1
            rec.update({
                "finish_position": finish,
                "won": won,
                "top3": finish is not None and finish <= 3,
                "settle_odds": settle_odds,
                "settled_payout": (settle_odds if won else 0.0) if settle_odds else None,
                "settled": True,
            })
        settled.append(rec)
    return settled


def summarize(records: Iterable[dict[str, Any]], by=("drift_dir",)) -> dict:
    """Group settled rows -> n, actual wins, market-EXPECTED wins, ROI.

    ``by`` is the grouping key(s); a single key returns string-keyed buckets
    (e.g. "firming"), multiple keys return tuple-keyed buckets (e.g.
    ("firming", True) for firming-on-a-going-transition). ``expected_mkt`` =
    sum of de-vigged win prob at the decision: the confound-controlled yardstick.
    A bucket only matters if actual wins beat ``expected_mkt`` -- raw ROI is
    fooled by firming horses simply being short-priced. Unsettled rows ignored.
    """
    by = (by,) if isinstance(by, str) else tuple(by)
    buckets: dict = {}
    for r in records:
        if not r.get("settled") or r.get("settled_payout") is None:
            continue
        key = tuple(
            (r.get(k) if r.get(k) is not None else ("neutral" if k == "drift_dir" else None))
            for k in by
        )
        buckets.setdefault(key if len(key) > 1 else key[0], []).append(r)
    summary = {}
    for tag, rows in buckets.items():
        n = len(rows)
        wins = sum(1 for r in rows if r.get("won"))
        expected = sum((r.get("p_decision") or 0.0) for r in rows)
        roi = sum(r["settled_payout"] for r in rows) / n - 1.0
        summary[tag] = {
            "n": n,
            "wins": wins,
            "expected_mkt": round(expected, 2),
            "win_rate": round(wins / n, 3),
            "roi": round(roi, 3),
        }
    return summary


def _curve_key(r: dict[str, Any]) -> tuple:
    return (r["race_id"], int(r["horse_number"]), r.get("decision_at"))


def read_curve_log(lake: LakePaths) -> list[dict[str, Any]]:
    """All curve_log rows (empty list if the table doesn't exist yet)."""
    return read_parquet_if_exists(lake.silver_table(CURVE_LOG_TABLE))


def upsert_curve_log(lake: LakePaths, records: Iterable[dict[str, Any]]) -> int:
    """Persist curve rows, upserting on (race_id, horse_number, decision_at).

    Upsert (not append-only) so the SETTLE pass overwrites the frozen rows in
    place with their result fields rather than duplicating them. Returns the
    number of rows written/updated.
    """
    existing = read_parquet_if_exists(lake.silver_table(CURVE_LOG_TABLE))
    idx = {_curve_key(r): i for i, r in enumerate(existing)}
    changed = 0
    for rec in records:
        key = _curve_key(rec)
        if key in idx:
            existing[idx[key]] = rec
        else:
            idx[key] = len(existing)
            existing.append(rec)
        changed += 1
    if changed:
        existing.sort(key=lambda r: (r["race_id"], int(r["horse_number"])))
        write_parquet(existing, lake.silver_table(CURVE_LOG_TABLE))
    return changed


def _timedelta_min(minutes: float):
    from datetime import timedelta
    return timedelta(minutes=minutes)
