# ADR-0003: The weekend race pipeline (selection → posting → curve → results)

- **Status:** Proposed
- **Date:** 2026-06-18
- **Deciders:** David Klan

## Context

Weekend cards (金土日) are the unit of work. Each weekend we want to run the same
loop end to end:

1. **Selection** — pick the runners/races we care about from the lake.
2. **Posting** — publish *our* model fair-odds and the gate (post) for every
   runner **before the market prints**, frozen with a timestamp.
3. **Day-of curve** — track the official odds time-series from announcement to
   post, live.
4. **Results** — settle at the official final payouts and score the weekend.

The point of posting our odds first is **calibration, not edge**. The lake has
already returned a 6-for-6 null on public-data edges (mining, going, training,
odds-curve, exotic cross-pool, and the Benter capstone), and Model 0's
walk-forward beta earns no out-of-sample benefit on the win pool — the JRA market
is near-perfectly calibrated. We are not claiming to beat it. We are building a
durable, honest record of *how and where our model diverges from the market over
time*. That record is only buildable going forward, one card at a time, which is
exactly why the loop has to be repeatable and trustworthy now.

This ADR is the live complement to [[ADR-0002]] (live odds source) on the
*pipeline* level: ADR-0002 decides where odds come from; this decides how a
weekend flows through the system and which machine owns each step.

## Decision

### D1 — Each stage runs on the machine the topology already assigns it

The four stages are not free to run anywhere. The device boundaries in
`docs/device-topology.md` are load-bearing, and the pipeline inherits them:

| Stage | Owner device | Why it must live there |
|---|---|---|
| 1. Selection | **Mac** (`venv64`, lake) | Needs the lake + ML; offline, deterministic, can run Thu/Fri. |
| 2. Posting (our odds + gate) | **Mac** (lake) | Derived from the model; written to the lake first, pushed to D1. |
| 3. Day-of curve | **Capture host** (PC preferred; Mac = interim backup) | Live capture. Must be the **stationary, always-on** host — never the traveling laptop. |
| 4. Results | **Mac** (lake) | Settlement reads the official payout table in the lake. |

Stages 1, 2, and 4 are batch jobs on the Mac. Only stage 3 is a live,
race-day-critical, always-on job, and it carries all the operational risk.

**Future impact:** the pipeline is two systems with different reliability
profiles, not one. The batch half (1/2/4) can fail and be re-run with no data
loss. The live half (3) **cannot** — a missed curve is gone (see D5). Treat them
as separate services with separate monitoring; do not bury stage 3 inside a
"weekend script" that someone runs by hand on a laptop.

### D2 — Our model odds are a new, immutable frozen artifact

Today `curve_log` freezes the *market* curve at a decision time. The calibration
mission needs a **parallel frozen artifact for our own odds**: one row per
runner, written at posting time, carrying our win probability, our fair odds, the
gate, a `posted_at` timestamp, and a `posted_before_market` provenance flag.
Call it `model_card` (parallels `curve_log`, same `(race_id, horse_number)` key).

This table is **append-only and immutable**. Once a card is posted it is never
overwritten — re-posting writes a new versioned row, it does not mutate the old
one. The entire value of the dataset is that each row records what we believed at
a fixed moment; an in-place edit silently destroys the comparison we exist to
make.

**Future impact:** this is the spine of every future calibration report. Get the
immutability and the timestamp right now and the analysis is trustworthy forever;
get it wrong and no amount of later cleverness recovers an honest pre-market
belief.

### D3 — The pre-market gate is *soft*: always record, stamp provenance, filter downstream

The integrity ideal is "our odds must be frozen before the market prints."
But a **hard** gate that refuses to post late means a slow run produces *nothing*
— and then there is nothing to compare at all, which is strictly worse than a
contaminated row we can identify.

So the gate is soft. The pipeline **always writes** the model card, and stamps
each row with `posted_before_market` = (`posted_at` < first market snapshot's
`available_at`). Calibration analysis filters on that flag; contaminated rows are
excluded from the headline number but still visible. This keeps point-in-time
correctness as an *analysis-time* guarantee (mark the provenance, filter later)
rather than a *capture-time* guillotine.

**Future impact:** this is the project's general PIT pattern applied to a live
deadline — capture everything, label what is clean, never let a missed deadline
cost you the row. The same `*_available_at` discipline the lake already enforces,
expressed as a boolean instead of a dropped run.

### D4 — The lake is the record; D1 is disposable display

Every stage writes the **lake first**. The phone dashboard (Cloudflare D1) is a
derived, pass-through projection pushed *after* the lake write, by whichever
capture host holds the `CF_*` creds. If D1 is stale, the lake is still complete
and the dashboard can be rebuilt. No stage ever treats D1 as a store of record.

**Future impact:** the dashboard stays throwaway and the edge plane stays cheap.
We can change, rebuild, or lose the Cloudflare side without touching the data that
matters.

### D5 — For *this* weekend, the live curve has a real gap, and it is operational

[[ADR-0002]] is blocked: we do **not** hold the JRA-VAN realtime (速報系)
entitlement, so `JVRTOpen` and the backfillable `0B41/0B42` time-series are
unavailable. The only live curve source available right now is the **interim
netkeiba feed on the Mac**. That collides with D1: the Mac is the traveling
laptop, and a closed lid already cost us the June 14 afternoon curves.

Decision for this weekend: run stage 3 on a **stationary** Mac with the lid
forced open (`caffeinate -dis` + disable lid sleep), creds preflighted, logging
on — or accept that exotic intraday curves are not captured. Win/place/quinella
curves become backfillable for a year *once the realtime entitlement lands*, so
acquiring that entitlement is the structural fix that removes this whole class of
race-day risk.

**Future impact:** treat the realtime entitlement as the highest-leverage
infrastructure purchase on the roadmap. Until it lands, every weekend's live
curve depends on a laptop not going to sleep, which is exactly the fragility the
topology was written to avoid.

## Consequences

**Positive.** The weekend becomes a repeatable, auditable loop reusing modules
that already exist (`curve_log`, `settlement`/`settle_curve_log`, `predictors`,
`publish_d1`). Calibration evidence accumulates honestly from this weekend
forward. Batch and live halves are cleanly separated so a batch failure is
recoverable and a live failure is loud.

**Costs / risks.** A new immutable table (`model_card`) to maintain. The live
curve depends on the unblocking of ADR-0002; until then it rides on a laptop that
must not sleep. The soft gate means some early cards will be flagged contaminated
and excluded from headline calibration — accepted, by design.

**Explicitly out of scope.** Auto-betting, any edge/profit claim, and treating
model-vs-market divergence as actionable. Divergences are logged and, at most,
surfaced for human curiosity — never acted on automatically. This matches the
recreational, market-honest positioning in `app_plan.md`.

## Alternatives considered

- **Hard pre-market gate.** Rejected (D3): a missed deadline yields no row, which
  is worse than a flagged one.
- **One frozen table for both our odds and the market.** Rejected: different
  provenance, different write times, different immutability story; conflating them
  invites accidental overwrite of the pre-market belief.
- **Run the live curve on the PC this weekend.** Not available: the realtime
  entitlement (ADR-0002) is not yet held, so the PC's `JVRTOpen` path is dark.

Related: [[ADR-0001]] (additive bronze), [[ADR-0002]] (live odds source).
