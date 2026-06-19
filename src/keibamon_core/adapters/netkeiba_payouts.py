"""netkeiba payout-table adapter -> ``jravan_payouts``.

This is the adapter Stage-4 settlement reads. Same three-layer shape as the
entries/results adapters, plus three correctness invariants the silver shape
already enforces for JV-Link rows:

  - **One row per winning combo per pool.** A list-valued pool in the source
    (dead-heat place / wide) emits one row per (combo, payout) on the page.
    The parser does NOT dedupe -- :func:`settlement._load_official_payouts`
    MAX-collapses duplicates on read.
  - **Combos canonicalized via ``settlement._normalize_selection``.** Win/place
    -> ``"01"``; quinella/wide -> ``"0108"``; trifecta -> ``"010809"``;
    bracket_quinella -> ``"23"``. This is what makes new scrape rows slot into
    ``settle_many``'s lookup unchanged.
  - **All eight pools.** win, place, bracket_quinella, quinella, wide, exacta,
    trio, trifecta.

WIRE FORMAT. ``race.netkeiba.com/race/result.html?race_id=<numeric_id>`` is
server-rendered HTML. The payouts live in one or more
``<table class="Payout_Detail_Table">`` blocks. Each block has one ``<tr>`` per
pool, with class signaling the pool:

    ==================== ================= ==================== ====================
    Row class            Pool              Combo structure     Result cell layout
    ==================== ================= ==================== ====================
    Tansho               win               single horse        one ``<div>``
    Fukusho              place             N horses (top-3)    N ``<div>`` blocks
    Wakuren              bracket_quinella  2 brackets          one ``<ul>`` (2 li)
    Umaren               quinella          2 horses            one ``<ul>`` (2 li)
    Wide                 wide              N pairs             N ``<ul>`` blocks
    Umatan               exacta            2 horses ordered    one ``<ul>`` (2 li)
    Fuku3                trio              3 horses            one ``<ul>`` (3 li)
    Tan3                 trifecta          3 horses ordered    one ``<ul>`` (3 li)
    ==================== ================= ==================== ====================

Each row's ``<td class="Payout">`` carries payout values (yen); multi-combo
rows separate them with ``<br />``. ``<td class="Ninki">`` similarly separates
popularity ranks.

Verified against ``tests/fixtures/netkeiba/result_202609030411.html`` (the
live 2026-06-14 宝塚記念 G1 capture). That race's Fukusho row carries three
winning horses (16/5/1) each with its own payout -- exactly the multi-row
shape this parser was designed for.

PIT COMPROMISE on available_at. ``result.html`` carries no reliable publish
timestamp in its static HTML. The parser returns ``published_time=None``;
:func:`_payout_record` falls back to ``captured_at`` (the scrape time). NOT
the bulk-download trap: we fetch the live page.
"""
from __future__ import annotations

import hashlib
import re
from datetime import datetime
from typing import Any, Callable

from keibamon_core.adapters import netkeiba_http
from keibamon_core.ingestion.scrape_upsert import scrape_upsert
from keibamon_core.paths import LakePaths

# Canonicalize combos through settlement's own normalization so the new rows
# slot into settle_many's lookup unchanged. ``_normalize_selection`` is the
# oracle's lookup key formatter -- reusing it here is the load-bearing contract.
from keibamon_core.ingestion.settlement import _normalize_selection

SOURCE_NAME = "netkeiba"
BRONZE_SOURCE = "netkeiba_payouts"
TABLE = "jravan_payouts"
# Include source_name so a scrape payout row coexists with the JV-Link row for
# the same (race, pool, combo) -- the cross-validation gate compares them
# side-by-side. settlement._load_official_payouts MAX-collapses per
# (race, pool, combo) regardless of source, so duplicate JV-Link + scrape
# rows on the read side still resolve to one payout; only the SILVER table
# keeps both observations distinct for the audit.
NATURAL_KEY: tuple[str, ...] = ("race_id", "pool", "combo", "source_name")

# netkeiba's row-class -> silver pool vocabulary. ``_normalize_selection`` keys
# off these labels (the same vocabulary settlement.py uses).
_POOL_ROW_CLASS: dict[str, str] = {
    "Tansho": "win",
    "Fukusho": "place",
    "Wakuren": "bracket_quinella",
    "Umaren": "quinella",
    "Wide": "wide",
    "Umatan": "exacta",
    "Fuku3": "trio",
    "Tan3": "trifecta",
}


