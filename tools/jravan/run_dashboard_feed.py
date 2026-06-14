"""run_dashboard_feed.py -- race-day live dashboard feed (Mac).

Polls the full Hanshin card from netkeiba's win/place JSON API (the tested poller
fetch/parse path), tracks each horse's OPENING odds, flags *residual* drift
(movement against the race's own field-wide pool compression -- the honest signal,
not raw shortening which is mostly pool-fill noise; see polling/drift.py), and
pushes the whole-card snapshot to Cloudflare D1 so splash/live.html updates on
your phone. Reliable, dependency-light, runs on the Mac:

    PYTHONPATH=src ./venv64/bin/python tools/jravan/run_dashboard_feed.py

Needs the CF_* env vars (CF_API_TOKEN/CF_ACCOUNT_ID/CF_D1_DATABASE_ID) set, the
same ones the JV-Link publish uses. NOT a betting recommender: a residual flag is
a market-movement indicator to watch (and to log for the curve backtest), never a
reason to bet. Ctrl-C to stop.
"""
from __future__ import annotations

import sys
import time
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))  # for publish_d1
from keibamon_core.ingestion.odds import append_odds_snapshots  # noqa: E402
from keibamon_core.paths import LakePaths  # noqa: E402
from keibamon_core.polling.drift import residual_edges  # noqa: E402
from keibamon_core.polling.netkeiba import fetch_odds_payload, parse_odds_payload  # noqa: E402
from publish_d1 import push_to_d1  # noqa: E402

LAKE = LakePaths()   # also bank the curve to silver odds_snapshots (PIT time series)

POLL_SECONDS = 120
NK_PREFIX = "2026090304"         # Hanshin 2026-06-14: netkeiba race id = prefix + 2-digit race no
R11_NAMES = {
    1: "ダノンデサイル", 2: "ミュージアムマイル", 3: "シュガークン", 4: "ミクニインスパイア",
    5: "クロワデュノール", 6: "ビザンチンドリーム", 7: "ファミリータイム", 8: "タガノデュード",
    9: "コスモキュランダ", 10: "ジューンテイク", 11: "シンエンペラー", 12: "マイネルエンペラー",
    13: "シェイクユアハート", 14: "スティンガーグラス", 15: "マイユニバース", 16: "メイショウタバル",
    17: "レガレイラ", 18: "ミステリーウェイ",
}

_open: dict[tuple[int, int], float] = {}   # (race_no, umaban) -> opening win odds


def _race(race_no: int) -> dict:
    nk_id = f"{NK_PREFIX}{race_no:02d}"   # e.g. 202609030401 .. 202609030412
    captured = datetime.now(timezone.utc)
    try:
        payload = fetch_odds_payload(nk_id, "1")
        recs = parse_odds_payload(payload, race_id=f"r-2026-0614-hanshin-{race_no:02d}",
                                  raw_uri=f"netkeiba:{nk_id}", captured_at=captured)
    except Exception as exc:  # noqa: BLE001 - one race must not kill the loop
        print(f"  R{race_no}: fetch failed ({exc!r})")
        recs = []

    if recs:
        try:
            append_odds_snapshots(LAKE, recs)   # bank the curve to the lake (deduped)
        except Exception as exc:  # noqa: BLE001 - banking must not kill the feed
            print(f"  R{race_no}: lake append failed ({exc!r})")

    # First pass: lock opening prices and collect (umaban, win, open) for the
    # field so residual drift is measured against this race's own compression.
    rows = []
    for r in recs:
        uma, win = r["horse_number"], r.get("win_odds")
        key = (race_no, uma)
        if win and key not in _open:
            _open[key] = win                # first sighting = opening price
        rows.append((uma, win, _open.get(key)))
    edges = residual_edges(rows)            # {umaban: EdgeFlag} for the real movers only

    runners = []
    for r in recs:
        uma, win = r["horse_number"], r.get("win_odds")
        win_open = _open.get((race_no, uma))
        flag = edges.get(uma)
        runners.append({
            "umaban": uma, "name": R11_NAMES.get(uma) if race_no == 11 else None,
            "win_odds": win, "win_open": win_open,
            "place_low": r.get("place_low"), "place_high": r.get("place_high"),
            "edge_label": flag.label if flag else None,
            "drift_dir": flag.direction if flag else None,   # firming|draining
            "drift_z": round(flag.z, 1) if flag else None,
        })
    return {
        "race_no": race_no, "race_id": f"r-2026-0614-hanshin-{race_no:02d}",
        "name": "Takarazuka Kinen (G1)" if race_no == 11 else f"Race {race_no}",
        "post_time_jst": "15:40" if race_no == 11 else "—",
        "status": "open" if runners else "waiting", "result": None,
        "capture": {"last_update": datetime.now(timezone.utc).isoformat(),
                    "polls": 1, "pools": ["win_place"]},
        "runners": runners,
    }


def main() -> None:
    print("dashboard feed: polling Hanshin R1-R12 every", POLL_SECONDS, "s (Ctrl-C to stop)")
    while True:
        races = [_race(n) for n in range(1, 13)]
        movers = sum(1 for r in races for x in r["runners"] if x.get("edge_label"))
        snap = {"meta": {"venue": "Hanshin", "date": "2026-06-14", "status": "live",
                         "source": "netkeiba-live",
                         "message": "Live win/place odds. ▼=firming vs field (money in), "
                                    "▲=draining vs field. Residual move vs this race's own pool "
                                    "compression -- filters pool-fill noise. Watch only, not a bet signal.",
                         "published_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")},
                "races": races}
        try:
            push_to_d1(snap)
            print(f"[{datetime.now():%H:%M:%S}] pushed; {movers} residual flag(s)")
        except Exception as exc:  # noqa: BLE001
            print(f"[{datetime.now():%H:%M:%S}] publish failed: {exc!r}")
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nstopped.")
