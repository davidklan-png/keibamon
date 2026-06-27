# CLI agent prompt — serve form/context from D1 via the racing Worker (full port)

> Run on the **Mac** (mac-dev). Makes the form panel ACTUALLY work in prod:
> publish the form marts to D1 and have the keibamon Worker serve
> /api/horses|jockeys|races/*/form with point-in-time aggregation — replacing
> the "Coming this weekend" stub. Branch: feat/form-serving-d1. Commit on the
> Mac; do NOT deploy/import to remote until the Cowork verifier signs off.
> Correctness > speed: this is the surface a user reads to shape a ticket.

```
You are moving the horse/jockey form service from the dev-only FastAPI app onto
the production Cloudflare stack (D1 + the keibamon Worker, src/worker.js), so the
panel built in Milestone 4 is live. Read CLAUDE.md, src/keibamon_core/marts/
form.py (the SOURCE OF TRUTH for card shape — _build_horse_card / _build_jockey_
card and the per-start row builder), backend/keibamon_api/main.py (the existing
/api/horses|jockeys|races/*/form contracts you must REPRODUCE byte-for-byte),
src/worker.js + wrangler.jsonc, and frontend/src/screens/FormPanel.tsx + api.ts.
Run python tools/whichdevice.py — MUST be mac-dev.

## Architecture (decided)
- ONE D1 table, not two. form.py confirms horse_form & jockey_form are
  projections of one completed-start row set. Publish that superset once:
  table `form_starts` carrying every column horse_form has PLUS jockey_id /
  trainer_id / win/top3 derivation, so the Worker computes the horse card by
  filtering horse_name_key and the jockey card by filtering jockey_id.
- Dedicated D1 DB `keibamon_form` + a new binding `FORM` in root wrangler.jsonc
  (keep it OUT of keibamon-live so a rebuild never risks the live snapshot).
- The Worker does PIT aggregation at read: `WHERE available_at < :as_of`. The
  parity target is the Python card — same fields, same rounding, same labels.

## STEP 1 — Schema + indexes (workers or a migrations/ for keibamon_form)
CREATE TABLE form_starts ( horse_name_key TEXT, horse_name TEXT, jockey_id TEXT,
  trainer_id TEXT, race_id TEXT, horse_number INT, available_at TEXT,
  race_date TEXT, racecourse TEXT, surface TEXT, distance_m INT,
  distance_band TEXT, going TEXT, going_wetness INT, is_wet INT,
  grade_label TEXT, field_size INT, finish_position INT, finish_time_seconds
  REAL, margin TEXT, last_3f_seconds REAL, last_3f_rank INT, win_odds REAL,
  popularity INT, beat_market INT, style_signal TEXT );
CREATE INDEX ix_fs_horse ON form_starts(horse_name_key, available_at);
CREATE INDEX ix_fs_jockey ON form_starts(jockey_id, available_at);
CREATE INDEX ix_fs_race  ON form_starts(race_id);
(Confirm column set against form.py before finalizing — if a card field isn't
derivable from these columns, add the column; do NOT change the mart builder.)

## STEP 2 — Publisher (tools/jravan/publish_form_d1.py)
Read data/marts/horse_form.parquet (the superset; it keeps null-jockey starts)
via DuckDB and load form_starts. Idempotent + re-runnable: build a CSV with
DuckDB `COPY (...) TO 'form_starts.csv'`, then `wrangler d1 import keibamon_form
--file=form_starts.sql/.csv` (batch/split — D1 caps statement + import size; ~460k
rows, chunk it). Recreate the table each run (drop+create) so a rebuild is clean.
Print final row count. Keep CF creds out of logs.
(Refresh cadence: marts are static intra-weekend — publish once now. A post-
race-day refresh is the same command; out of weekend scope.)

## STEP 3 — Worker routes (src/worker.js), reproduce the Python contracts EXACTLY
  - GET /api/horses/:name/form?as_of=  — same JSON as backend/keibamon_api.
  - GET /api/jockeys/:id/form?as_of=
  - GET /api/races/:race_id/form       — batch; as_of defaults to that race's
    post_time (read from the live snapshot the Worker already serves), so each
    runner's card excludes the target race.
  - Tolerant as_of (ISO / YYYYMMDD / YYYY-MM-DD / empty→now); unknown→
    {status:"no_history"} (never 500). Do the heavy lifting in SQL (GROUP BY
    with WHERE available_at < :as_of); assemble the card JSON in TS to match
    form.py's structure, field names, and rounding. Leave /api/live + every
    existing route untouched.

## STEP 4 — PARITY GATE (this is the whole risk — make it un-skippable)
A reimplementation in TS WILL drift from the Python unless pinned. Add a parity
harness: a fixture list of (entity, as_of) covering horse, jockey, batch,
no_history, NULL-finish, and a horse in a previously-duplicated race. For each,
assert the Worker JSON deep-equals the FastAPI Python JSON (run the FastAPI app
in-process or against captured golden files generated from it). Any mismatch
fails CI. Also: a PIT test (a start with available_at >= as_of is excluded), and
the dup-invariant still holds (no horse double-counted).

## STEP 5 — Frontend (frontend/src)
Point FormPanel at the same-origin Worker routes (drop the FastAPI base). Keep
api.ts toOutcome error handling, but `comingSoon` must now trigger ONLY on a
genuine no_history, never on 404 (the route exists in prod now). Update the
degraded-render test accordingly. Keep guardrail copy + i18n.

## STEP 6 — Tests green
worker vitest (routes + parity + PIT), frontend vitest, and
PYTHONPATH=src ./venv64/bin/python -m pytest -q all green.

## Constraints
- Don't touch the lake / PIT rules / recommender / the mart BUILDER, and don't
  regress /api/live or the betting loop. Commit on the Mac. `wrangler d1 create
  keibamon_form`, the remote import, and `wrangler deploy` are gated on verifier
  sign-off (David runs them or you run them only after I approve). Never print
  secrets.

## Handback to the verifier (Cowork/Claude) — two stages
STAGE 1 (pre-deploy, branch review): load form_starts into the LOCAL miniflare
D1 and report its sqlite path; run the parity harness + all suites and paste
output; paste the Worker card JSON for /api/horses/ダノンデサイル/form. The
verifier reads the local sqlite directly, confirms ~460,359 rows + 0 duplicated
(horse_name_key,race_id) pairs, independently recomputes ダノンデサイル from
silver (must be 15 starts / 5 wins / 10 top3 / 33.3%), re-checks PIT, and reviews
the parity fixtures.
STAGE 2 (post-import, after sign-off): once `keibamon_form` is created + imported
+ the Worker deployed, the verifier queries the REMOTE keibamon_form via the
Cloudflare connector (row count, dup scan) and confirms the live endpoints return
real cards (no more "coming this weekend"). Mark "ready for verification", not
"done"; don't import/deploy to remote before Stage-1 sign-off.
```