def parse_payouts_payload(
    payload_text: str, nk_race_id: str
) -> list[dict[str, Any]]:
    """Extract one intermediate dict per (pool, combo, payout) on the page.

    Walks each ``<tr class="(Tansho|Fukusho|Wakuren|...)">`` row inside any
    ``<table class="Payout_Detail_Table">`` block and emits one record per
    (pool, combo, payout, popularity) tuple. Multi-combo rows (place/wide with
    dead-heats or top-3) fan out -- the parser pairs the N result combos with
    the N payout values via positional zip.

    Returns ``[]`` for a page with no Payout_Detail_Table blocks (race not yet
    decided; pre-result shutuba page). The parser does NOT raise on a missing
    popularity column (older races may omit it) -- those rows carry
    ``popularity=None``.

    Combos are returned in RAW form (concatenated digits, e.g. ``'516'`` or
    ``'16'``); :func:`_payout_record` runs them through
    :func:`settlement._normalize_selection` to canonicalize.

    ``published_time`` is always ``None`` (PIT compromise -- see module
    docstring); the caller falls back to ``captured_at``.
    """
    out: list[dict[str, Any]] = []
    # Walk every <tr class="POOL"> row on the page. The Payout_Detail_Table
    # blocks split across multiple <table> elements (one for single-row pools,
    # one for wide+exotics), so a per-row scan is cleaner than per-table.
    row_class_alt = "|".join(_POOL_ROW_CLASS)
    for m in re.finditer(
        rf'<tr class="({row_class_alt})"[^>]*>(.*?)</tr>',
        payload_text, re.S,
    ):
        row_class = m.group(1)
        body = m.group(2)
        pool = _POOL_ROW_CLASS[row_class]
        combos = _extract_combos(body, pool)
        payouts = _extract_payouts(body)
        popularities = _extract_popularities(body)

        # Pair up positionally. If the counts mismatch (a parse bug or a
        # page-format change), we drop the tail rather than guess -- a missing
        # combo is loud-at-build-layer; a misaligned combo is silently wrong.
        n = min(len(combos), len(payouts)) if payouts else 0
        for i in range(n):
            combo = combos[i]
            payout = payouts[i]
            pop = popularities[i] if i < len(popularities) else None
            out.append({
                "pool": pool,
                "combo_raw": combo,
                "payout_yen": payout,
                "popularity": pop,
                "published_time": None,  # PIT compromise -- see module docstring
                "source_race_id": nk_race_id,
            })
    return out


