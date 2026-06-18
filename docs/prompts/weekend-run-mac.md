# CLI agent task: run the full weekend pipeline + cross-val + sync (MAC)

You are the agent on the **Mac (`mac-dev`)**. Read `CLAUDE.md`,
`docs/adr/0003-weekend-pipeline.md`, `docs/adr/0004-mac-only-scrape-sourced.md`.
**First**, run `python tools/whichdevice.py` and confirm it prints `mac-dev`. If it
prints anything else, STOP — you are not on the right host. Use `venv64` for all
Python (`PYTHONPATH=src ./venv64/bin/python`).

This is the **overlap-capture weekend**: the Mac runs the live pipeline + scrape, the
PC produces the official JV-Link oracle (separate prompt), and the Mac runs the
cross-validation gate once both are in the lake. You also sync the repo to origin so
every environment matches.

Set `DATE` to this weekend's race date (`YYYYMMDD`) and `VENUE` to the card's venue
slug (e.g. `hanshin`) before starting.

## Step 0 — green-then-push (sync remote BEFORE the weekend)

The local branch has accumulated the whole pipeline build, unpushed. Sync it now so
the PC pulls identical code.

```
git status                        # expect: ahead of origin by N, clean tree
PYTHONPATH=src ./venv64/bin/python -m pytest -q   # expect 192 passed / 1 skipped
git push origin main              # the user has authorized pushing this turn
git log --oneline origin/main -1  # confirm origin now has the head commit
```

If the tree is dirty, show the diff and stop for review — do not push uncommitted
changes.

> **Code vs data — do not conflate.** This push moves **code only**; the PC
> mirrors it next via `python tools\thursday_sync.py`. Lake **bronze crosses on
> the USB** in Step 3 (`make jravan-import`) — that is a different job and stays
> until the ADR-0004 cutover gate prints `VERDICT: PASS` on a real overlap. Git
> syncs the repo; the USB moves the data oracle.

## Step 1 — Thu/Fri, pre-market: scrape the card + select + post

```
# 1a. Scrape the card once entries post. This writes entries/results/payouts
#     AND the race header (netkeiba_races) -- the header carries each race's
#     grade_code, scheduled_post_time, and netkeiba_race_id (the numeric id
#     that encodes kai/nichi and is NOT derivable from the canonical id).
#     That header is what `track --grades` resolves from on race day -- skip
#     it and the lookup-free track has nothing to look up (it will warn and
#     skip, never fabricate an id).
PYTHONPATH=src ./venv64/bin/python tools/scrape_ingest.py --date $DATE --venue $VENUE

# 1b. Pick the card (default: upcoming + field_size>=1). Pass --grades G1,G2,G3
#     to narrow to graded only -- the ADR-0003/0004 polite-volume default for
#     live odds. Without --grades you get the whole card.
PYTHONPATH=src ./venv64/bin/python tools/weekend_run.py select --date $DATE --venue $VENUE

# 1c. Freeze OUR model odds pre-market + push the card to D1
#     (post is reached via the pipeline fn; CF_* must be sourced first)
PYTHONPATH=src ./venv64/bin/python -c "
from keibamon_core.paths import LakePaths
from keibamon_core.weekend import pipeline
from keibamon_core.backtest.predictors import DeviggedMarketBaselinePredictor
lake = LakePaths(); lake.ensure()
ids = pipeline.select(lake, '$DATE', venue='$VENUE')
print(pipeline.post(lake, ids, predictor=DeviggedMarketBaselinePredictor()))
"
```

Confirm `posted_before_market` is **True** for the frozen rows (you posted before the
market printed). If `select` returns `[]`, entries aren't posted yet — re-run later.

## Step 2 — race day: track (the only unrecoverable job)

