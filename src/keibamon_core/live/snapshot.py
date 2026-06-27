"""Pure live-snapshot assembly (ADR-0006).

The builder is deliberately PURE -- it takes already-fetched runner data and
returns the snapshot document. All network/lake I/O lives in the CLI
(``tools/jravan/expose_live.py``) so this is unit-testable offline.

Race lifecycle exposed to the app::

    registered  entries published, no live pari-mutuel odds yet  -> grayed,
                show estimated odds when netkeiba has rendered one
    open        live win odds present                            -> normal
    result      official result attached                         -> settled

Point-in-time note: this is a DISPLAY projection, not a betting-decision input.
It only ever shows data already visible to the public (entries + live odds), so
it carries no leakage risk; the lake remains the record of truth for backtests.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Iterable

# Per-race status the app keys its rendering on. Keep in sync with the
# frontend LiveRace["status"] union in frontend/src/api.ts.
STATUS_REGISTERED = "registered"
STATUS_OPEN = "open"
STATUS_RESULT = "result"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clean_odds(v: Any) -> float | None:
    """Coerce to a real, sane odds value or None (>=1.0; finite)."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f >= 1.0 and f == f else None  # f==f rejects NaN


def build_runner(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize one runner into the app-facing shape.

    Inputs may carry ``win_odds`` (live) and/or ``est_odds`` (estimated). The
    contract the app relies on:

    - ``win_odds``      live odds, or ``None`` until the pool opens
    - ``win_odds_est``  estimated odds shown ONLY while there is no live price
    - ``odds_is_live``  True iff a live ``win_odds`` is present

    We never copy the estimate into ``win_odds``; the app must be able to tell a
    real price from a guess (it grays the runner and labels the estimate).
    """
    live = _clean_odds(raw.get("win_odds"))
    est = _clean_odds(raw.get("est_odds") if raw.get("est_odds") is not None else raw.get("win_odds_est"))
    return {
        "umaban": raw.get("umaban"),
        "name": raw.get("name"),
        "win_odds": live,
        "win_odds_est": est if live is None else None,
        "odds_is_live": live is not None,
        # Milestone-4 form panel (option-a JOCKEY GAP): carry the jockey id +
        # label so the panel can look up jockey history by id. Both None until
        # the entries scrape populates them; additive -- the app ignores fields
        # it doesn't read, and the social Worker selects runner fields by name.
        "jockey_id": raw.get("jockey_id"),
        "jockey_name": raw.get("jockey_name"),
    }


def build_race(raw: dict[str, Any]) -> dict[str, Any]:
    """Assemble one race + derive its status from the runner odds."""
    runners = [build_runner(r) for r in (raw.get("runners") or [])]
    has_live = any(r["odds_is_live"] for r in runners)
    result = raw.get("result")
    if result:
        status = STATUS_RESULT
    elif has_live:
        status = STATUS_OPEN
    else:
        status = STATUS_REGISTERED
    return {
        "date": raw.get("date"),
        "race_no": raw.get("race_no"),
        "race_id": raw.get("race_id"),
        "name": raw.get("name"),
        "grade_label": raw.get("grade_label"),
        "post_time": raw.get("post_time") or raw.get("post_time_jst"),
        "venue": raw.get("venue"),
        # Surface + distance from discover_card's RaceList_ItemLong cell
        # (芝1800m / ダ1400m). Additive — null when the producer didn't parse
        # one, so older snapshots / marts without these stay readable.
        "surface": raw.get("surface"),
        "distance_m": raw.get("distance_m"),
        "status": status,
        "result": result,
        "runners": runners,
    }


def build_live_snapshot(
    races: Iterable[dict[str, Any]],
    *,
    venue: str | None = None,
    date: str | None = None,
    source: str = "netkeiba-live",
    published_at: str | None = None,
    message: str | None = None,
) -> dict[str, Any]:
    """Assemble the full ``live_snapshot`` document.

    Races are sorted by (date, venue, race_no) so multi-date/multi-venue
    snapshots render stably. The meta block carries a coarse status so the app
    can show a standby state when nothing is registered yet.
    """
    built = [build_race(r) for r in races]
    built.sort(
        key=lambda r: (
            str(r.get("date") or ""),
            str(r.get("venue") or ""),
            r.get("race_no") or 0,
        ),
    )

    n_registered = sum(1 for r in built if r["status"] == STATUS_REGISTERED)
    n_open = sum(1 for r in built if r["status"] == STATUS_OPEN)
    meta_status = "live" if n_open else ("standby" if not built else "registered")

    # Per-(date, venue) counts -- the partial-publish guard's signal. A
    # truncated card (e.g. one venue's R9-R12 missing on a transient
    # discover_card miss) is visible here without re-deriving from .races.
    # Sort by date then venue so the deployed JSON is stable for diffing.
    by_venue: dict[str, int] = {}
    for r in built:
        rdate = str(r.get("date") or date or "")
        rvenue = str(r.get("venue") or "")
        if not rvenue:
            continue
        key = f"{rdate}|{rvenue}" if rdate else rvenue
        by_venue[key] = by_venue.get(key, 0) + 1
    by_venue = {k: by_venue[k] for k in sorted(by_venue)}

    return {
        "meta": {
            "venue": venue,
            "date": date,
            "status": meta_status,
            "source": source,
            "counts": {
                "total": len(built),
                "registered": n_registered,
                "open": n_open,
                "by_venue": by_venue,
            },
            "message": message
            or "Races appear as soon as they are registered. Grayed = odds not "
            "open yet (estimated odds shown where available).",
            "published_at": published_at or _utc_now_iso(),
        },
        "races": built,
    }


def merge_entries_and_odds(
    entry_runners: list[dict[str, Any]],
    odds_by_umaban: dict[int, float] | None = None,
) -> list[dict[str, Any]]:
    """Merge registered entries with whatever live odds exist, by umaban.

    ``entry_runners`` come from the shutuba scrape (carry ``est_odds``);
    ``odds_by_umaban`` from the live odds API (empty/None pre-open). Output is
    the runner-input shape ``build_runner`` expects.
    """
    odds_by_umaban = odds_by_umaban or {}
    out: list[dict[str, Any]] = []
    for e in entry_runners:
        uma = e.get("horse_number", e.get("umaban"))
        out.append(
            {
                "umaban": uma,
                "name": e.get("horse_name") or e.get("name"),
                "win_odds": odds_by_umaban.get(uma),
                "est_odds": e.get("est_odds"),
                # Pass-through for the form panel (option-a JOCKEY GAP). The
                # entries scrape carries both; absent on legacy/manual runners.
                "jockey_id": e.get("jockey_id"),
                "jockey_name": e.get("jockey_name"),
            }
        )
    return out
