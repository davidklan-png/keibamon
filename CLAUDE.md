# Keibamon — agent guide

Keibamon is a JRA horse-racing research + betting-research platform: a medallion
data lake (bronze→silver→gold→marts) with strict point-in-time correctness, fed
by JV-Link (official) and a netkeiba scrape (backup), surfaced to a phone
dashboard via Cloudflare D1.

## FIRST: know which device you are on

This system spans multiple machines with **hard role boundaries**. Before any
device-specific action, determine your device:

```
python tools/whichdevice.py
```

It reads the machine-local `.device` file (gitignored; `cp .device.example
.device` and set `role`) and prints what this host **can** and **must not** do.
The full map is `docs/device-topology.md`. Roles:

- **capture-pc** — Windows, always-on, stationary. JV-Link ingest (32-bit COM),
  realtime feed, D1 push. The capture host of record. Never travels.
- **mac-dev** — macOS dev box + the lake + git source of truth + backup netkeiba
  feed. 64-bit `venv64` for ML/DuckDB. No JV-Link. Not the race-day capture host.
- **cowork-sandbox** — the Linux VM the Cowork/Claude agent runs in, mounting the
  Mac repo. Edits/tests/analysis only. **Cannot git push/commit or import the
  USB** — prepare the diff and commands; the human runs them on the Mac.

If `whichdevice` shows ⚠ (no `.device`), create it before doing device-specific
work — don't guess.

## Cross-device gotchas (these have bitten us)

- **JV-Link is Windows-only, 32-bit.** It does not run on the Mac or the sandbox.
- **The capture host must not sleep.** `caffeinate -i` does NOT prevent lid-close
  sleep — a closed MacBook lid killed a race-day afternoon's capture. Capture
  belongs on the stationary PC.
- **`CF_*` creds don't persist across shells on the Mac** (`setx` is Windows).
  Source them from a file/profile; `push_to_d1` does `os.environ["CF_*"]` and
  fails silently per-cycle if they're missing. Preflight at startup.
- **Two Python envs:** `venv64` (Mac, ML/DuckDB) vs a 32-bit env on the PC
  (JV-Link COM). Don't cross them.
- **git in the sandbox is unreliable** (`.git/index.lock` unlink "Operation not
  permitted"). Commit/push on the Mac.
- **The lake is repo-`./data`.** `KEIBAMON_LAKE` overrides it per-shell — do NOT
  set it on the Mac. Stale docs and memory pointing at `~/keibamon-data` caused
  a bronze/silver split (2026-07-02 merge fixed it; `~/keibamon-data` is now a
  symlink to `./data`). Every ingestion tool defaults to `./data` and the silver
  builder reads `LakePaths()` with no env override — keep it that way.
- **Capture-PC must run Japanese ANSI codepage (ACP=932).** JV-Link converts
  Shift-JIS BSTRs via the Windows ANSI codepage; if ACP != 932 (e.g. English
  Windows defaults to 1252), every Japanese byte silently round-trips through
  cp1252 and arrives in bronze as `U+0192` + C1 orphan mojibake. The
  `assert_japanese_acp()` guard in `tools/jravan/ingest_jvlink.py` +
  `realtime_jvlink.py` refuses the run; the `write_snapshot` canary is the
  defense-in-depth backstop. Both only exist on `main` -- a capture-PC on a
  divergent branch will bypass them, so verify branch before any capture.

## Working rules

- Point-in-time correctness is non-negotiable: a decision at time `t` uses only
  data with `available_at <= t`. Honor `adapters/jravan.DATA_TRAPS` (esp.
  `horse_id='0000000000'` is non-unique — join on `(race_id, horse_number)`).
- Read lake tables columnar via `src/keibamon_core/lake_query.py` (DuckDB) — no
  `list[dict]` scans over whole tables.
- Every new signal is judged against the **market baseline** net of takeout
  (`ingestion/market_baseline.py` + `backtest/roi.py`). Mining and going-handling
  both failed that bar; the **odds curve** is the one live hypothesis.
- Keep the test suite green (`PYTHONPATH=src python -m pytest -q`). New data
  gotchas go in `DATA_TRAPS`.
