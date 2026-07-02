# Mac Resume — keibamon bronze handoff (2026-06-13)

Bronze ingestion is complete on the PC. This doc covers everything needed to
pick up on the Mac.

---

## 1. Import bronze from the SSD

Dock the USB-C SSD (E: on the PC → mounts as a volume on Mac), then:

```bash
cd ~/keibamon        # or wherever you cloned the repo on the Mac
make jravan-import
```

This syncs from the SSD airlock into the Mac-side lake. If `make jravan-import`
isn't defined yet, the manual equivalent is:

```bash
rsync -av --checksum /Volumes/<SSD_NAME>/keibamon-xfer/incoming/ \
      ./data/raw/jravan/   (canonical lake = repo ./data; do not set KEIBAMON_LAKE on Mac)
```

What landed on the SSD — snapshot `20260613T083235`, 12 chunk files:

| Spec | Files | ~Records | Notes |
|------|------:|--------:|-------|
| RACE | 858   | 781 k   | 30 yr race cards, results, times |
| BLOD | 417   | 531 k   | Blood/pedigree |
| MING | 372   | 103 k   | Race-day info, entries |
| SNAP | 489   | ~700 k  | Snap data (odds snapshots) |
| SLOP | —     | —       | Slope/track bias data |
| WOOD | 81    | 743 k   | Wood/training data |

---

## 2. Mac Python environment

The Mac doesn't need 32-bit Python or JV-Link. Use a standard 64-bit venv:

```bash
cd ~/keibamon
python3 -m venv venv64
source venv64/bin/activate
pip install pyarrow pandas requests
pip install -e "src/[dev]"   # or: pip install -e src/ if no extras
```

Test the lake is readable:

```bash
python - <<'EOF'
import pyarrow.parquet as pq, pathlib
lake = pathlib.Path(os.environ.get("KEIBAMON_LAKE", "data")).expanduser()
for f in sorted(lake.glob("raw/jravan/**/*.ndjson.gz"))[:3]:
    print(f)
EOF
```

---

## 3. Next build phase — silver parser

File: `src/keibamon_core/adapters/jravan.py`

The bronze layer stores raw Shift-JIS records (already decoded to UTF-8 str)
in NDJSON.gz with the 7 required metadata fields plus `record_id` (first 2
bytes of the JV record) and `raw` (the full record string).

Priority order for the silver parser:

1. **RACE records** (`record_id = "RA"` etc.) — structured race result rows.
   Parse fixed-byte positions per the JV-Data spec PDF
   (`D:\JRA-VAN\reference` on the PC, copy to Mac).

2. **MING records** — entry lists; join to RACE on race_id for pre-race fields.

3. **BLOD records** — pedigree; lower priority (enrichment, not core model).

4. **SNAP records** — odds snapshots; use for market-implied probability
   features. Note: SNAP in DELTA_SPECS may return rc=-1 (no diff data) —
   confirm against the spec PDF before including it in scheduled pulls.

Known gotcha baked into lake.py already:
> `last-4F` field is always `"000"` — phantom/reserved field, do not parse
> as a real time. A Pandera check exists to guard this.

---

## 4. Takarazuka Kinen odds capture (PC only — June 14)

This runs on the PC, not the Mac. Nothing to do here except import the parquet
after the race via the SSD airlock. The PC will run:

```powershell
C:\keibamon\venv64\Scripts\python -m keibamon_core.polling `
  --race-id r-2026-0614-hanshin-11 `
  --netkeiba-race-id 202609030411 `
  --post-time 2026-06-14T15:40:00+09:00
```

Leave it running until ~15:50 JST. Laptop must stay awake (plugged in,
sleep disabled).

---

## 5. Scheduled daily pull (deferred)

Once the manual loop (PC pull → SSD export → Mac import) is validated, add
a Task Scheduler job on the PC:

- **Trigger**: daily 19:30 JST
- **Action 1**: `C:\keibamon\venv32\Scripts\python tools\jravan\ingest_jvlink.py pull`
- **Action 2**: `C:\keibamon\venv32\Scripts\python tools\jravan\export_delta.py --to E:\keibamon-xfer`

Hold off until Phase 5 of the runbook is confirmed clean.

---

## 6. Open decisions / housekeeping

- **SNAP in DELTA_SPECS** — JVOpen returned rc=-1 in earlier diff-mode tests;
  check the JV-Data spec PDF to confirm whether SNAP supports diff pulls. If
  not, remove from `DELTA_SPECS` in `ingest_jvlink.py`.

- **GitHub PAT rotation** — the PAT pasted in the previous session is exposed.
  Go to github.com → Settings → Developer settings → Personal access tokens →
  revoke `github_pat_11BY5V3WQ...` and issue a new one scoped to
  `repo:contents:write` on `keibamon` only.

- **Merge pending PRs** (all fixes validated against live JV-Link 4.9.0):
  - `fix/jvlink-com-marshalling`
  - `fix/stream-bronze-writes`
  - `fix/chunked-resumable-setup`

- **ADR-0001 reminder** — raw JV-Data stays local; only curated marts go to
  keibamon.com. Silver parquet is fine locally; check before any cloud sync.
