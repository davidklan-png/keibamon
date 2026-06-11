# tools/jravan — JRA-VAN Windows ingestion

JV-Link is Windows-only 32-bit COM, so JRA-VAN data is pulled on the **PC** and
moved to the Mac lake over a USB-C SSD. The Mac never touches COM.

| Script | Runs on | Job |
|--------|---------|-----|
| `ingest_jvlink.py` | Windows (32-bit Python) | JV-Link → raw bronze snapshot under `data/raw/jravan/<id>/` |
| `export_delta.py`  | Windows | ship new snapshots to the USB-C airlock |
| `import_delta.py`  | Mac | verify (sha256) + merge snapshots into the Mac lake |

Silver parsing of the raw records lives in
`src/keibamon_core/adapters/jravan.py` (Mac-safe).

Full setup, delta watermarks, automation, and gotchas:
**`docs/jra-van-windows-ingestion.md`**. Decision rationale: **`docs/adr/0001-jra-van-additive-bronze.md`**.

Quick start:
```bash
# Windows PC (once)
py -3.11-32 -m venv C:\keibamon\venv32
C:\keibamon\venv32\Scripts\pip install pywin32
set KEIBAMON_LAKE=D:\keibamon\data
C:\keibamon\venv32\Scripts\python tools\jravan\ingest_jvlink.py setup
python tools\jravan\export_delta.py --to E:\keibamon-xfer

# Mac (dock the SSD)
make jravan-import      # or: python tools/jravan/import_delta.py --from /Volumes/KEIBA/keibamon-xfer
```