def _payout_record(
    race_id: str, raw: dict[str, Any], meta: dict[str, Any]
) -> dict[str, Any]:
    """Pure layer: one (pool, combo, payout) -> the EXACT jravan_payouts shape.

    Combos are canonicalized through :func:`settlement._normalize_selection` --
    the same function the settlement oracle uses to look up a bet's payout --
    so the scrape rows drop into ``settle_many``'s map unchanged. Mirrors
    :func:`jravan_silver.build_jravan_payouts` byte-for-byte (column set +
    provenance). ``available_at`` is the published event time when present;
    falls back to ``captured_at`` floored to UTC midnight when the parser
    returned ``None`` (PIT compromise for result.html -- the page carries no
    publish timestamp). The midnight floor lets same-day re-scrapes dedupe.
    """
    published = _event_time_with_scrape_fallback(
        raw.get("published_time"), meta.get("captured_at")
    )
    return {
        "race_id": race_id,
        "pool": raw["pool"],
        "combo": _normalize_selection(raw["combo_raw"], raw["pool"]),
        "payout_yen": raw["payout_yen"],
        "popularity": raw.get("popularity"),
        # Provenance -- ingested_at + published_time stringified to match the
        # existing jravan_* silver schema (string columns). See
        # netkeiba_http.format_provenance_iso for the BUG-4 rationale.
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

    Mirrors :func:`netkeiba_races._event_time_with_scrape_fallback`. Kept
    local so this module stays standalone.
    """
    if published is not None:
        return published
    if captured_at is None:
        return None
    if captured_at.tzinfo is None:
        from datetime import timezone as _tz
        captured_at = captured_at.replace(tzinfo=_tz.utc)
    return captured_at.replace(hour=0, minute=0, second=0, microsecond=0)


def build_payouts(
    lake: LakePaths,
    nk_race_id: str,
    race_id: str,
    *,
    fetch_fn: Callable[[str], str] | None = None,
    captured_at: datetime | None = None,
    payload_text: str | None = None,
) -> int:
    """Fetch one race's payouts -> bronze archive -> silver upsert.

    See :func:`netkeiba_entries.build_entries` for the seam contract. Returns
    the count of NEW silver rows. Re-running an already-settled day returns 0.
    """
    captured_at = captured_at or netkeiba_http.utc_now()
    if payload_text is None:
        fetch_fn = fetch_fn or _default_fetch
        payload_text = fetch_fn(nk_race_id)

    raw_path = netkeiba_http.archive_raw(
        lake, BRONZE_SOURCE, nk_race_id, "payouts", payload_text, captured_at
    )
    content_hash = hashlib.sha256(payload_text.encode("utf-8")).hexdigest()
    ingested_at = netkeiba_http.utc_now()

    parsed = parse_payouts_payload(payload_text, nk_race_id)
    records = [
        _payout_record(
            race_id,
            raw,
            {
                "source_record_id": f"{nk_race_id}:payouts",
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
    url = f"https://race.netkeiba.com/race/result.html?race_id={nk_race_id}"
    body, _ = netkeiba_http.fetch_payload(url)
    return body


def _stamp_partition_keys(records: list[dict[str, Any]], race_id: str) -> None:
    parts = race_id.split("-")
    year = int(parts[1][:4]) if len(parts) > 1 and parts[1][:4].isdigit() else 0
    venue = parts[2] if len(parts) > 2 else "unknown"
    for r in records:
        r["year"] = year
        r["venue"] = venue


# --- HTML extractors (the brittle layer) --------------------------------------
#
# Each payout row has three cells we care about:
#   <td class="Result">...</td>     -- the winning combos (one or many)
#   <td class="Payout">...</td>     -- the payout yen values (one or many)
#   <td class="Ninki">...</td>      -- the popularity ranks (one or many)
#
# Multi-combo rows (Fukusho with top-3, Wide with N pairs) split Result into
# multiple <div> or <ul> blocks; Payout splits on <br />; Ninki splits on
# <span>. The parser pairs them positionally.


def _extract_combos(cell_html: str, pool: str) -> list[str]:
    """Pull the result cell's combos and return them as a list of raw strings.

    The result-cell layout depends on pool:

      - For win/place: each non-empty ``<div>`` block is one combo (single
        horse number). Example: Fukusho's three top-3 finishers.
      - For other multi-horse pools (quinella/wide/exacta/trio/trifecta): each
        ``<ul>`` block is one combo (multiple horse numbers). Wide with three
        winning pairs has three ``<ul>`` blocks.
      - For bracket_quinella: each ``<ul>`` block is one combo of two bracket
        numbers (single-digit, like '38').

    Combo-string shape (raw, pre-normalization):

      - win/place:        ``'16'`` (horse number verbatim)
      - bracket_quinella: ``'38'`` (brackets concatenated; single-part
                            passthrough in ``_normalize_selection`` preserves
                            the single-digit form)
      - multi-horse pool: ``'5-16'`` (dash-separated; ``_normalize_selection``
                            pads each part to 2 digits and joins)
    """
    combos: list[str] = []
    if pool in ("win", "place"):
        # Each <div>...</div> block holds one winning horse number.
        for block in re.findall(r'<div[^>]*>(.*?)</div>', cell_html, re.S):
            nums = re.findall(r'<span>\s*([0-9]{1,2})\s*</span>', block)
            if nums:
                combos.append(nums[0])
        # Fallback for pages without div wrappers: pull spans directly.
        if not combos:
            nums = re.findall(r'<span>\s*([0-9]{1,2})\s*</span>', cell_html)
            combos.extend(nums)
        return combos

    # Multi-horse pools: each <ul> block is one combo.
    uls = re.findall(r'<ul[^>]*>(.*?)</ul>', cell_html, re.S)
    if not uls:
        # Page variant: a single combo without <ul> wrapper (older format).
        nums = re.findall(r'<span>\s*([0-9]{1,2})\s*</span>', cell_html)
        if nums:
            uls = ["<ul>" + "".join(f"<span>{n}</span>" for n in nums) + "</ul>"]
    for ul in uls:
        nums = re.findall(r'<span>\s*([0-9]{1,2})\s*</span>', ul)
        if not nums:
            continue
        if pool == "bracket_quinella":
            # Bracket numbers are single-digit (1-8) -- concatenate directly
            # so _normalize_selection's single-part passthrough preserves the
            # '38' form the JV-Link silver uses.
            combos.append("".join(nums))
        else:
            # Multi-horse pools -- dash-join so _normalize_selection pads each
            # horse to 2 digits ('5-16' -> '0516').
            combos.append("-".join(nums))
    return combos


def _extract_payouts(cell_html: str) -> list[int]:
    """Pull each ``N円`` value out of the Payout cell. Splits on ``<br />`` for
    multi-payout rows. Values like '1,360円' have the comma stripped."""
    # Normalize <br /> variants to a consistent separator.
    text = re.sub(r'<br\s*/?>', '|', cell_html)
    # Strip remaining tags.
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    payouts: list[int] = []
    for chunk in text.split('|'):
        m = re.search(r'([0-9,]+)\s*円', chunk)
        if not m:
            continue
        try:
            payouts.append(int(m.group(1).replace(',', '')))
        except ValueError:
            continue
    return payouts


def _extract_popularities(cell_html: str) -> list[int | None]:
    """Pull each ``N人気`` rank out of the Ninki cell. One per ``<span>``."""
    spans = re.findall(r'<span>\s*([0-9]{1,2})\s*人気\s*</span>', cell_html)
    out: list[int | None] = []
    for s in spans:
        try:
            out.append(int(s))
        except ValueError:
            out.append(None)
    return out
