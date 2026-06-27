# CLI agent prompt — Thursday roster capture + two race-screen fixes

> Run on the **Mac** (mac-dev: owns the scrape + the D1 push). TIME-SENSITIVE:
> it's Thursday and the weekend G3 rosters (horses + jockeys, no odds yet) are
> already public on Sports Navi (Yahoo). Get that roster captured + published now
> so the app shows runners Thursday, not Friday — and fix the two race-screen
> issues David flagged. Branch: feat/thursday-roster. Commit on the Mac; the
> Cowork verifier checks D1 + re-drives the live app. Honor CLAUDE.md
> polite-fetch / rate-floor rules; do NOT touch the odds-polling intervals or the
> odds time-series capture — this is ENTRIES (roster) only, separate from odds.

```
You are making registered races show their roster (horses + jockeys) on
Thursday, the moment entries are public, instead of waiting for Friday's window;
plus two race-screen fixes. Read CLAUDE.md (device roles, polite-fetch, PIT),
tools/jravan/expose_live.py (the register/odds windows + entry scrape),
src/keibamon_core/adapters/netkeiba_entries.py + netkeiba_discovery.py,
src/keibamon_core/live/snapshot.py (build_runner / merge_entries_and_odds), and
frontend/src/screens/RaceScreen.tsx. Run python tools/whichdevice.py — MUST be
mac-dev.

## P0 — Thursday roster capture (the substantive item; do first, it's urgent)
Today /api/live has 0 runners for all 72 races because expose_live's `register`
window is Thu 14:00–17:59 (special-G1 only) OR Fri 10:00–21:59 (weekend). The
weekend G3 rosters are ALREADY public Thursday (confirmed on Sports Navi). Fix:

STEP A — Diagnose the source (don't assume). For the two weekend G3s
(函館記念 Hakodate R11, ラジオNIKKEI賞 Fukushima R11), run the existing entry
scrape TODAY and report runner counts:
   PYTHONPATH=src ./venv64/bin/python -c "from tools.jravan... (use _entries_for
   / parse_entries_payload against the G3 netkeiba ids)"
 - If netkeiba's shutuba already returns the roster Thursday → the only bug is
   the WINDOW gating. Make the entry scrape OPPORTUNISTIC: scrape + emit runners
   whenever entries are present, regardless of clock window (status stays
   'registered'; win_odds=null; win_odds_est if the page carries it, else null;
   odds_is_live=false). Keep the polite rate floor.
 - If netkeiba is EMPTY Thursday but Sports Navi (Yahoo) has it → add a sportsnavi
   entries adapter (src/keibamon_core/adapters/sportsnavi_entries.py) mirroring
   netkeiba_entries' output shape (umaban, horse_name, horse_id if available,
   jockey_id/jockey_name, est_odds=None). Use it as the Thursday roster source
   with the same NATURAL_KEY/dedup discipline. Respect robots + a polite fetch
   floor; single GET per race, no hammering.
STEP B — Emit jockey NAME per runner (closes the form-panel jockey gap for live
races): carry jockey_name through build_runner into the snapshot runner so the
form deep-dive can resolve the jockey, not just the horse.
STEP C — Publish a snapshot NOW as the stopgap + proof:
   PYTHONPATH=src ./venv64/bin/python tools/jravan/expose_live.py --once \
     --window register   (or the flag that forces the entry scrape)
   Confirm /api/live now carries runners for both G3s with horse + jockey names
   and null/grayed odds, status 'registered'. (Source CF_* first.)
PIT: the roster row's available_at must be the real publish time of the entry
list, not the scrape time — keep provenance honest.

## P1 — Race-screen fixes (frontend, quick — David approved these)
1. Entry-date label is wrong. The "Entries Thu / 出走馬 木曜" chip is hardcoded;
   for a weekend card entries are FRIDAY (and the roster may already be up
   Thursday). Derive the real expected/known entry date per race from the data
   (race date / the publish window), or drop the day-name and show a neutral
   "Entries pending" until runners exist, then nothing once they do. No
   hardcoded weekday.
2. Registered races are a DEAD TILE (disabled). Make a registered/0-runner race
   OPENABLE: tapping it shows the race detail (name, venue, distance, post time)
   and a clear "roster/odds pending" state, instead of being non-interactive.
   Keep "not yet playable" (can't build tickets until runners exist), but the
   user must be able to OPEN it and look. Once runners are present (P0), it
   behaves as a normal selectable race with grayed est/odds and full
   click-through to runners → form context → tickets.

## Tests + constraints
- Add a test that a registered race with a roster but no odds renders runners
  (grayed, odds_is_live=false) and is openable; and that the entry-date label is
  not a hardcoded weekday. Keep npm --prefix frontend test, the worker vitest,
  and PYTHONPATH=src ./venv64/bin/python -m pytest -q green.
- Don't touch odds polling / the odds time-series / settlement / the form mart.
  Polite-fetch only. Commit on the Mac; deploy is David's after verifier sign-off
  (build + wrangler deploy atomically; confirm Clerk origin clerk.keibamon.com).

## Handback to the verifier (Cowork/Claude)
Report: STEP-A source finding (netkeiba vs sportsnavi) + per-G3 runner counts;
the test output; and confirmation that a manual --once publish put runners into
/api/live for both G3s with horse + jockey names. The verifier will query the
keibamon-live D1 live_snapshot for the G3 runner/jockey counts AND re-drive the
live app in the browser: open 函館記念 / ラジオNIKKEI賞, confirm the roster shows
with grayed odds, the form deep-dive resolves a real jockey, and the click-
through to tickets works. Mark "ready for verification", not "done".
```