The Mac is the sole live source (ADR-0004). It must be **stationary, lid forced
open**; `track` spawns `caffeinate -dis` but also disable lid-close sleep in System
Settings. Source `CF_*` first (they don't persist across shells).

Live odds are **graded-only by policy** (G1/G2/G3) — keeps polling polite (ADR-0004).

```
# PREFERRED -- self-resolving, no lookups. Requires the Step 1a card scrape so
# the lake carries each graded race's netkeiba_race_id + post time + grade.
# Resolves *which* races are graded (across all venues that day), their post
# times, and the netkeiba ids -- all from the lake. A graded race missing its
# stored nk id is named and skipped (never fabricated).
PYTHONPATH=src ./venv64/bin/python tools/weekend_run.py track \
    --date $DATE --grades G1,G2,G3

# FALLBACK -- explicit args. Use when the lake lacks the self-resolve mapping
# (e.g. a quick test on a known race) or you want to narrow to one venue.
PYTHONPATH=src ./venv64/bin/python tools/weekend_run.py track \
    --date $DATE --venue $VENUE \
    --nk-race-ids <id01,id02,...> \
    --post-times-jst <HH:MM,HH:MM,...>
```

Watch the per-cycle summary: `last_banked` should climb and `last_push` should read
`ok`/`pushed`. A `preflight warnings:` line means a curve is still being banked but
either sleep-inhibit or `CF_*` needs attention — fix without stopping the loop. Let
it run until after the last race posts.

## Step 3 — after results: scrape ingest + import the PC's official pull

```
# 3a. scrape the official results/payouts/entries into silver (the Mac side)
PYTHONPATH=src ./venv64/bin/python tools/scrape_ingest.py --date $DATE --venue $VENUE

# 3b. import the PC's JV-Link bronze from the USB (the oracle side), then rebuild
make jravan-import        # import_delta.py --from /Volumes/KEIBA/keibamon-xfer
# rebuild silver -> gold -> marts from the updated bronze using the project's
# ingestion entrypoints. Check src/keibamon_core/ingestion/runner.py + the Makefile
# for the canonical rebuild command; do NOT invent one.
```

## Step 4 — settle + score the card

```
PYTHONPATH=src ./venv64/bin/python -c "
from keibamon_core.paths import LakePaths
from keibamon_core.weekend import pipeline
lake = LakePaths()
ids = pipeline.select(lake, '$DATE', venue='$VENUE', include_run=True)
print(pipeline.settle(lake, ids))
"
```

This settles the curve log + the model_card top picks at official payouts and prints
the calibration report (sliced by `posted_before_market`). Remember: this is a
calibration verdict, not an edge claim.

## Step 5 — the cross-validation gate (the cutover decision)

Now that both the scrape and the official JV-Link pull are in the lake for the same
races, run the gate:

```
PYTHONPATH=src ./venv64/bin/python tools/validate_scrape_vs_jravan.py --date $DATE
```

- `VERDICT: PASS` (0.0000% mismatch on all four oracles + settle equivalence) → the
  scrape is proven against the official source for this weekend. Tick the ADR-0004
  cutover checkbox (fill the real date) and note the verdict in the commit.
- Any mismatch → the gate prints the offending races/diff. This is almost certainly a
  **parser delta vs live netkeiba payloads** (the open ADR-0004 item). Fix the parser,
  re-run `scrape_ingest`, re-run the gate. **Do NOT advise retiring the PC** until this
  prints PASS. One clean weekend is necessary, not sufficient — note it as the first
  passing overlap.

## Step 6 — commit results + re-sync

```
git add -A
git commit -m "weekend $DATE: pipeline run + cross-val ($VERDICT); ADR-0004 cutover status"
PYTHONPATH=src ./venv64/bin/python -m pytest -q   # stay green
git push origin main
```

## Guardrails

- Confirm `mac-dev` before acting; every stage self-guards but verify anyway.
- Lake first, D1 best-effort — never stop the track loop over a push failure.
- No betting actions; drift flags and divergences are logged, never bet.
- The PC is NOT retired until the gate prints PASS on a real overlap. Report the
  verdict; let the human make the switch-off call.
- Prefer real commands over this spec; if an interface differs, note it and proceed.
```
