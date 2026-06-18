# CLI agent task: implement weekend stage 1 (select the card)

You are working in the Keibamon repo on the **Mac (`mac-dev`)**. Read `CLAUDE.md`,
`docs/adr/0003-weekend-pipeline.md`, and `docs/adr/0004-mac-only-scrape-sourced.md`.
Run `python tools/whichdevice.py` to confirm `mac-dev`. Use `venv64`.

## Context

Stage 1 (`select`) is the last stub in the weekend pipeline (stages 2/3/4 are done).
It picks **which races** we will post, track, and settle this weekend, and feeds
their canonical `race_id`s into the rest of the loop. It is an offline, deterministic
Mac batch job — safe to run Thu/Fri before the card.

Scope note: stage 1 selects **races**, not horses. Horse-level selection/ranking is
already what stage 2 (`model_card.freeze_model_card`) does. Don't put per-runner
scoring here.

## What the lake actually gives you (don't invent columns)

The `races` mart (`MART_RACES`, `ingestion/marts.py`) has exactly:
`race_id, race_date, racecourse, country, surface, distance_m, scheduled_post_time,
field_size, results_available, source_name, content_hash`. Canonical id is
`jra-YYYYMMDD-<jyo>-NN`.

**There is no `grade`/`grade_label` column.** So grade-based selection is not
possible yet — either filter on what exists (below) or, if grade filtering is wanted,
add `grade` to silver `races` + the mart first (separate, larger change; call it out,
don't fake it).

## Step 1 — implement `pipeline.select`

Replace the `NotImplementedError`. Keep `_require_role(("mac-dev",), "select",
role_file)`. Signature stays `select(lake, race_date, *, role_file=None) -> list[str]`,
plus optional filter kwargs:

```
def select(lake, race_date, *, role_file=None,
           venue=None,            # racecourse slug filter (e.g. "hanshin")
           min_field_size=1,      # skip races with no entries posted yet
           include_run=False,     # default: only upcoming (results_available False)
           races=None) -> list[str]
```

- Read the `races` mart scoped to `race_date` via `lake_query` predicate pushdown
  (not a whole-table list[dict] scan — CLAUDE.md read-path rule).
- Default filter = **upcoming races on the date with entries posted**: `race_date ==
  target AND field_size >= min_field_size AND results_available == False`. This is the
  PIT-honest "what can we still post a pre-market card for" set; `include_run=True`
  lifts the results gate for backfilling/replays.
- Optional `venue` (match `racecourse`) and explicit `races` (race-number subset).
- Return canonical `race_id`s **sorted by `scheduled_post_time` then `race_id`**, so
  the downstream order matches the day's running order.
- Empty result is a valid answer (no card / wrong date) — return `[]`, don't raise.

If it's cheap, also expose `select_specs(...)` returning
`(race_id, scheduled_post_time)` tuples — `track`'s adaptive cadence wants post
times, and re-reading the mart there is wasteful. Keep `select` itself returning
`list[str]` for its callers.

## Step 2 — wire the CLI

`tools/weekend_run.py select --date YYYYMMDD [--venue ...] [--races ...]` calls
`pipeline.select` and prints the chosen `race_id`s (one per line, plus a count).
Keep the device guard in the pipeline layer, not the CLI.

## Step 3 — tests (`tests/test_select.py`, keep suite green)

Follow the existing fixture-lake pattern:

- Date filter returns only that date's races, sorted by post time.
- `results_available == True` races are excluded by default, included with
  `include_run=True`.
- `min_field_size` drops not-yet-carded races (field_size 0).
- `venue` and `races` subsetting work and compose.
- Empty/`wrong-date` returns `[]` (no raise); wrong device → `WrongDeviceError`.

Run: `PYTHONPATH=src ./venv64/bin/python -m pytest -q` — all green.

## Step 4 — commit (not pushed; standing instruction)

```
git add src/keibamon_core/weekend/pipeline.py tools/weekend_run.py \
        tests/test_select.py docs/prompts/stage1-select-card.md
git commit -m "weekend stage 1: select (mac-dev, mart-scoped, upcoming-races default)"
```

## Guardrails

- `mac-dev` only; offline/deterministic; no network.
- Filter on real mart columns; do NOT invent a `grade` filter — flag it as a
  follow-up needing a schema add.
- Default to the PIT-honest upcoming set (un-run, entries posted).
- If a real interface differs from this spec, prefer the code and note the deviation.
```
