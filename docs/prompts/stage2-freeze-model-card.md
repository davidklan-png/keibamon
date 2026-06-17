# CLI agent task: commit ADR-0003 and implement weekend stage 2

You are working in the Keibamon repo on the **Mac (`mac-dev`)**. Read `CLAUDE.md`
and run `python tools/whichdevice.py` first to confirm you are on `mac-dev`; if
not, stop. Use the `venv64` interpreter for anything touching DuckDB/ML.

## Context

A design and stubs already exist on disk (written from the Cowork sandbox, not
yet committed):

- `docs/adr/0003-weekend-pipeline.md` — the design. Read it; it is the contract.
- `src/keibamon_core/weekend/{__init__,model_card,pipeline}.py` — stubs.
- `tools/weekend_run.py` — CLI shell.

Stage 2 ("post") freezes **our** model fair-odds per runner, pre-market, into a
new immutable `model_card` table — the twin of `curve_log`. This is a
**calibration** record, not an edge claim (the lake's 6-for-6 null on public-data
edges stands). Do not add betting logic.

## Step 1 — commit the existing design + stubs

```
git add docs/adr/0003-weekend-pipeline.md src/keibamon_core/weekend/ tools/weekend_run.py
git commit -m "ADR-0003: weekend pipeline design + stubs (model_card, device-guarded stages)"
```

## Step 2 — implement `weekend/model_card.py:freeze_model_card`

Satisfy the docstring contract already in the stub. Specifics:

- **Read columnar, never list[dict] over whole tables** (CLAUDE.md): pull the
  race's gold feature rows and its entries (for `gate` = `wakuban`) via
  `src/keibamon_core/lake_query.py`.
- **Score**: call `predictor.score_race(race, feature_rows)` (the `Predictor`
  protocol in `backtest/predictors.py`); the default Model 0 is
  `DeviggedMarketBaselinePredictor`. `score_race` returns `{horse_id: score}` —
  but `model_card` keys on `horse_number`. Map carefully: per
  `adapters/jravan.DATA_TRAPS`, `horse_id='0000000000'` is non-unique, so join on
  `(race_id, horse_number)`, never `horse_id` alone.
- **De-vig within race** to turn scores into `model_p` summing to 1.0. Reuse the
  existing helper — `curve_log.devig(odds_map)` — or the within-race
  normalization in `ingestion/market_baseline` (`devigged_market_prob`). Do not
  hand-roll a third de-vig. `model_fair_odds = 1 / model_p`.
- **Soft pre-market gate (ADR-0003 D3)**: read the earliest market snapshot
  `available_at` for the race from the `odds_snapshots` silver table (NULL if the
  market has not printed). Set `posted_before_market` via the pure
  `model_card.posted_before_market(...)` helper already in the module. Record
  `first_market_available_at` too.
- **Immutability / append-only (ADR-0003 D2)**: `card_version` =
  max(existing version for this race) + 1. Write by appending rows to
  `lake.silver_table(MODEL_CARD_TABLE)` with `lake.write_parquet` — mirror the
  read-modify-write shape of `curve_log.upsert_curve_log`, BUT never mutate or
  drop an existing `(race_id, horse_number, card_version)` row. Re-posting a race
  only ever adds a new version. Add an assertion that proves no prior row changed.
- Populate every column in `MODEL_CARD_COLUMNS` (set `predictor_name =
  predictor.name`, `posted_at`/`logged_at` as UTC iso).

## Step 3 — implement `weekend/pipeline.py:post`

Keep the `_require_role(("mac-dev",), ...)` guard. For each race: call
`freeze_model_card`, then project the frozen cards into the D1 dashboard via
`tools/jravan/publish_d1.py:push_to_d1` — **lake write first, D1 after**
(ADR-0003 D4). Preflight `CF_*` env vars and fail loud if missing (per CLAUDE.md
they don't persist across Mac shells). A D1 push failure must not lose the lake
write.

## Step 4 — tests (required; keep the suite green)

Add `tests/test_model_card.py` with a small deterministic fixture predictor and a
tiny in-memory lake fixture (follow `tests/test_curve_log.py` for the lake-fixture
pattern). Cover:

- `model_p` sums to ~1.0 per race; `model_fair_odds == 1/model_p`.
- `posted_before_market` True when posted before the first snapshot, False after,
  True when no market snapshot exists.
- **Immutability**: posting a race twice yields `card_version` 1 then 2, and the
  version-1 rows are byte-identical before and after the second post.
- `(race_id, horse_number)` mapping is correct when two runners carry
  `horse_id='0000000000'` (the DATA_TRAPS case) — they must not cross-map.

Run: `PYTHONPATH=src ./venv64/bin/python -m pytest -q` — must be all green.

## Step 5 — commit

```
git add src/keibamon_core/weekend/model_card.py src/keibamon_core/weekend/pipeline.py tests/test_model_card.py
git commit -m "weekend stage 2: implement freeze_model_card + post (immutable pre-market cards, soft gate)"
```

## Guardrails

- No edge/profit logic; this is calibration evidence only.
- Honor point-in-time correctness: a card frozen at `posted_at` uses only data
  with `available_at <= posted_at`.
- Do not weaken the device guards. Do not touch JV-Link (Windows-only).
- If a lake interface differs from what's described, prefer the real code and
  note the deviation in your commit message.
