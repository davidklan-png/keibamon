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

## 8. Known data gaps (historical)

Specific dates where a capture path failed or wasn't run. Lake queries against
these dates will see whatever the sekisan snapshot carried (often final results
without the intraday odds curve) and **must not** be treated as a regression or
a parser bug. Add new entries here as they occur.

### 2026-06-28 — realtime capture missing (Saturday card)
- **What's missing:** `rt-20260628` under `data/raw/jravan_rt/`. No intraday
  O1–O6 odds curves for any 06-28 race.
- **What IS present:** 06-28 `HR`/`RA` records (final results, payouts) were
  carried by the next sekisan snapshot (`20260630T214859`, RACE watermark
  `20260629133745`, MING `20260629133744`). Final odds exist as a single
  snapshot, not a curve.
- **Cause:** the PC realtime capture (`realtime_jvlink.py`) did not run for
  06-28 (operator gap, not a code regression — 06-26, 06-27, and 06-30+
  captured normally).
- **Effect on analytics:** `jravan_odds_timeseries` will show 06-27 and 06-29+
  curves but a one-day hole on 06-28. Curve features for 06-28 races fall back
  to the sekasan single-snapshot odds. Don't treat 06-28 as low-confidence
  unless the sekasan snapshot itself is suspect.
- **Logged:** 2026-07-02, when the `20260630T214859` sekisan + `realtime/20260627`
  USB drop landed on the Mac (commit history around that date carries the
  bronze-merge).

## 9. cp1252 mojibake — recovery path for bad-ACP captures

**Root cause.** JV-Link hands its records to Python as BSTRs. Windows converts
the underlying Shift-JIS bytes to UTF-16 *through the system ANSI codepage*
(ACP). If the capture PC's ACP is **not 932** (e.g. `en-US` → ACP 1252), every
Japanese byte is destroyed in transit: cp1252 high chars (`U+0152 Œ`,
`U+0192 ƒ`, `U+2014 —`, …) replace the cp932 lead bytes, and the five
undefined cp1252 slots in `0x80–0x9F` arrive as C1 orphan controls
(`U+0081 / U+008D / U+008F / U+0090 / U+009D`). The bronze records land as
UTF-8 of those codepoints, not as the original Japanese.

**Detection.** `tools/jravan/ingest_jvlink.py` and `tools/jravan/realtime_jvlink.py`
each call `assert_japanese_acp()` at JV-Link open time (refuses to ingest on a
non-932 ACP). A second line of defense is the **mojibake canary** —
`_check_mojibake()` in `write_snapshot()`, which rejects any record whose
`raw` contains one of the canary chars above before it lands on disk. The
canary is also encoded in `adapters/jravan.DATA_TRAPS` so silver parsing can
guard against it.

**Recoverability test.** Because the five C1 orphans are themselves bytes
(0x81, 0x8D, …), every Japanese line that was destroyed carries at least one
C1 orphan. We proved the **`c1 == hits` invariant** on the 2026-07-02
incident: 100% of mojibake'd lines carry ≥1 C1 orphan, so the cp932
lead-byte structure survived the round-trip and recovery is **mechanical and
lossless**. (`c1 ≈ hits` ⇒ lossless; `c1 == 0` ⇒ bytes were destroyed and the
record is unrecoverable.)

**Recovery script.** `tools/jravan/recover_cp1252_snapshot.py`:

- inverts the cp1252 high chars via `adapters/jravan.recover_raw_bytes`
  (mirror, never duplicate, the cp1252 reverse map), treats each C1 orphan as
  its codepoint byte, then decodes the concatenation as **cp932 strict**;
- writes a **NEW derived snapshot dir** under `data/raw/jravan/` with the
  `R` suffix convention (e.g. `20260630T214859R`);
- adds a `provenance` block to the new `_snapshot.json` naming the source
  snapshot, the method, the script path, and the rationale;
- **never touches the source**. The quarantined original stays in
  `data/_quarantine/<name>.bad-encoding/` for forensic reference.

**Hard gates** (any failure rolls back the dest dir entirely):

1. Records without canary chars pass through byte-identical to the source.
   ASCII-only fields (HR payouts, O1–O6 odds, all-numeric fields) are
   invariant under cp1252 vs cp932, so they survive unchanged.
2. Zero canary chars anywhere in the recovered output.
3. Every record with canary chars must recover via `recover_raw_bytes` +
   cp932 strict decode (raises `ValueError` on unmapped codepoints,
   `UnicodeDecodeError` on invalid sequences).

**When to recover vs re-capture.** Recovery is lossless but DERIVED data.
Prefer re-capture from a Japanese-ACP PC when JG/SE/RA/HR/O1–O6 are
re-pullable historical data (they are, via `JVOpen` from the appropriate
`fromtime`) and the next PC visit isn't far off. Use recovery when
rt-* realtime odds are involved (unrepeatable) **or** the weekend's data is
needed before the next PC visit.

**When a clean PC re-capture lands.** Quarantine the R-derived snapshots in
its favor — **never delete bronze**:

```
mv data/raw/jravan/<snap>R data/_quarantine/<snap>R.superseded
```

**Usage.**

```
PYTHONPATH=src python tools/jravan/recover_cp1252_snapshot.py \
    --source data/_quarantine/20260630T214859.bad-encoding \
    --dest   data/raw/jravan/20260630T214859R
```

**PC-side fix (the actual remediation).** Recovery is a stop-gap. The real
fix is on the PC: `GetACP()` will report `1252` until the system locale is
set to Japanese (Control Panel → Region → Administrative → "Copy settings"
→ tick "Welcome screen and new user accounts"; reboot). After the reboot,
`GetACP()` returns `932` and `assert_japanese_acp()` lets ingestion through.
