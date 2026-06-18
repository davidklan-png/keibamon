"""realtime_jvlink.py -- Windows JV-Link REALTIME odds -> immutable RAW bronze (keibamon).

RUN ON THE WINDOWS PC under the 32-bit Python venv (JV-Link is 32-bit COM),
alongside ingest_jvlink.py. Requires an ACTIVE JRA-VAN DataLab membership and the
利用キー set in JV-Link's settings (JVSetUIProperties / JVSetServiceKey). The
realtime (速報系) specs authenticate against that key; the historical JVOpen pull
does not. If JVRTOpen returns -303 the 利用キー is not set; -301/-302 means the
account/membership is not active.

    set KEIBAMON_LAKE=D:\\keibamon\\data
    C:\\keibamon\\venv32\\Scripts\\python tools\\jravan\\realtime_jvlink.py ^
        --races races_2026-06-14_hanshin.json --stop-after-post 10

Pulls 速報オッズ全賭式 (0B30 -- win/place/bracket/quinella/wide/exacta/trio/
trifecta in ONE call) on a cadence that tightens toward post time, writing each
CHANGED snapshot as immutable RAW bronze with the same seven metadata fields as
ingest_jvlink. Silver parsing reuses src/keibamon_core/adapters/jravan
``parse_grouped_record`` on the Mac -- realtime records are the SAME O1-O6 layout,
so NO new parser is needed. (Publishing a derived snapshot to the Cloudflare D1
dashboard is a separate step; see publish hook at the bottom.)

SKELETON: confirm the JVRTOpen signature and the 0B30 race-key format against your
JV-Link / JV-Data spec PDFs and SDK version (mirrors ingest_jvlink's caveat). The
realtime call flow, change-detection, adaptive cadence and bronze writing are
complete in shape.

Realtime data specs (速報系; require active membership + 利用キー):
  0B30  速報オッズ(全賭式)   all pools, one call          <- used here
  0B31..0B36                 per-pool, if needed individually
  0B41 / 0B42  時系列オッズ   pre-assembled curve (win/place/bracket, quinella),
                              retained 1 year -> backfillable via JVOpen once licensed
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import hashlib
import json
import os
import sys
import time
from pathlib import Path

import win32com.client  # pywin32 (Windows only)

SID = os.environ.get("JRAVAN_SID", "UNLP00000000")
LAKE = Path(os.environ.get("KEIBAMON_LAKE", "data"))
BRONZE = LAKE / "raw" / "jravan_rt"          # realtime bronze, distinct from bulk jravan
STATE = BRONZE / "_rt_state.json"            # {race_key: last_payload_sha256} for change-detection
ENCODING = "cp932"
SOURCE_NAME = "jravan_rt"
REALTIME_SPEC = "0B30"                       # 速報オッズ(全賭式)

# (minutes-before-post threshold, poll interval seconds) -- mirror the netkeiba poller.
SCHEDULE = ((180, 900), (60, 600), (30, 300), (10, 120), (0, 60))
STOP_AFTER_POST_MIN = 10

# Optional live-dashboard publish: parse the O1 win/place block with the shared
# adapter and push the whole-card snapshot to Cloudflare D1. No-op unless the repo
# src is importable AND CF_* env vars are set, so raw capture never depends on it.
try:
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "src"))
    from keibamon_core.adapters.jravan import JravanSourceAdapter
    from publish_d1 import push_to_d1
    _PUBLISH = bool(os.environ.get("CF_API_TOKEN"))
except Exception:  # pragma: no cover - publish is best-effort; capture still runs
    _PUBLISH = False


def _runners_from_o1(records) -> list[dict]:
    """Win/place runners from the O1 record of a 0B30 pull, for the dashboard."""
    o1 = next(({"record_id": rid, "raw": raw} for rid, raw, _ in records if rid == "O1"), None)
    if not o1:
        return []
    parsed = JravanSourceAdapter.parse_grouped_record(o1)
    win = {e["combo"]: e for e in parsed["entries"] if e["bet_type"] == "win"}
    place = {e["combo"]: e for e in parsed["entries"] if e["bet_type"] == "place"}
    runners = []
    for umaban in sorted(set(win) | set(place), key=int):
        w, p = win.get(umaban, {}), place.get(umaban, {})
        runners.append({
            "umaban": int(umaban), "win_odds": w.get("odds"), "win_open": None,
            "place_low": p.get("odds_low"), "place_high": p.get("odds_high"),
            "popularity": w.get("popularity"), "model_rank": None,
        })
    return runners


def jra_race_key(r: dict) -> str:
    """Build the JVRTOpen race key for odds from a race spec.

    CONFIRM the exact 0B30 key format against the JV-Link spec. The standard race
    specifier is 16 chars: YYYY(4) MMDD(4) JyoCD(2) Kaiji(2) Nichiji(2) RaceNum(2),
    e.g. 2026 0614 09 03 04 11 -> '2026061409030411'. The Yahoo/netkeiba id
    '2609030411' encodes yy/jyo/kai/nichi/race but omits MMDD, so supply year+date
    explicitly in the race spec rather than deriving from that id.
    """
    return f"{r['year']:04d}{r['mmdd']}{r['jyo']}{r['kaiji']}{r['nichiji']}{int(r['race_no']):02d}"


def open_jvlink():
    import ctypes
    if ctypes.windll.kernel32.GetACP() != 932:
        sys.exit("FATAL: Windows ANSI codepage != 932 (Japanese); JV-Link would corrupt "
                 "Shift-JIS to U+FFFD. See ingest_jvlink.assert_japanese_acp().")
    jv = win32com.client.Dispatch("JVDTLab.JVLink")
    rc = jv.JVInit(SID)
    if rc != 0:
        raise RuntimeError(f"JVInit rc={rc} (check JV-Link install)")
    return jv


def realtime_pull(jv, dataspec: str, key: str):
    """One JVRTOpen(dataspec, key) -> [(record_id, raw_text, src_file), ...].

    Realtime delivers one file per call (no async JVStatus download loop). rc -1 =
    no data yet for this race/spec; -303 = 利用キー not set; -301/-302 = account
    not active.
    """
    rc = jv.JVRTOpen(dataspec, key)
    if rc == -1:
        return []
    if rc == -303:
        raise RuntimeError("JVRTOpen rc=-303: 利用キー not set in JV-Link "
                           "(JVSetUIProperties / JVSetServiceKey)")
    if rc in (-301, -302):
        raise RuntimeError(f"JVRTOpen rc={rc}: DataLab membership not active / auth failed")
    if rc != 0:
        raise RuntimeError(f"JVRTOpen({dataspec},{key}) rc={rc}")

    records = []
    try:
        while True:
            ret = jv.JVRead("", 600000, "")   # O6 trifecta record is ~83 KB; buffer generously
            r, buff, filename = ret[0], ret[1], ret[-1]
            if r == 0:
                break                          # EOF
            if r == -1:
                continue                       # file boundary
            if r < -1:
                raise RuntimeError(f"JVRead rc={r}")
            records.append((buff[:2], buff, filename))  # buff already str via BSTR/cp932
    finally:
        jv.JVClose()
    return records


def load_state() -> dict:
    if STATE.exists():
        try:
            return json.loads(STATE.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def write_snapshot(race_key: str, records, ingested_at: str) -> int:
    """Write one immutable gz-NDJSON of raw realtime records + 7 bronze metadata
    fields, under raw/jravan_rt/<race_key>/<UTC stamp>.ndjson.gz."""
    stamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%S%fZ")
    out_dir = BRONZE / race_key
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"{stamp}.ndjson.gz"
    n = 0
    with gzip.open(out, "wt", encoding="utf-8") as fh:
        for record_id, raw_text, src_file in records:
            content_hash = hashlib.sha256(raw_text.encode("utf-8")).hexdigest()
            fh.write(json.dumps({
                "source_name": SOURCE_NAME,
                "source_record_id": f"{record_id}:{content_hash[:16]}",
                "raw_uri": src_file,
                "content_hash": content_hash,
                "ingested_at": ingested_at,
                "published_time": stamp,   # refine to the record's 発表月日時分 in silver
                "available_at": stamp,
                "record_id": record_id,
                "spec": REALTIME_SPEC,
                "raw": raw_text,
            }, ensure_ascii=False) + "\n")
            n += 1
    return n


def next_interval(min_to_post: float) -> int:
    for threshold, interval in SCHEDULE:
        if min_to_post >= threshold:
            return interval
    return SCHEDULE[-1][1]


def run(races: list[dict]) -> None:
    """races: [{race_no, year, mmdd, jyo, kaiji, nichiji, post (ISO JST)}, ...]."""
    state = load_state()
    card: dict = {}          # race_no -> dashboard race entry (for the D1 snapshot)
    jv = open_jvlink()
    try:
        while races:
            now = dt.datetime.now().astimezone()
            soonest = None
            for r in list(races):
                post = dt.datetime.fromisoformat(r["post"])
                min_to_post = (post - now).total_seconds() / 60
                if min_to_post < -STOP_AFTER_POST_MIN:
                    races.remove(r)             # done with this race
                    continue
                soonest = min_to_post if soonest is None else min(soonest, min_to_post)

                key = jra_race_key(r)
                records = realtime_pull(jv, REALTIME_SPEC, key)
                if not records:
                    continue
                digest = hashlib.sha256(
                    "".join(t for _, t, _ in records).encode(ENCODING)).hexdigest()
                if state.get(key) == digest:
                    continue                    # unchanged since last poll: skip archive
                state[key] = digest
                n = write_snapshot(key, records, dt.datetime.utcnow().isoformat() + "Z")
                save_state(state)
                print(f"[{now:%H:%M:%S}] R{r['race_no']} {key}: {n} records archived")

                if _PUBLISH:   # derive a per-race entry and push the whole card to D1
                    prev_polls = card.get(r["race_no"], {}).get("capture", {}).get("polls", 0)
                    card[r["race_no"]] = {
                        "race_no": r["race_no"],
                        "name": r.get("name", f"Race {r['race_no']}"),
                        "post_time_jst": r.get("post_time_jst", "—"),
                        "status": "open", "result": None,
                        "capture": {"last_update": dt.datetime.utcnow().isoformat() + "Z",
                                    "polls": prev_polls + 1, "pools": ["win_place"]},
                        "runners": _runners_from_o1(records),
                    }
                    snapshot = {
                        "meta": {"venue": "Hanshin", "status": "live",
                                 "published_at": dt.datetime.now(dt.timezone.utc).isoformat()},
                        "races": [card[k] for k in sorted(card)],
                    }
                    try:
                        push_to_d1(snapshot)
                    except Exception as exc:  # noqa: BLE001 - publish must not kill capture
                        print(f"  publish to D1 failed: {exc!r}")
            if not races:
                break
            sleep_s = next_interval(soonest if soonest is not None else 999)
            print(
                f"[heartbeat] {dt.datetime.now().astimezone().isoformat()} "
                f"races_remaining={len(races)} next_sleep_s={sleep_s}",
                flush=True,
            )
            time.sleep(sleep_s)
    finally:
        jv.JVClose()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--races", required=True,
                    help="JSON file: [{race_no, year, mmdd, jyo, kaiji, nichiji, post}, ...]")
    args = ap.parse_args()
    run(json.loads(Path(args.races).read_text(encoding="utf-8")))
