#!/usr/bin/env python3
"""Backfill fix (part 1 of 2) — re-fetch the official result for two 2026-06-28
races so three orphaned My Tickets rows can finally settle.

## Background

Three tickets (kb-mqwyu29w, kb-mqwyu4ms, kb-mqwyueff) were committed against
20260628|Fukushima|11|ラジオNIK (x2) and 20260628|Hakodate|11|函館記念 (x1).
Every OTHER ticket on those exact two races settled correctly (some via a
2026-07-03 manual lake backfill, some via the live cron sweep) -- so the
result data was real and resolvable. These three specifically fell through a
narrow gap: a ~45-minute window that same day where the two races were
apparently absent from `/api/live`'s snapshot (matching a known bug class --
see `docs/prompts/r3-resettlement-and-publish-fix.md`), and neither the
2026-07-03 backfill's cutoff nor the live sweep's race_key-presence check ever
touched these three rows again. `settle_result_hash` is NULL on all three --
confirmed no settle path has EVER run against them.

`/api/live` no longer carries 20260628 at all (it's a rolling window), so
there's nothing left to re-match against there. This script goes straight to
the original source instead: it re-discovers the 2026-06-28 card and re-fetches
+ re-parses BOTH races' official result.html pages, using the exact same
adapters (`netkeiba_discovery`, `netkeiba_results`, `netkeiba_payouts`,
`live.result.build_result`) the production pipeline already uses -- so this is
not a new, unverified code path, just a targeted re-run of the existing one
against a historical date.

Output: a JSON file mapping race_key -> RaceResult (the exact shape
`workers/social/src/settle.ts` consumes: `{placings, payouts, scratched?}`).
Part 2 (`workers/social/scripts/backfill-stuck-tickets.ts`) reads that file,
resolves the three tickets against it, and prints (or applies, with --apply)
the D1 UPDATE.

This script is READ-ONLY against the lake and the network -- it writes only
the output JSON file. No ticket, no D1 row, no lake table is touched here.

Usage:
    PYTHONPATH=src python tools/jravan/backfill_20260628_results.py \\
        --out /tmp/backfill_20260628_results.json

Run on the Mac (mac-dev) -- see docs/prompts/backfill-stuck-june28-tickets.md.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))

from keibamon_core.adapters import netkeiba_http  # noqa: E402
from keibamon_core.adapters.netkeiba_discovery import discover_card  # noqa: E402
from keibamon_core.adapters.netkeiba_payouts import parse_payouts_payload  # noqa: E402
from keibamon_core.adapters.netkeiba_results import parse_results_payload  # noqa: E402
from keibamon_core.live.result import build_result  # noqa: E402

DATE = "20260628"

# The two stuck races. venue_ja must match the netkeiba day-index venue name
# exactly as discover_card surfaces it (Japanese venue name, not the English
# label used in the ticket's race_key -- see VENUE_JA_TO_EN below).
TARGETS = [
    {"venue_ja": "福島", "venue_en": "Fukushima", "race_no": 11, "name": "ラジオNIK"},
    {"venue_ja": "函館", "venue_en": "Hakodate", "race_no": 11, "name": "函館記念"},
]


def race_key(venue_en: str, race_no: int, name: str) -> str:
    """Mirror the frontend's raceKeyOf / mtRaceKey: date|venue|race_no|name."""
    return f"{DATE}|{venue_en}|{race_no}|{name}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--out",
        default="/tmp/backfill_20260628_results.json",
        help="Where to write the race_key -> RaceResult JSON (default: /tmp/backfill_20260628_results.json)",
    )
    args = ap.parse_args()

    print(f"Discovering the {DATE} card...")
    discovered = discover_card(DATE)
    print(f"  {len(discovered)} races found on netkeiba's day index.")

    out: dict[str, dict] = {}
    missing: list[str] = []

    for target in TARGETS:
        match = next(
            (
                d
                for d in discovered
                if d.venue_code and VENUE_CODE_JA.get(d.venue_code) == target["venue_ja"]
                and d.race_no == target["race_no"]
            ),
            None,
        )
        # Fallback: some discover_card versions expose the JA venue name
        # directly rather than only a code -- try that shape too.
        if match is None:
            match = next(
                (
                    d
                    for d in discovered
                    if getattr(d, "venue_name", None) == target["venue_ja"]
                    and d.race_no == target["race_no"]
                ),
                None,
            )
        key = race_key(target["venue_en"], target["race_no"], target["name"])
        if match is None:
            print(f"  MISSING from day index: {key} ({target['venue_ja']} R{target['race_no']})")
            missing.append(key)
            continue

        print(f"  found {key} -> netkeiba race_id={match.numeric_id}")
        url = f"https://race.netkeiba.com/race/result.html?race_id={match.numeric_id}"
        body, _ = netkeiba_http.fetch_payload(url)
        finishers = parse_results_payload(body, match.numeric_id)
        payouts = parse_payouts_payload(body, match.numeric_id)
        result = build_result(finishers, payouts)
        if not result:
            print(f"    build_result returned {{}} -- page may not be official/parseable. Skipping {key}.")
            missing.append(key)
            continue
        print(
            f"    placings={result.get('placings')} "
            f"payout_rows={len(result.get('payouts', []))} "
            f"scratched={result.get('scratched', [])}"
        )
        out[key] = result

    out_path = Path(args.out)
    out_path.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {len(out)} race result(s) to {out_path}")
    if missing:
        print(f"WARNING: {len(missing)} target race(s) could not be resolved: {missing}")
        print("Do NOT proceed to part 2 for those race_keys until this is fixed.")
        return 1
    return 0


# Minimal JRA venue-code -> JA name map, only for the venues these two targets
# need. Keep in sync with tools/jravan/expose_live.py:VENUE_NAMES if extended.
VENUE_CODE_JA = {
    "02": "函館",
    "03": "福島",
}


if __name__ == "__main__":
    raise SystemExit(main())
