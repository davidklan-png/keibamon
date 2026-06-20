# ADR-0006: Expose races on the app the moment they're registered

- **Status:** Accepted
- **Date:** 2026-06-20
- **Deciders:** David Klan
- **Builds on:** the scrape-sourced ingestion + day-index discovery in
  [[ADR-0004]]; the live `/api/live` D1 projection from [[ADR-0003]].

## Context

A race only reached the app through one channel: the Mac built a whole-card JSON
snapshot and pushed it to a single D1 row (`live_snapshot`, hardcoded
`key='hanshin'`); the Worker's `/api/live` returned that row; the app rendered
`races` from it. The Worker and app can read **only** D1 — they have no path to
the lake — so exposing a race always requires a Mac-side publish.

Three gaps sat between "registered" and "exposed":

1. **The publish was odds-triggered, not registration-triggered.** Only the
   race-day odds poller (`weekend_run.py track`) ever wrote the snapshot. A race
   that was registered (entries/出馬表 published days earlier) but had no live
   odds was never published.
2. **The app actively hid odds-less races.** `RaceScreen` filtered to races where
   some runner had `win_odds > 0`; `applyRace` and `loadLive` did the same.
3. **The pipeline was hardcoded to one card** (`key='hanshin'`, a single
   `NK_PREFIX`, a fixed runner-name map) — the single D1 row couldn't hold "all
   registered races" across venues/dates.

The registration signal already existed: ADR-0004's day-index discovery
(`discover_card` → `race_list_sub.html?kaisai_date=…`) lists exactly the races
registered for a day. So the missing piece was a publish path, not a new source.

David's requirement: races appear **as soon as registered**, grayed out until
odds post, **showing estimated odds**, refreshed near-real-time.

## Decision

1. **Add a registration-exposure feed, decoupled from odds polling.** A new
   tool (`tools/jravan/expose_live.py`) discovers the day's registered races,
   scrapes entries + live odds, assembles the snapshot, and upserts it to D1 —
   independent of the race-day odds poller. It runs as **scheduled one-shot
   cycles** (`--once`), not a daemon: fetch, publish, exit (see Scheduling).
2. **Status-driven lifecycle.** Each race carries a `status`: `registered`
   (entries, no live odds → grayed, estimated odds) → `open` (live price) →
   `result`. The pure assembler `keibamon_core.live.snapshot.build_live_snapshot`
   derives status from the runner odds and is unit-tested offline.
3. **Estimated odds are captured opportunistically, never fabricated.** The
   shutuba `<span id="odds-…">` cell is netkeiba's JS-populated odds slot; before
   the pool opens it is the placeholder `---.-`. The entries parser captures the
   number when netkeiba has rendered one and returns `None` for the placeholder.
   The app shows `win_odds_est` only while there is no live price and labels it
   "est."; the moment a live price exists the estimate is dropped so a guess is
   never shown as a real price.
4. **One current document, multi-venue.** The feed publishes under `key='current'`
   (all registered races across venues for the active day, sorted by venue then
   race_no). The Worker reads `current` first, falling back to the legacy
   `hanshin` key so an old publisher still works. No D1 schema change — it's
   another row in the existing `(key, payload, published_at)` table.
5. **App un-gates registration.** The `win_odds > 0` filter is gone; the picker
   lists every registered race (marked "odds pending"), a banner explains the
   grayed state, and a 45s background poll surfaces new races / odds-going-live
   without disrupting the user's current selection or manual entry.

## Consequences

**Positive.** The funnel now starts at registration, days before post time. A
casual user can browse and build tickets on estimated odds the moment a card is
published; the same card upgrades to live in place. Multi-venue days work. The
assembler is pure and tested, so the contract is pinned independent of scraping.

**Costs (accepted, eyes open).**
- **Estimated-odds coverage depends on netkeiba.** When netkeiba hasn't rendered
  a forecast number, runners are grayed with no estimate (we never invent one).
  How early/complete the estimate is, is outside our control — see the open item.
