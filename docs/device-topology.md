# Keibamon device topology & demarcation

> **⚠ Superseded in part by [[ADR-0004]] (2026-06-18): going Mac-only,
> scrape-sourced.** The capture PC is **deprecated** — JV-Link is being retired and
> the Mac becomes the sole device for ingest, lake, dev, live capture, and D1 push.
> The PC stays in the **hybrid** transitional role (weekly official JV-Link pull
> only) **until** the Mac scrape feed covers results + payouts + entries and passes
> a 0.0000%-mismatch cross-validation against the final JV-Link overlap (ADR-0004
> prerequisite). Do **not** power off the PC before then. Sections below describe
> the pre-ADR-0004 topology; read them as the state we are migrating *away from*.

The system spans several machines with **hard role boundaries**. Crossing a
boundary (e.g. running JV-Link on the Mac, or trusting the laptop as the race-day
capture host) is how things break. This is the canonical map. Any human or agent
working on the system must know **which device they are on** before acting — run
`python tools/whichdevice.py` or read the machine-local `.device` file.

## The devices

### 1. Capture PC — Windows, always-on, **stationary** (DEPRECATED — ADR-0004)
> Being retired. Kept only for the weekly official JV-Link bulk pull during the
> hybrid transition; do not build new dependencies on it.
- **Role:** authoritative live odds capture. Runs **JV-Link** (32-bit COM) —
  `JVOpen` for bulk/蓄積 history and `JVRTOpen` for realtime/速報 (0B30 all-pool,
  0B41/0B42 time-series). Entry points: `tools/jravan/ingest_jvlink.py` (bulk →
  bronze) and `tools/jravan/realtime_jvlink.py` (realtime → lake + D1 push).
  **Code-sync** entrypoint: `python tools\thursday_sync.py` — a pull-only mirror
  of the Mac-pushed repo (device guard → `git pull --ff-only` → preflight). The
  PC never authors code or pushes; it only pulls. (Moves **code only** — lake
  bronze still crosses on the USB; see ADR-0004 + the data-flow diagram.)
- **Owns:** bronze ingestion from JV-Link; the official odds time-series; the
  race-day live feed.
- **Tech:** Windows, **32-bit** Python venv (JV-Link COM is 32-bit), pywin32.
- **Must:** stay plugged in, lid-open or headless, run as a managed service
  (Task Scheduler) with logging and a creds preflight. **Never travels.**
- **Must NOT:** be the place we do heavy ML / DuckDB (use the Mac); be assumed to
  have the lake (it is airgapped — data leaves via USB).

### 2. Mac — dev workstation + **backup** capture (not race-day authoritative)
- **Role:** primary **development** machine (code edits, tests, building
  silver/gold, modeling) and home of the **lake** (medallion bronze→silver→gold
  →marts). Also runs the **backup** netkeiba scrape feed
  (`tools/jravan/run_dashboard_feed.py`) — convenience only, **not** the race-day
  source of truth.
- **Owns:** the git repo as source of truth; the data lake; all analysis/ML.
- **Tech:** macOS, **64-bit** Python venv (`venv64`) for DuckDB/sklearn/ML.
- **Must NOT:** run JV-Link (Windows-only); be the **sole** race-day capture host
  — it is a laptop and it travels. `caffeinate -i` does **not** stop lid-close
  sleep; closing the lid kills capture (this cost us the June 14 afternoon
  curves). If ever used to capture: `caffeinate -dis` + disable lid sleep, and
  still don't carry it.

### 3. Cowork sandbox — Linux, ephemeral compute (where the Claude/Cowork agent runs)
- **Role:** mounts the Mac repo folder; runs bash in an isolated Linux VM. Edits
  code, runs python/duckdb/tests, queries D1 via MCP, does web/research.
- **Can:** read/edit repo files; run the test suite and analysis in-sandbox;
  query Cloudflare D1 through the MCP connector.
