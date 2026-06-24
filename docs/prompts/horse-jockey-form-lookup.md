# CLI agent prompt — rich horse/jockey form lookup (weekend G3s)

> Run on the **Mac** (mac-dev: has git, the lake, venv64). This builds the
> net-new "historical context" surface David wants for the two Jun 27–28 G3s
> (Radio Nikkei Sho, Fukushima 1800m + the second G3 on the same card): a rich
> horse/jockey form panel that shapes intuition before tickets are built.
> The Cowork/Claude agent (Linux sandbox) is the **verifier** — see Handback.

```
You are building a rich horse + jockey FORM-CONTEXT feature for the Keibamon
companion app: a read-only panel that, for any runner in a race, shows that
horse's recent form and its jockey's record, built from the silver lake. This
is recreational context to "shape intuition," NOT an edge claim or tip. Read
CLAUDE.md, app_plan.md (Milestone 4 lookup spec + Guardrails), and
src/keibamon_core/lake_query.py first. Run `python tools/whichdevice.py` — it
MUST be mac-dev. If not, stop.

Work on a branch: feat/weekend-form-lookup. Commit on the Mac. Do NOT deploy —
the Cowork verifier reviews the branch first, then David deploys.

## STEP 0 — Restore the test env (prereq; the go-live agent flagged it gone)
venv64 was removed from mac-dev, so `PYTHONPATH=src python -m pytest -q` can't
run and STEP 4 would fail. Recreate it before building:
  python3 -m venv venv64
  ./venv64/bin/pip install -U pip
  ./venv64/bin/pip install -e ".[dev]"      # pulls duckdb, numpy, pandera, polars, pytest
  PYTHONPATH=src ./venv64/bin/python -m pytest -q   # baseline MUST be green BEFORE you change anything
If the baseline isn't green on a clean tree, STOP and report — don't build on a
red suite (you won't be able to tell your changes from pre-existing breakage).

## Ground truth already established (don't re-derive)
Silver tables (data/normalized/, read via DuckDB / lake_query.py — never
list[dict] scans):
  - jravan_race_results: race_id, horse_id, horse_number, finish_position,
    finish_time_seconds, margin, win_odds, popularity, last_3f_seconds,
    available_at, venue, year   (~462k rows)
  - jravan_race_entries:  race_id, horse_id, horse_name, horse_number, gate,
    jockey_id, trainer_id, carried_weight_kg, body_weight_kg, available_at,
    venue, year             (~462k rows)
  - jravan_races:         race_id, race_date, racecourse, surface, distance_m,
    scheduled_post_time, race_name, grade_code, weather, going_turf,
    going_dirt, going_wetness, going, available_at, venue, year (~39k rows)

JOIN KEYS — read carefully, these are the whole ballgame:
  - DATA_TRAP (CLAUDE.md): horse_id='0000000000' is a non-unique sentinel
    (716 rows). NEVER aggregate horse history on horse_id. The stable identity
    is horse_NAME (61,717 distinct). Attach a finish to an entry on
    (race_id, horse_number), then group by horse_name.
  - The LIVE snapshot runner shape (frontend/src/api.ts LiveRunner +
    src/keibamon_core/live/snapshot.py build_runner) carries ONLY {umaban,
    name, win_odds…}. It does NOT carry horse_id or jockey_id. So the panel
    must look up history by horse NAME (normalize: trim, NFKC, drop spaces).
  - JOCKEY GAP (must handle explicitly): silver entries have jockey_id (696
    distinct) but NO jockey name, and the live snapshot carries no jockey id or
    name either. So jockey form cannot be name-matched the way horses can.
    Resolve it ONE of these ways (pick the cheapest that works, document which):
      (a) Extend the live feed: the netkeiba entries scrape
          (adapters/netkeiba_entries.py) parses the jockey NAME and jockey_id
          from `<td class="Jockey">`. Carry jockey_name (and netkeiba jockey
          id) through build_runner into the snapshot runner, so the panel has a
          jockey to look up. Preferred — it's the real fix.
      (b) Build a jravan jockey_id → name crosswalk from the netkeiba scrape
          and match jravan history by name.
    If neither can be done cleanly by the deadline, ship HORSE form fully and
    render the jockey card as "coming soon" rather than wrong. Say so in the
    handback.

POINT-IN-TIME: non-negotiable. Every aggregate is "as of" the target race's
post time: include only rows with available_at <= as_of and EXCLUDE the target
race itself. The mart builder must take an as_of and filter on it; a leak here
is a correctness bug, not a cosmetic one.

## STEP 1 — Form mart (src/keibamon_core, DuckDB)
Add a mart builder (e.g. src/keibamon_core/marts/form.py) + a Make/CLI entry
that writes two marts under data/marts/:
  - horse_form.parquet — one row per (horse_name, as-of race) OR a tidy
    per-horse-run table the API aggregates on read; your call, but it must be
    DuckDB-queryable and PIT-filterable. Rich content David asked for:
      * last-N finishes (date, course, surface, distance, going, field size,
        finish_position, margin, last_3f, win_odds, popularity)
      * distance splits (record by distance band) and surface splits
        (turf/dirt) and going/WET splits (going_wetness / going buckets)
      * a running-style proxy from position + last_3f (e.g. front/stalk/closer
        — derive from last_3f rank vs finish, document the heuristic; label it a
        proxy, not a fact)
      * market-vs-result: popularity vs finish (over/under-performance), purely
        descriptive
  - jockey_form.parquet — per jockey: starts, win%, top3%, by-course
    (racecourse) splits, recent-form window, and jockey×horse and
    jockey×trainer combo counts. Keyed per the JOCKEY GAP resolution above.
Validate with Pandera if the repo's other marts do. Add the new marts to
.gitignore data rules if marts are gitignored (check).

## STEP 2 — API (backend/keibamon_api/main.py)
Add read endpoints that the panel calls, reading the marts via lake_query.py:
  - GET /api/horses/{name}/form?as_of=<iso>  -> the rich horse card
  - GET /api/jockeys/{id_or_name}/form?as_of=<iso> -> the jockey card
  - (optional) GET /api/races/{race_id}/form -> batch: form for every runner,
    so the panel is one request per race.
Degrade gracefully (no-data → {status:"no_history", ...}, never 500). Keep the
existing /health, /api/races contracts unchanged.

## STEP 3 — Frontend panel (frontend/src)
Add a Form/Context panel reachable from RaceScreen (tap a runner) and from
ExplainScreen. Match the existing companion aesthetic (friendly labels, not a
trading terminal — see app_plan "Younger Demographic Fit"). Show:
  - horse: recent finishes spar-style, distance/surface/wet fit chips, running
    style tag, "market vs result" note;
  - jockey: win%/top3% headline, this-course record, recent form.
Wire it to feed intuition: from the panel, let the user mark the runner
liked/anchor/chaos/fade (reuse the existing intuition state) so context flows
straight into ticket construction. Honor GUARDRAILS: no "lock/sure thing/beat
the market" language; label everything as context, keep "not betting advice"
visible. i18n: add en + ja strings (mirror frontend/src/i18n/).

## STEP 4 — Tests (must be green for the verifier)
  - python (use the venv64 from STEP 0): PYTHONPATH=src ./venv64/bin/python -m
    pytest -q  (add tests for the mart's PIT
    filtering — prove a row with available_at > as_of is excluded — and the
    name-normalization join; add a horse_id='0000000000' fixture to prove it's
    never used as a horse key)
  - frontend: npm --prefix frontend test  (panel render + a guardrail-copy test
    like the existing i18n/guardrails.test.ts; update snapshots intentionally)

## Constraints
- Don't touch the racing lake's PIT rules, the recommender, or fairvalue. Don't
  change the /api/live producer except the minimal jockey_name passthrough in
  STEP-1(a) if you choose it.
- Every new data gotcha → adapters/jravan DATA_TRAPS.
- Commit on the Mac (sandbox git is unreliable). Never print secrets.

## Handback to the verifier (Cowork/Claude, runs in the Linux sandbox)
Push branch feat/weekend-form-lookup and report:
  1. which JOCKEY-GAP option you took (and if jockey shipped or is "coming soon")
  2. the mart builder command + row counts for horse_form / jockey_form
  3. pytest + frontend test output (counts, green)
  4. a 3-line sample: pick one horse you KNOW runs in a Jun 28 G3 (or any
     real horse_name) and paste its form card JSON so the verifier can spot-check
     the numbers against silver.
The verifier will: re-run pytest + frontend tests in the sandbox, review the
diff, REBUILD the mart from silver and independently recompute one horse's
last-5 + one jockey's win% to confirm they match, and check the PIT filter with
a crafted as_of. Only after the verifier signs off does David merge + deploy.
Do not mark "done" — mark "ready for verification."
```
