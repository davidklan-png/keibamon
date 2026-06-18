# CLI agent task: implement weekend stage 3 (live odds curve, Mac/netkeiba)

You are working in the Keibamon repo on the **Mac (`mac-dev`)**. Read `CLAUDE.md`,
`docs/adr/0003-weekend-pipeline.md`, and `docs/adr/0004-mac-only-scrape-sourced.md`;
run `python tools/whichdevice.py` to confirm `mac-dev` before doing device-specific
work. Use `venv64`.

## Context

Stage 3 ("track") captures the live odds time-series, announcement → post, into
the lake and the D1 dashboard. Per **ADR-0004 the system is going Mac-only,
scrape-sourced**: the live source is the **netkeiba feed on the Mac**, NOT JV-Link
(`JVRTOpen`/速報 was never entitled and is being retired). So `track` is `mac-dev`
only — drop `capture-pc` from its guard.

Most of the machinery already exists; this stage is mainly a thin, guarded,
restartable orchestration wrapper over it. Reuse, don't reinvent:

- `tools/jravan/run_dashboard_feed.py` — the working Mac poller: fetch/parse
  netkeiba win/place, track opening odds, flag residual drift, push the card to D1,
  and bank the curve to silver `odds_snapshots` (the PIT time-series).
- `keibamon_core.polling.netkeiba` (`fetch_odds_payload` / `parse_odds_payload`),
  `keibamon_core.ingestion.odds.append_odds_snapshots`,
  `keibamon_core.polling.drift.residual_edges`.
- `keibamon_core.ingestion.curve_log.build_curve_records` — the FREEZE stage that
  later turns `odds_snapshots` into a `curve_log` row per runner (settled in stage 4).

## Live-capture discipline (ADR-0004: backfill safety net is gone)

With JV-Link retired there is **no `0B41/0B42` 1-year backfill** — an intraday
curve not captured live is lost forever. So:

- Run on a **stationary Mac, lid forced open**: the wrapper must refuse to start
  unless it can confirm sleep is inhibited. Shell out to `caffeinate -dis` (or
  verify a running caffeinate) and document disabling lid-close sleep; if it cannot
  be confirmed, **warn loudly** (this is the failure that cost the June 14 curves).
- **Preflight `CF_*`** before the loop (they don't persist across Mac shells —
  CLAUDE.md); a missing cred is a loud startup failure, not a silent per-cycle drop.
- **Polite fetch (ADR-0002 design, now mandatory)**: conditional requests, the
  descriptive UA already in the poller, robots.txt compliance, strict rate limit,
  archive-raw-once-then-parse. **Back off when the source timestamp is unchanged**
  (don't poll faster than netkeiba updates); tighten cadence as post approaches.

## Step 1 — implement `pipeline.track`

Replace the `NotImplementedError` stub. Keep the guard but as **`mac-dev` only**:
`_require_role(("mac-dev",), "track", role_file)`. Signature roughly:

```
def track(lake, race_ids, *, role_file=None, poll_seconds=120,
          inhibit_sleep=True, fetch_fn=None, push_fn=None) -> dict
```

- Preflight: sleep-inhibit confirmation + `CF_*` preflight (reuse the
  best-effort/preflight pattern from `pipeline.post`'s `_push_to_d1_best_effort`;
  factor the shared CF_* check out rather than duplicating it).
- Loop per cycle: for each race, fetch+parse the netkeiba odds, append to silver
  `odds_snapshots` (**lake first**), then push the whole-card snapshot to D1
  (best-effort, never raises over the lake write — ADR-0003 D4). Honor the
  unchanged-timestamp backoff and the adaptive cadence.
- Be **restartable**: a crash/restart resumes appending to the same
  `odds_snapshots` curve (dedupe on `available_at`, already implemented) without
  duplicating rows or losing the opening-odds baseline.
- `fetch_fn`/`push_fn` are injection seams for tests (mirror `post`'s `push_fn`),
  so the loop is testable without network or a real clock — make the loop body a
  pure-ish `track_once(...)` the test can call directly.

If `run_dashboard_feed.py` already does ~all of this, prefer extracting its core
into `track_once` and have both the CLI and `pipeline.track` call it, rather than
forking the logic.

## Step 2 — wire the CLI

`tools/weekend_run.py track --date ... [--venue ...]` calls `pipeline.track`.
Keep the device guard in the pipeline layer (single source of truth), not the CLI.

## Step 3 — tests (`tests/test_track.py`, keep suite green)

Follow the existing seam-injection style:

- `track_once` appends parsed snapshots to `odds_snapshots` before any push (lake
  first); a `push_fn` that raises does NOT lose the lake write.
- Unchanged source timestamp → no duplicate `odds_snapshots` rows (dedupe holds);
  cadence tightens toward post.
- Wrong device (`role_file` set to non-`mac-dev`) → `WrongDeviceError`, and
  `capture-pc` is now rejected too.
- Missing `CF_*` → push skipped with reason, loop still banks the curve.
- A frozen `curve_log` built from the captured `odds_snapshots`
  (`build_curve_records`) has the expected open/decision/close per runner — proves
  stage 3 output feeds stage 4.

Run: `PYTHONPATH=src ./venv64/bin/python -m pytest -q` — all green.

## Step 4 — commit (not pushed; standing instruction)

```
git add src/keibamon_core/weekend/pipeline.py tools/weekend_run.py \
        tools/jravan/run_dashboard_feed.py tests/test_track.py \
        docs/prompts/stage3-track-live-curve.md
git commit -m "weekend stage 3: track (Mac/netkeiba live curve, mac-dev-only, restartable, lake-first)"
```

## Guardrails

- `track` is `mac-dev` only (ADR-0004). Do not re-add the JV-Link/`capture-pc` path.
- Lake first, D1 best-effort; never lose a captured curve to a push failure.
- No betting recommender — a residual-drift flag is a thing to log, never a bet.
- Polite, backed-off fetching; archive raw once. If a real interface differs from
  this spec, prefer the code and note the deviation in the commit.
```