- **CANNOT:** `git push` (no creds — that is the human's job on the Mac);
  `make jravan-import` from the USB (`/Volumes/...` is not mounted in the
  sandbox); run JV-Link. **git is unreliable here** — `.git/index.lock` unlink
  fails ("Operation not permitted"); defer all commits/pushes to the Mac.

### 4. Cloudflare edge — D1 + Worker + Pages (the dashboard plane, **disposable**)
- **Role:** `keibamon-live` D1 (db id `7b3cf063-…`), single-row
  `live_snapshot['hanshin']`; the Worker `/api/live`; `splash/live.html`.
- **Written by** whichever capture host holds the `CF_*` creds (PC realtime
  worker preferred; Mac feed is backup). **Read by** the phone at the OTB.
- **Pass-through display only** — never a store of record. If it's stale, the
  capture host stopped pushing; the lake is the truth.

### 5. Phone — viewing only (the only device that travels)
- Reads the dashboard. **Captures nothing.** Carrying the phone to the OTB is the
  whole point of separating it from the capture host.

## Data-flow boundaries

```
  Capture PC ──(JV-Link COM, official)──> bronze
       │                                    │
       │  airgap: USB volume KEIBA          │  same machine
       │  (/Volumes/KEIBA/keibamon-xfer)    ▼
       └──────────────────────────────> Mac LAKE (bronze→silver→gold→marts)
                                            │            ▲
   capture host (PC pref / Mac backup)      │ dev+ML     │ git (source of truth)
       │ HTTPS + CF_* creds                 ▼            │
       └────────────> Cloudflare D1 ──/api/live──> Phone (read-only, at OTB)
```

- **Airgap boundary:** the PC is airgapped from the lake; **bronze crosses on the
  USB** (`KEIBA/keibamon-xfer`), imported via `make jravan-import`. Nothing else
  crosses that line.
- **Source of truth:** the **git repo** (code) and the **Mac lake** (data). D1 is
  throwaway; the dashboard can always be rebuilt from the lake.

## The demarcation rules (the don'ts, in one place)

1. **JV-Link only on the PC** (32-bit COM). Never on the Mac/sandbox.
2. **ML / DuckDB / heavy compute on the Mac** (`venv64`). Not on the capture PC.
3. **Dashboard push only from a capture host with `CF_*` creds.** Creds live in a
   sourced env/secret on that host, never committed, preflight-checked at startup.
4. **The capture host never travels and never sleeps.** The phone travels.
5. **git push / USB import are human actions on the Mac.** The sandbox agent
   prepares the diff and the commands; it does not push or import.
6. **Bronze crosses the airgap only via the USB.** PC ⇄ Mac, nothing else.

## Cross-platform test gotcha: per-platform native binaries

The root worker test suite (`npm test` at repo root — `src/form/*`, `src/reference/*`)
and the production frontend build (`vite build`) depend on **per-platform native
binaries** that are installed for the host that ran `npm install`:

- **`better-sqlite3`** — ships a prebuilt node binding compiled for the
  install-time OS/arch (the `makeFakeD1` shim drives it). The Mac install is a
  darwin/arm64 binary; it will **not load on the Linux sandbox** (`GLIBC ... not
  found` / `Module did not self-register`).
- **`esbuild`** + **`rollup`** (vite) — same shape: platform-specific binaries
  fetched at install time.

**Consequence:** the cowork **sandbox cannot run the root worker vitest suite or
the production vite build** — the macOS-compiled natives don't load on Linux.
Run those two on the Mac:

```
npm test                       # root worker suite (better-sqlite3) — Mac only
cd frontend && npm run build   # vite production build (esbuild/rollup) — Mac only
```

The **frontend logic tests** (`cd frontend && npm test` — vitest + jsdom, no
better-sqlite3) **are reproducible on the sandbox** once Linux natives are
installed without saving them to package.json:

```
cd frontend && npm i -D esbuild --no-save && npm test
```

Rule of thumb: the sandbox can validate frontend logic + Python/lake code; the
root worker suite and the production bundle are Mac (or matching-arch CI) only.
Always confirm `npm test` (root) on the Mac before sign-off — a green sandbox
run does NOT cover the worker routes.
