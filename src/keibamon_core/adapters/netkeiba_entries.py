"""netkeiba race-card (出馬表 / shutuba) adapter -> ``jravan_race_entries``.

Three layers, deliberately separated so the wire-payload extractor can be
recalibrated against real netkeiba without touching the silver shape:

  - :func:`parse_entries_payload` -- BRITTLE: extract intermediate runner dicts
    from a netkeiba ``shutuba.html`` payload. HTML-regex over the
    ``<tr class="HorseList">`` rows. Fixture-tested against a REAL captured
    shutuba page (``tests/fixtures/netkeiba/shutuba_202605030611.html`` -- the
    live 2026-06-21 Tokyo R11 capture with 16 declared runners).
  - :func:`_entry_record` -- PURE: map one intermediate dict to the EXACT
    ``jravan_race_entries`` silver shape (mirrors
    :func:`jravan_silver._entry_record`). Carries ``source_name='netkeiba'``
    on every row.
  - :func:`build_entries` -- orchestrate fetch -> bronze archive -> silver
    upsert. Takes a ``fetch_fn=`` injection seam so tests run offline.

WIRE FORMAT. ``race.netkeiba.com/race/shutuba.html?race_id=<numeric_id>`` is
server-rendered HTML. Each runner is a ``<tr class="HorseList">`` row with
these cells (verified against the 2026-06-21 Tokyo R11 capture):

  - ``<td class="Waku N Txt_C"><span>N</span></td>`` -- bracket / wakuban
  - ``<td class="Umaman N Txt_C">N</td>`` -- horse number / umaban
  - ``<td class="HorseInfo">...<a href=".../horse/KETTO_NUM">BAMEI</a>...``
    -- horse_id + name
  - ``<td class="Barei Txt_C">牝4</td>`` -- sex/age (not parsed here)
  - ``<td class="Txt_C">56.0</td>`` -- carried weight (futan)
  - ``<td class="Jockey"><a href=".../jockey/result/recent/CODE/">NAME</a>``
    -- jockey_id
  - ``<td class="Trainer">...<a href=".../trainer/result/recent/CODE/">NAME``
    -- trainer_id
  - ``<td class="Weight">...</td>`` -- body weight (bataiju); empty pre-race

PIT COMPROMISE on available_at. shutuba.html carries no reliable publish
timestamp (see netkeiba_races's docstring for the full rationale). The parser
returns ``published_time=None``; :func:`_entry_record` falls back to
``captured_at`` (the scrape time) -- the honest upper bound on when this
version of the entries became visible. NOT the bulk-download trap: we fetch
the CURRENT live page.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any, Callable

from keibamon_core.adapters import netkeiba_http
from keibamon_core.ingestion.scrape_upsert import scrape_upsert
from keibamon_core.paths import LakePaths

SOURCE_NAME = "netkeiba"
BRONZE_SOURCE = "netkeiba_entries"
TABLE = "jravan_race_entries"
# Include source_name so a scrape row for the same (race, horse) as an existing
# JV-Link row COEXISTS rather than overwrites -- the cross-validation gate
# (tools/validate_scrape_vs_jravan.py) reads both sources side-by-side over the
# overlap window, and the placeholder-pair test relies on JV-Link + scrape rows
# for the same horse_number staying distinct.
NATURAL_KEY: tuple[str, ...] = ("race_id", "horse_number", "source_name")


def parse_entries_payload(
    payload_text: str, nk_race_id: str
) -> list[dict[str, Any]]:
    """Extract one intermediate runner dict per declared horse.

    Splits the shutuba page on ``<tr class="HorseList">`` and parses each row.
    Each runner dict carries the raw fields the record builder needs.

    Returns ``[]`` for a page with no HorseList rows (cancelled race, wrong
    page, pre-announcement). Per ADR-0004's "loud monitoring on scrape failure"
    mandate, a SHUTUBA page that exists but yields zero runners is a loud
    warning at the build_entries layer (the caller decides whether to raise);
    the parser itself is permissive about missing fields -- netkeiba's
    bloodline number (``ketto_num``) is sometimes blank for foreign IC-tagged
    horses, which is exactly the placeholder-trap case
    (``DATA_TRAPS['SE.ketto_num=0000000000']``). The record builder preserves
    ``horse_number`` so the (race_id, horse_number) join stays exact.

    ``published_time`` is always ``None`` (PIT compromise -- see module
    docstring); the caller falls back to ``captured_at``.
    """
    out: list[dict[str, Any]] = []
    # Each runner row starts with <tr class="HorseList" id="tr_N">. Split on
    # the opening tag; the first chunk is the page preamble.
    for row_html in re.split(r'<tr class="HorseList"[^>]*>', payload_text)[1:]:
        # One row ends at the next </tr>. Capture up to it.
        end = row_html.find("</tr>")
        if end >= 0:
            row_html = row_html[:end]

        umaban = _extract_umaban(row_html)
        if umaban is None:
            continue  # without umaban we cannot join to results/payouts -- skip
        rec: dict[str, Any] = {
            "horse_number": umaban,
            "gate": _extract_wakuban(row_html),
            "horse_id": _extract_horse_id(row_html),
            "horse_name": _extract_horse_name(row_html),
            "jockey_id": _extract_jockey_id(row_html),
            "trainer_id": _extract_trainer_id(row_html),
            "carried_weight_kg": _extract_carried_weight(row_html),
            "body_weight_kg": _extract_body_weight(row_html),
            # ADR-0006: opportunistic estimated odds for the live registration
            # feed. ADDITIVE -- _entry_record ignores it, so the jravan_*
            # silver shape and the cross-validation gate are untouched. None
            # when netkeiba has only rendered the JS placeholder (``---.-``).
            "est_odds": _extract_est_odds(row_html),
            "published_time": None,  # PIT compromise -- see module docstring
            "source_race_id": nk_race_id,
        }
        out.append(rec)
    return out


def _entry_record(
    race_id: str, raw: dict[str, Any], meta: dict[str, Any]
) -> dict[str, Any]:
    """Pure layer: one runner dict -> the EXACT jravan_race_entries silver shape.

    Column set is byte-identical to :func:`jravan_silver._entry_record` so
    stages 1/2/4 read scrape rows without code changes. ``available_at`` is
    the runner's published event time when present; falls back to
    ``captured_at`` floored to UTC midnight when the parser returned ``None``
    (PIT compromise for shutuba.html -- the page carries no publish
    timestamp). The midnight floor lets same-day re-scrapes dedupe under the
    partition-aware upsert.
    """
    bw = raw.get("body_weight_kg")  # 999=unweighable, 000=scratched -> not real
    published = _event_time_with_scrape_fallback(
        raw.get("published_time"), meta.get("captured_at")
    )
    horse_id = raw.get("horse_id") or "0000000000"
    return {
        "race_id": race_id,
        "horse_id": horse_id,
        "horse_name": raw.get("horse_name"),
        "horse_number": raw.get("horse_number"),
        "gate": raw.get("gate"),
        "jockey_id": raw.get("jockey_id"),
        "trainer_id": raw.get("trainer_id"),
        "carried_weight_kg": raw.get("carried_weight_kg"),
        "body_weight_kg": bw if bw and bw not in (0, 999) else None,
        # Provenance -- source_name distinguishes scrape rows from JV-Link.
        # ingested_at + published_time are STRINGS (matching the existing
        # jravan_* silver schema: JV-Link bronze writes ISO strings and the
        # silver builder passes them through). available_at stays datetime --
        # the only one of the three typed timestamp in the existing schema.
        # See netkeiba_http.format_provenance_iso for the BUG-4 rationale.
        "source_name": SOURCE_NAME,
        "source_record_id": meta.get("source_record_id"),
        "raw_uri": meta.get("raw_uri"),
        "content_hash": meta.get("content_hash"),
        "ingested_at": netkeiba_http.format_provenance_iso(meta.get("ingested_at")),
        "published_time": netkeiba_http.format_provenance_iso(published),
        "available_at": published,
    }


def _event_time_with_scrape_fallback(
    published: datetime | None, captured_at: datetime | None
) -> datetime | None:
    """Pick the event time for ``available_at`` / ``published_time`` columns.

    Mirrors :func:`netkeiba_races._event_time_with_scrape_fallback`: prefer a
    real publish time; else fall back to ``captured_at`` floored to UTC
    midnight so same-day re-scrapes dedupe under the partition-aware upsert.
    Kept local to avoid a cross-adapter import (the entries adapter is
    standalone by design).
    """
    if published is not None:
        return published
    if captured_at is None:
        return None
    if captured_at.tzinfo is None:
        from datetime import timezone as _tz
        captured_at = captured_at.replace(tzinfo=_tz.utc)
    return captured_at.replace(hour=0, minute=0, second=0, microsecond=0)


def build_entries(
    lake: LakePaths,
    nk_race_id: str,
    race_id: str,
    *,
    fetch_fn: Callable[[str], str] | None = None,
    captured_at: datetime | None = None,
    payload_text: str | None = None,
) -> int:
    """Fetch one race's entries -> bronze archive -> silver upsert.

    Pipeline: fetch (or use ``payload_text`` if given, the test seam) ->
    archive raw to bronze once (sha256 change-detected) -> parse -> upsert.

    ``fetch_fn`` mirrors the injection seam pattern in
    ``weekend.pipeline.post`` and ``weekend.settle_card``: tests pass a stub
    that returns a fixture body and the network is never touched. When neither
    ``fetch_fn`` nor ``payload_text`` is given, the polite-fetch path from
    :mod:`adapters.netkeiba_http` is used.

    Returns the number of NEW silver rows (re-ingesting an unchanged payload
    returns 0).
    """
    captured_at = captured_at or netkeiba_http.utc_now()
    if payload_text is None:
        fetch_fn = fetch_fn or _default_fetch
        payload_text = fetch_fn(nk_race_id)

    raw_path = netkeiba_http.archive_raw(
        lake, BRONZE_SOURCE, nk_race_id, "entries", payload_text, captured_at
    )
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = netkeiba_http.utc_now()

    parsed = parse_entries_payload(payload_text, nk_race_id)
    records = [
        _entry_record(
            race_id,
            raw,
            {
                "source_record_id": f"{nk_race_id}:entries",
                "raw_uri": str(raw_path),
                "content_hash": content_hash,
                "ingested_at": ingested_at,
                "captured_at": captured_at,  # for the available_at fallback
            },
        )
        for raw in parsed
    ]
    _stamp_partition_keys(records, race_id)
    return scrape_upsert(lake, TABLE, records, natural_key=NATURAL_KEY)


# --- internals ----------------------------------------------------------------


def _default_fetch(nk_race_id: str) -> str:
    """Polite fetch via :mod:`netkeiba_http`."""
    url = (
        f"https://race.netkeiba.com/race/shutuba.html?race_id={nk_race_id}"
    )
    body, _ = netkeiba_http.fetch_payload(url)
    return body


def _stamp_partition_keys(records: list[dict[str, Any]], race_id: str) -> None:
    """Derive ``year``+``venue`` from the canonical race_id (same logic as
    :func:`jravan_silver._write_silver`)."""
    parts = race_id.split("-")
    year = int(parts[1][:4]) if len(parts) > 1 and parts[1][:4].isdigit() else 0
    venue = parts[2] if len(parts) > 2 else "unknown"
    for r in records:
        r["year"] = year
        r["venue"] = venue


# --- HTML extractors (the brittle layer) --------------------------------------
#
# Each extractor operates on ONE ``<tr class="HorseList">`` row. The page
# tested against is tests/fixtures/netkeiba/shutuba_202605030611.html (the
# live 2026-06-21 Tokyo R11 Fuchu Himba S capture).


def _extract_umaban(row: str) -> int | None:
    """``<td class="UmabanN Txt_C">N</td>`` -- the second cell. The class name
    encodes the umaban (defensive: parse the cell TEXT not the class, since
    we key everything else off the text too)."""
    m = re.search(r'class="Umaban[0-9]+ Txt_C">\s*([0-9]{1,2})\s*<', row)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _extract_wakuban(row: str) -> int | None:
    """``<td class="WakuN Txt_C"><span>N</span></td>`` -- bracket / gate."""
    m = re.search(r'class="Waku[0-9]+ Txt_C">\s*<span>\s*([0-9]{1,2})\s*</span>', row)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _extract_horse_id(row: str) -> str | None:
    """``<a href="https://db.netkeiba.com/horse/KETTO_NUM" ...>`` -- the
    bloodline registration number. May be blank for foreign IC-tagged horses;
    the record builder maps missing/blank to '0000000000' (placeholder trap)."""
    m = re.search(r'db\.netkeiba\.com/horse/([0-9]{10})', row)
    return m.group(1) if m else None


def _extract_horse_name(row: str) -> str | None:
    """``<span class="HorseName"><a ... title="NAME">NAME</a></span>``. The
    ``title=`` attribute is the full name; the inner text is sometimes
    truncated with an ellipsis. Prefer the title attribute."""
    m = re.search(r'<span class="HorseName">\s*<a [^>]*title="([^"]+)"', row)
    if m:
        return m.group(1).strip()
    # Fallback: pull the inner text of the HorseName span's anchor.
    m = re.search(r'<span class="HorseName">\s*<a [^>]*>([^<]+)<', row)
    return m.group(1).strip() if m else None


def _extract_jockey_id(row: str) -> str | None:
    """``<a href="https://db.netkeiba.com/jockey/result/recent/CODE/">NAME</a>``
    -- the 5-digit jockey code."""
    m = re.search(r'db\.netkeiba\.com/jockey/result/recent/([0-9]{5})/', row)
    return m.group(1) if m else None


def _extract_trainer_id(row: str) -> str | None:
    """``<a href="https://db.netkeiba.com/trainer/result/recent/CODE/">NAME</a>``
    -- the 5-digit trainer code."""
    m = re.search(r'db\.netkeiba\.com/trainer/result/recent/([0-9]{5})/', row)
    return m.group(1) if m else None


def _extract_carried_weight(row: str) -> float | None:
    """``<td class="Txt_C">56.0</td>`` -- carried weight (futan) in kg. Sits
    between Barei (sex/age) and Jockey cells. We extract the FIRST float
    following a ``Txt_C`` cell after the Barei cell -- there are several
    Txt_C cells in a row, so positional anchoring on Barei is the safest
    discriminator."""
    m = re.search(
        r'class="Barei[^"]*"[^<]*</td>\s*<td class="Txt_C">\s*([0-9]{1,3}\.[0-9])\s*<',
        row,
    )
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


def _extract_body_weight(row: str) -> int | None:
    """``<td class="Weight">N</td>`` -- body weight (bataiju) in kg. Empty
    pre-race (declared entries before race-day weigh-in)."""
    m = re.search(r'class="Weight">\s*([0-9]{3})\s*<', row)
    if not m:
        return None
    try:
        return int(m.group(1))
    except ValueError:
        return None


def _extract_est_odds(row: str) -> float | None:
    """``<span id="odds-...">VALUE</span>`` -- netkeiba's win-odds cell.

    ADR-0006 (registration feed). Before betting opens this span is the JS
    placeholder ``---.-`` (and ninki is ``**``); once netkeiba renders a
    forecast/early number we capture it as the *estimated* odds shown on the
    grayed pre-market card. Returns ``None`` for the placeholder, a non-numeric
    cell, or odds < 1.0 (impossible -- treat as not-yet-priced). We never
    fabricate an estimate; absence stays ``None`` and the app grays the runner.
    """
    m = re.search(r'<span id="odds-[^"]*"[^>]*>\s*([^<]*?)\s*</span>', row)
    if not m:
        return None
    raw = m.group(1).strip()
    try:
        val = float(raw)
    except ValueError:
        return None  # '---.-', '**', empty, etc.
    return val if val >= 1.0 else None
