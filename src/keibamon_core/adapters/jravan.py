"""JRA-VAN source adapter (silver parsing).

Mirrors NetkeibaSourceAdapter: the live PULL is done elsewhere (the Windows-only
JV-Link worker in tools/jravan/, since JV-Link is 32-bit COM). This adapter runs
on any platform and turns the RAW bronze snapshots written by that worker
(data/raw/jravan/<snapshot_id>/<spec>.ndjson.gz) into canonical silver records.

Bronze stores records exactly as received (Shift-JIS decoded text + the seven
required metadata fields). All JV-Data field parsing lives here so it can be
replayed when the spec understanding improves -- this is the right home for the
fixed-byte field maps and for the data-quality trap rules.
"""
from __future__ import annotations

import gzip
import json
from pathlib import Path
from typing import Iterator

# record_type -> [(field_name, start_byte, length, kind)]   FILL FROM JV-Data spec PDF.
# Start with the records you need (RA race, SE runner, HR payout, TM TimeMining,
# DM DataMining, UM horse master) and expand. Offsets are positional in the
# Shift-JIS-decoded fixed-width record.
RECORD_LAYOUTS: dict[str, list[tuple[str, int, int, str]]] = {
    "RA": [("record_id", 0, 2, "str"), ("data_kubun", 2, 1, "str"),
           ("make_date", 3, 8, "date8"), ("year", 11, 4, "str"),
           ("jyo_code", 19, 2, "str"), ("race_num", 25, 2, "str")],
    "SE": [("record_id", 0, 2, "str"), ("year", 11, 4, "str"),
           ("umaban", 26, 2, "str"), ("ketto_num", 28, 10, "str")],
    # "HR", "TM", "DM", "UM", "KS", "CH", "O1".."O6" ...
}

# Known JV-Data traps -> enforce as Pandera checks downstream.
# Seeded from note.com/nao_develop_note: the race-info last-4-furlong time is a
# phantom default "000" (only last-3F is populated). Derive a proxy in features.
DATA_TRAPS = {
    "RA.last_4f_time": "always '000' (default); use 4-corner-rank + finish proxy",
}


class JravanSourceAdapter:
    source_name = "jravan"

    def __init__(self, raw_dir: Path):
        self.raw_dir = raw_dir  # <lake>/raw/jravan

    def iter_raw(self) -> Iterator[dict]:
        """Yield raw bronze rows across all snapshots (replayable input)."""
        for snap in sorted(self.raw_dir.glob("*/")):
            for gz in sorted(snap.glob("*.ndjson.gz")):
                with gzip.open(gz, "rt", encoding="utf-8") as fh:
                    for line in fh:
                        if line.strip():
                            yield json.loads(line)

    @staticmethod
    def parse_record(row: dict) -> dict | None:
        """Parse one raw bronze row into typed fields using RECORD_LAYOUTS."""
        layout = RECORD_LAYOUTS.get(row.get("record_id", ""))
        if not layout:
            return None
        text = row["raw"]
        out: dict = {"available_at": row["available_at"],
                     "content_hash": row["content_hash"]}
        for name, start, length, kind in layout:
            val = text[start:start + length].strip()
            if kind == "date8" and len(val) == 8:
                val = f"{val[0:4]}-{val[4:6]}-{val[6:8]}"
            out[name] = val
        return out
