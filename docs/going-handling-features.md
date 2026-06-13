# Going-handling features — design

**Goal.** Quantify, point-in-time, how well each runner handles *today's* going
relative to the rest of the field — adding lift **beyond** the official going code
(already in the data) and **beyond what the market already prices**.

Status: design. Prerequisite step 0 below must land first.

## Inputs (and a prerequisite gap)

- `jravan_races` — surface, distance, and going. **Gap:** the going/weather codes
  are *parsed* in the RA layout (`weather_code`, `turf_going_code`,
  `dirt_going_code`) but **not yet surfaced into the silver `jravan_races`
  table** (`_race_record` maps surface/distance/post/last_3f only). Surfacing
  them is **step 0**.
- `jravan_race_results` — per-horse `finish_position`, `finish_time`, `margin`,
  `last_3f`.
- `jravan_race_entries` — `horse_id` (ketto_num), `umaban`, running-style/draw.
- pedigree (BLOD/`HN`) — sire identity, for the going-affinity prior.
- weather overlay — *forecast* going for the upcoming race, pre-race, carrying an
  honest `available_at` (see docs/adr context on the weather overlay).

## Going representation

- JRA going as an **ordinal "wetness" 1–4** (良 / 稍重 / 重 / 不良).
- **Surface-specific** — turf-soft and dirt-heavy are different worlds; never pool
  them. Build turf and dirt going-handling separately.
- "Today's going" `G` = **forecast** (pre-race, usable) for prediction features;
  the **official** code is settlement-time only (leakage if used pre-race).

## The two confounds that wreck the naive version

1. **Track speed, not handling.** Raw finish time is slower for *everyone* on wet
   ground, so raw time/figure isn't comparable across goings. Normalize to a
   **going-neutral, field-relative** performance: beaten-lengths-per-furlong,
   finish percentile, or speed-figure-vs-race-par. This isolates *handling* from
   *track condition*.
2. **Small samples + selection.** Most horses have few wet runs; a 1-for-1 wet
   record is not "100% mudder." **Shrink** the going-specific estimate toward a
   prior (the horse's own all-going level, and the sire's wet affinity),
   empirical-Bayes by run count.

Getting these two right is the difference between a real signal and noise that
backtests beautifully and bets terribly.

## Core signal: the going performance *delta*

For horse `h` on surface `s`, using only races with `available_at <= as_of_time`:

- `perf(r)` = going-neutral, field-relative performance in past race `r`
  (higher = better; e.g. standardized beaten-margin or finish percentile).
- `delta_wet(h)` = `mean(perf | wet runs) − mean(perf | firm runs)` — how the
  horse's *relative* result shifts as ground softens — **shrunk** by counts
  toward 0 (no shift) and toward `sire_going_affinity`.
- Sign reads cleanly: **positive = improves on soft (mudder); negative = wants
  firm.**
- Project onto today's ground: `going_fit(h, G) = baseline(h) + delta_wet(h) ·
  (G − 2)/scale` (linear in wetness; piecewise if data supports it).

## Feature list (per runner, point-in-time)

**Absolute**
- `going_runs_similar` — prior runs within ±1 of `G`, same surface (confidence).
- `going_winrate`, `going_top3rate` — shrunk toward overall.
- `going_perf_delta` — the mudder/firm signal above (shrunk).
- `going_fit` — `going_perf_delta` projected onto today's `G`.
- `sire_going_affinity` — pedigree prior (also the shrinkage target).
- `last_good_run_going_match` — recency-weighted: was the last strong run on
  ground like today's?
- `forecast_going_uncertainty` — forecast confidence + an **extrapolation flag**
  when `G` is outside the horse's experience.

**Within-race (these matter most — betting is relative)**
- `going_fit_z` — z-scored across *today's* field (Nao-style within-race norm).
- `going_fit_rank`, `going_perf_delta_z`.

**Interactions**
- `going × distance`, `going × running-style/draw` — track and pace bias shift
  with going (e.g. front-runner advantage on soft, inside bias when wet).

**Market-aware (the edge)**
- `going_fit_z − market_implied_rank` — **disagreement**: where our going read
  isn't already in the odds. Same principle as the odds analysis: the priced-in
  part is dead money; the *gap* is the signal. The classic case is a horse with
  few wet runs but strong sire affinity that the market hasn't clocked yet.

## Cold-start / missing data

- Few/no wet runs → lean on `sire_going_affinity` + overall level; shrinkage makes
  this smooth, not a cliff.
- Foreign/placeholder `horse_id = '0000000000'` (the known join trap) → no
  history; emit nulls + a `missing_going_history` flag rather than fake zeros.

## Point-in-time & compute

- Every horse-history aggregate is a **rolling, as-of** computation over prior
  results only (`available_at <= as_of_time`); the gold leakage guard enforces it.
- This is heavy (per-(race,horse) windows over 30 years), so build it on the
  **DuckDB/columnar path** (scalability ADR), windowing/grouping in SQL — never
  `list[dict]`.

## Validation (honest bar)

1. Restrict to **off-going races**; does `going_fit_z` improve out-of-sample
   log-loss **on top of** the raw official going code already being a feature?
2. **Market test:** do high-`going_fit_z` horses beat their *market price* on wet
   days? Calibrate and check ROI on the disagreement bucket — not just hit rate.
3. Respect the uneven era coverage (dense 2023–26 & ~1990–91) when splitting.

## Sequencing

0. Surface going + weather codes into silver `jravan_races` (prerequisite).
1. Going-neutral, field-relative `perf` metric in silver results.
2. PIT rolling `going_perf_delta` per horse (gold).
3. `sire_going_affinity` prior from pedigree (gold).
4. Within-race z-scores + the market-disagreement feature.
5. Validate on the off-going subset before trusting any of it.
