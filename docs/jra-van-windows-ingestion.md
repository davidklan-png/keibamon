# JRA-VAN Windows-first ingestion & USB-C delta transfer

Pull as much JRA-VAN data as possible onto the Windows PC, then move it to the Mac
lake over a 500 GB USB-C SSD — full history once, deltas thereafter. See
`docs/adr/0001-jra-van-additive-bronze.md` for the decision.

```
Windows PC (only ingestion point — JV-Link is 32-bit COM)
  JRA-VAN Data Lab → JV-Link → tools/jravan/ingest_jvlink.py
      → data/raw/jravan/<snapshot_id>/<spec>.ndjson.gz   (RAW records, immutable)
      → tools/jravan/export_delta.py → E:\ USB-C airlock (incoming/<snapshot_id>/)
                    │  carry / dock
Mac (analytics — no COM)
  tools/jravan/import_delta.py ← /Volumes/KEIBA (verify sha256, idempotent merge)
      → data/raw/jravan/  →  src/keibamon_core/adapters/jravan.py (silver parse)
      →  normalized → features → marts → DuckDB/MLflow
  + existing Netkeiba odds bronze (unchanged); joined in silver
```

Principles: **bronze = raw records as received** (replayable parsers), the **SSD is
a transfer airlock not the DB**, every transfer is **sha256-checksummed and
idempotent**, point-in-time integrity via `available_at` / `published_time`.

## 0. One-time PC prerequisites
1. JRA-VAN **Data Lab** subscription + **software ID** (set `JRAVAN_SID`).
2. Install **JV-Link** (registers COM `JVDTLab.JVLink`); enter the **service key**
   once via its config dialog (`JVSetUIProperties`) or `JVSetServiceKey`.
3. **32-bit Python** — JV-Link is 32-bit COM; 64-bit `Dispatch` fails:
   ```bat
   py -3.11-32 -m venv C:\keibamon\venv32
   C:\keibamon\venv32\Scripts\pip install pywin32
   set KEIBAMON_LAKE=D:\keibamon\data
   ```
4. Get the **JV-Data spec PDF** — defines dataspec codes, record IDs, and
   fixed-byte field layouts (the source of truth for silver parsing and where the
   fine-print traps live).

## 1. Full setup pull (once)
`JVInit → JVOpen(dataspec, "00000000000000", option=4) → loop(JVRead/JVSkip) → JVClose`.
`option=4` = setup (full history). Pull heavy specs (`RACE`, `BLOD`, `MING`,
`SNAP`, `SLOP`, `WOOD`) and masters (`UM`/`KS`/`CH`); **confirm spec strings
against your PDF**. Tens of GB of records → ~10–30 GB gzip-NDJSON.
```bat
C:\keibamon\venv32\Scripts\python tools\jravan\ingest_jvlink.py setup
```
Records are **Shift-JIS (`cp932`)** and stored decoded-to-UTF-8 text, unparsed.

## 2. Delta pulls (scheduled)
`JVOpen` returns `lastfiletimestamp`; persist it per dataspec in
`data/raw/jravan/_state.json`. Next run uses it as `fromtime` with `option=1`
(diff). Use `JVRTOpen` for race-day live odds/results on a tighter cadence.
`JVSkip()` files you already hold (Nao's speed trick).
```bat
C:\keibamon\venv32\Scripts\python tools\jravan\ingest_jvlink.py pull
```

## 3. Bronze layout (`data/raw/jravan/`, gitignored)
Immutable per-run snapshot dirs; each raw row carries the seven required metadata
fields (`source_name, source_record_id, raw_uri, content_hash, ingested_at,
published_time, available_at`) plus `record_id`, `spec`, `raw`:
```
data/raw/jravan/20260611T193000/
    RACE.ndjson.gz   MING.ndjson.gz   _snapshot.json   # _snapshot.json lists sha256/rows per file
```

## 4. USB-C airlock (PC → SSD → Mac)
SSD is a one-way drop zone (`E:` Win / `/Volumes/KEIBA` Mac); keep full copies on
both machines.
- **Export (PC):** `python tools\jravan\export_delta.py --to E:\keibamon-xfer`
  copies snapshots not yet shipped to `incoming/<snapshot_id>/` (tracked in
  `_exported.log`). For huge first sync use `robocopy … /E /J`.
- **Import (Mac):** `python tools/jravan/import_delta.py --from /Volumes/KEIBA/keibamon-xfer`
  verifies each file's sha256 against `_snapshot.json`, copies new snapshots into
  `data/raw/jravan/`, advances watermarks, archives consumed snapshots. Re-running
  is a no-op (idempotent). First sync carries the whole bronze once (fits 500 GB).

## 5. Seamless automation
- **Windows Task Scheduler** `keibamon-ingest-daily` 19:30 JST: `ingest pull` then
  `export_delta`. Optional realtime task on race days (`JVRTOpen`).
- **Mac launchd** agent watching `/Volumes/KEIBA/keibamon-xfer/incoming`
  (`WatchPaths`) runs `make jravan-import` on dock — or run it manually.
- Loop becomes: PC ingests+exports on a timer → dock the SSD → Mac auto-imports.

## 6. Gotchas (bake in)
- **32-bit COM** for the ingester only; Mac stays 64-bit.
- **Shift-JIS (`cp932`)** decode — wrong codec garbles Japanese.
- **Phantom fields:** race-info last-4F is always `000` (default; only last-3F
  populated). Encode as a **Pandera** rule; derive a 4-corner-rank/finish proxy
  (`src/keibamon_core/adapters/jravan.py` → `DATA_TRAPS`).
- **Immutable bronze:** never overwrite; corrections arrive as later diff records
  resolved in silver by `available_at`/`make_date`.
- **Idempotency over timestamps:** rely on sha256 + `_snapshot.json`.
- **Redistribution terms:** keep raw JV-Data local; publish only curated marts to
  keibamon.com (see ADR).

## 7. First-run checklist
1. PC prereqs (§0). 2. `ingest setup` → full bronze. 3. `export_delta` ships it.
4. Dock SSD on Mac → `make jravan-import`. 5. Implement silver parsing in the
jravan adapter + Pandera traps. 6. Add `_z` normalization + acceptance metrics.
7. Schedule daily pull→export (PC) and on-dock import (Mac). 8. Keep Netkeiba
running; join in silver.