- **More scraping.** A near-real-time loop adds fetch volume against the
  politeness budget; the rate floor in `netkeiba_http` still governs, and
  `--interval` is a floor, not a target. Loud-on-failure monitoring (ADR-0004)
  applies.
- **Estimated odds are not a betting input.** This is a display projection only.
  It never feeds backtests or the market-baseline test; the lake stays the record
  of truth and point-in-time correctness is untouched (we only show public data).

## Scheduling — match the cadence to when JRA actually publishes

The feed is **not** a long-running daemon; it fires one cycle and exits, on a
schedule that matches when JRA publishes/updates data (all times JST):

- **Numbered entries (出馬表 with 馬番/枠番) + estimated odds.** Available
  **Friday** for the bulk of the weekend card (a few special G1s get numbered
  entries Thursday ~14:00). So a Friday sweep (every 30 min, 10:00–22:00) plus a
  Thursday-afternoon pass exposes registered races with estimates as soon as they
  exist.
- **Race-day odds.** JRA's **own** current-race odds update interval is ~**120s**
  on a normal multi-venue day (10s only when a single race is left on sale). So
  "near-real-time" = a **2-minute** loop on Sat/Sun during racing hours
  (09:00–17:00). Polling faster than the source updates buys nothing but load —
  this is the load-bearing constraint that makes a daemon unnecessary.

Delivered as **launchd agents** (`deploy/launchd/com.keibamon.expose-{race,
register}.plist`) — the reboot-surviving, macOS-native choice. Each agent fires a
short-lived `expose_live_once.sh` on a coarse `StartInterval` (race 120s,
register 1800s); the tool's **JST window guard** (`--window race|register`, a
pure tested function) makes every off-window fire a millisecond no-op, so we
avoid both a 24/7 polling loop in our own process and timezone games in the
scheduler. Creds come from `~/.keibamon/cf.env`; `--skip-empty` ensures an
empty discovery never clobbers a good snapshot. (`tools/jravan/crontab.example`
is kept as a cron equivalent for non-macOS hosts.)

## Open item — estimated-odds source calibration (Mac)

The placeholder behavior was confirmed against the one captured shutuba page
(`shutuba_202605030611.html` → all `---.-`). Whether netkeiba serves a usable
forecast number pre-open, and at what time, needs one live pre-open capture on the
Mac to calibrate `_extract_est_odds`. If netkeiba never serves a static estimate,
a follow-up decision is needed on whether to derive one (and the project's
market-efficiency stance argues against a model-derived "estimate"). Until then
the feed degrades honestly: grayed, no number.

## Status — implementation progress

Sandbox does edits + tests; the feed runs on the Mac and commits land on the Mac
(git + `../splash/app` unlink are sandbox limits per CLAUDE.md).

- [x] `live/snapshot.py` pure assembler (status + estimated-odds contract).
- [x] `netkeiba_entries` additively captures `est_odds` (silver shape untouched).
- [x] `tools/jravan/expose_live.py` near-real-time publish loop (key='current').
- [x] Worker `/api/live` reads `current` with `hanshin` fallback + `?key=`.
- [x] App un-gates registration; grayed pending state + est-odds label; 45s
      background refresh.
- [x] 9 new Python tests pass; 23 frontend tests pass; `tsc` clean; bundle
      builds; `node --check worker.js` clean.
- [x] One-shot scheduling wired as launchd agents (`deploy/launchd/*.plist` +
      `expose_live_once.sh`) with a tested JST `--window` guard: Friday entries
      sweep + Sat/Sun 2-min race-day odds, matched to JRA's publish/update
      cadence. 10 Python tests (incl. the window guard) pass; plists lint clean.
- [ ] Estimated-odds source calibrated against a live pre-open capture (Mac).
- [ ] launchd agents loaded on the Mac with `~/.keibamon/cf.env` set; confirm a
      registered race appears on the app Friday, before odds open.
