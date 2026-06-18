# ADR-0002: Live odds via JRA-VAN realtime (JVRTOpen), with a conservative fetch design

- **Status:** Proposed — **BLOCKED on a prerequisite**
- **Date:** 2026-06-13
- **Deciders:** David Klan

> **Prerequisite (2026-06-13):** the JRA-VAN realtime path requires the **live /
> 速報系 entitlement**, which we do **not** currently hold (the existing license
> covers only the accumulated/historical 蓄積系 pull). `JVRTOpen` will return an
> authentication error until that subscription is active. **Until then the interim
> live source is the netkeiba JSON API (Mac), with Yahoo SSR as reference.** The
> "1-year backfillable curve" benefit (`0B41/0B42`) is also gated on this
> entitlement — so for now the intraday curve genuinely cannot be backfilled, and
> the original "capture live early" urgency stands for any pool we want the curve
> on. This ADR becomes active only once the realtime license is acquired.

## Context

We need the live odds time-series (announcement → post drift) for the race-day
dashboard and, more importantly, for honest ROI / market-calibration features.
We had been building toward scraping a third party (netkeiba JSON API, then Yahoo
SportsNavi HTML). Re-examining the sources shows that all of them ultimately
*derive from JRA's official pari-mutuel pools* — and we already license direct,
programmatic access to that source through the JRA-VAN Data Lab subscription.

### Source re-examination

| Source | Directness | Legality | Pools | Curve | Platform | Form |
|---|---|---|---|---|---|---|
| **JRA-VAN realtime (JVRTOpen)** | authoritative (official) | licensed | all (`0B30`) | pre-assembled (`0B41/0B42`) | Windows PC (32-bit COM) | same O1–O6 records we parse |
| netkeiba JSON API | derived | ToS gray | win/place + exotics by `type` | poll & stitch | any (Mac OK) | JSON |
| Yahoo SportsNavi | derived | ToS gray | all + payouts + horse IDs | poll & stitch | any | SSR HTML (heavier) |
| JRA official site | source, but as a scrape | ToS gray | all | poll & stitch | any | HTML |

Confirmed from the licensed spec (`reference/jravan/.../JV-Data仕様書`):
- `0B30` 速報オッズ(全賭式) — realtime odds, **every bet type in one request**,
  served 金土日 随時 (continuously on race days), retained 1 week.
- `0B31`–`0B36` — per-pool realtime odds (win/place/bracket, quinella, wide,
  exacta, trio, trifecta), mapping to records O1–O6 respectively.
- `0B41`/`0B42` 時系列オッズ — the **intermediate-odds time series** (the curve)
  for win/place/bracket and quinella, **retained 1 year**.
- All of the above are the O1–O6 record layouts already implemented in
  `adapters/jravan` (`parse_grouped_record`). No new parser is required.

## Decision

1. **Primary live source: JRA-VAN realtime via `JVRTOpen` on the Windows PC.**
   - Pull `0B30` (all-pool realtime odds) on an adaptive cadence for live prices.
   - Pull `0B41`/`0B42` (time-series odds) for the assembled curve.
   - Parse with the **existing O1–O6 parser**; land in the lake; publish a
     derived snapshot to Cloudflare D1 for the dashboard.
   - This is authoritative, licensed (no ToS gray area), covers all pools, and
     delivers the curve directly.

2. **Fallback only (Mac, when the PC is unavailable): netkeiba JSON API**, with
   change-detection. Kept because it is Mac-runnable and already implemented;
   used as a stopgap, not the canonical feed.

3. **Yahoo SportsNavi: reference/cross-validation only**, not an automated
   polling source. Its SSR HTML is useful for a human sanity check and for the
   horse pedigree IDs / payout display, fetched occasionally — never hammered.

### Conservative + efficient fetch design

- **One primary source per cycle.** No parallel multi-source polling of the same
  race. Cross-validation against a secondary happens occasionally (e.g. once near
  post), not every cycle.
- **Adaptive cadence.** Tighten as post time approaches (existing schedule) AND
  **back off when the source's own timestamp is unchanged** (`0B30` returns no new
  file / `official_datetime` not advanced) — poll the source no faster than it
  updates.
- **Change-detection + dedupe.** Skip work when the source timestamp is stale;
  dedupe silver on `available_at` (already implemented). `0B30` is one request for
  all pools rather than 6+.
- **Archive raw once** to bronze (replayable), then parse — already the contract.
- **Scrape fallbacks stay polite.** netkeiba/Yahoo only via conditional requests
  (ETag/If-Modified-Since), a descriptive User-Agent, robots.txt compliance, and
  strict rate limits.

## Consequences

**Positive.** Authoritative and license-clean (removes the scraping ToS risk the
project had accepted). One request (`0B30`) covers all pools. The curve is
delivered pre-assembled. Reuses the O1–O6 parser entirely. Minimal load on third
parties.

**Correction to a prior assumption.** We had recorded that the announcement→post
odds curve "cannot be backfilled, so start live capture early." That is now only
partly true: JRA-VAN **retains the time-series (`0B41`/`0B42`) for 1 year** for
win/place/bracket and quinella, so recent curve history for those pools **is
backfillable** from the licensed feed. This materially lowers the urgency of
live scraping for those pools. (Exotic full time series beyond `0B30`'s 1-week
retention may still warrant live capture if we want their intra-race curve.)

**Costs.** `JVRTOpen` is Windows-only 32-bit COM (same constraint as the bulk
JV-Link pull), so live capture runs on the PC, which must be running and pushing a
snapshot to Cloudflare for the dashboard to update while the operator is away.
Realtime integration carries its own small spec/eventing tax (`JVRTOpen` +
确定/变更 events, return-code handling).

## Alternatives considered
- **Scrape Yahoo/netkeiba as the primary feed** — rejected: derived data, ToS
  gray, brittle HTML/JSON that can change without notice, and redundant with a
  feed we already pay for.
- **Scrape the JRA official site** — rejected: same ToS/brittleness, no advantage
  over the licensed JV-Link path.

Related: [[ADR-0001]] (JRA-VAN additive bronze). The realtime path is the live
complement to ADR-0001's bulk historical pull, using the same records and lake.

---

## Status update (2026-06-17): entitlement acquired — curve backfill UNBLOCKED

The original note above (entitlement not held; `0B41/0B42` un-backfillable) is
superseded. The 速報/時系列 entitlement is now held — proven empirically by the
2026-06-14 race-day `0B30` realtime capture, which the PC pulled via `JVRTOpen`
and which is now in the lake as source `jravan_rt` (folded into
`jravan_odds_timeseries`). JRA-VAN registration + 利用キー setup post-dated the
original decision.

**Consequences:**

- `0B41/0B42` 時系列オッズ (1-year retention) is now pullable on the PC. A
  one-shot trailing-year backfill (manifest airlock → Mac import) is the fast
  path to the curve validator's 200-race threshold.
  See `tools/jravan/backfill_timeseries.py`.
- Live `0B30` race-day capture is the forward-accumulate source; the curve is
  inherently forward-only (1-year cap), so the binding constraint is reliable
  always-on PC capture, not entitlement.
- Original "genuinely cannot be backfilled" lines are retained for history but
  no longer apply.
