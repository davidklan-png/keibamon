# Keibamon — origin story & milestones

Notes for the build-in-public article. Timeline is from git (`git log`), decisions
from the ADRs in `docs/adr/`. Dates are 2026.

## The one-line story

A solo build-in-public project that started as a hunt for a betting edge in Japanese
horse racing, rigorously proved no such edge exists in public data — and turned that
honest negative result into its identity as a recreational *companion* rather than a
tip sheet. Roughly 122 commits in the first 17 days (Jun 10–27).

## The arc in three acts

**Act 1 — Build the instrument (Jun 10–15).** Stand up a real data platform before
asking it any questions: official JRA-VAN ingestion over a 32-bit Windows JV-Link COM
bridge, a medallion data lake (bronze→silver→gold) in DuckDB, intraday odds-curve
capture, and a phone dashboard on a Cloudflare edge. The discipline that defined
everything after: point-in-time correctness — a decision at time *t* may only use data
knowable at *t*.

**Act 2 — Ask the honest question (Jun 15–19).** Build an evaluation spine
(leakage-guarded, walk-forward, settled at official payouts, judged against a
de-vigged market baseline) and run every promising signal through it. One by one they
came back null. The capstone was the cleanest result of all: a full multivariate
Benter-style model that genuinely learns handicapping signal in isolation, yet
contributes *exactly zero* once the market price is in the blend. The market had
already priced every scrap of public information. Six signals, six honest nulls.

**Act 3 — The pivot (Jun 19–27).** The negative result is the product insight: if you
can't beat the market on public data, don't pretend to. Reframe from alpha-hunting to
an honest companion — help people research a race, form their own read, and structure
recreational tickets without getting fleeced by overbet chalk. Everything from here is
about legibility, honesty, and craft: race-first UX, a form/context service, a social
layer, a live result feed, the Weekend Roundup, a bilingual glossary, an
auto-publishing pipeline, and a ticket builder whose math is actually correct.

## Milestone timeline

| Date | Milestone |
|------|-----------|
| Jun 10 | Initial commit — data-first racing platform (ingestion, backtest, odds polling) |
| Jun 11 | JV-Link bronze ingestion (Windows COM + USB-C delta transfer); first splash page; Cloudflare Workers config |
| Jun 12 | JV-Link COM marshalling fixes; cp932 (Japanese codepage) ingest guard |
| Jun 14 | Silver lake (races/entries/odds/payouts/mining + going/weather), DuckDB read path, multi-pool odds poller, live D1 dashboard (ADR-0002) |
| Jun 15–17 | Going & odds-curve features; training-time parser; modeling spine (Model 0 + tail calibration) — first nulls |
| Jun 17–19 | The market-test programme completes: 6 signals, 6 nulls; the JRA market is efficient on public data |
| Jun 19–20 | App simplification; the fair-value bet helper; the recreational-companion design brief |
| Jun 21 | Social layer — follows, cheers, profiles, feed, share (ADR-0007); shared settle resolver |
| Jun 22–23 | Live result feed with the 確定 (official-confirmation) gate; re-settlement on result change |
| Jun 24–25 | Horse + jockey form/context panel (Milestone 4); form service on D1 + racing Worker; race-first browse UX |
| Jun 26 | Reference section — bilingual glossary + Weekend Roundup; no-fabricated-data empty state; JV-Link masters/microstructure |
| Jun 27 | Grade badges + surface/distance; live Roundup auto-publish cron + staleness guard; disclaimer consolidation; gate+going enrichment; honest WIDE recommender fix; impressions + shared drill-down + structural tickets (ADR-0011) |

## Decision inflection points (the ADRs)

- **ADR-0002 — race-day capture.** Capture odds curves point-in-time; they can't be
  backfilled, so start early. Later hardened by a painful lesson (below).
- **ADR-0004 — Mac-only + scrape.** Retire the licensed two-machine JV-Link rig for a
  single scrape-sourced host, with the licensed pull frozen as an immutable cross-check
  oracle that the new feed must reconcile against at zero mismatch.
- **ADR-0005 — honesty as behavior.** Simplify the surface and bake the
  not-betting-advice posture into tests, not just copy. Later refined to a single
  consolidated disclaimer (acknowledged once at the age gate, persistent in the footer).
- **ADR-0007 — companion surfaces.** Social layer + live result feed with an official
  confirmation gate and correct dead-heat/scratch settlement.
- **ADR-0009 → ADR-0010 — manual to automated publishing.** The Weekend Roundup began
  as a manual operator publish (deliberately no admin-auth write surface), then moved to
  a serverless Cloudflare cron that rebuilds the report from the live capture every few
  minutes — with a staleness guard so a stalled feed freezes the edition honestly
  instead of faking freshness.
- **ADR-0011 — research → ticket loop.** A shared horse drill-down and an impression
  store keyed by (race, horse) so a user's read persists across the weekend and feeds a
  structural ticket model (box / wheel / formation) rendered as a JRA mark-card fill
  guide.

## War stories (good article color)

- **The MacBook lid that killed a race day.** `caffeinate -i` does NOT prevent
  lid-close sleep; a closed laptop lost an afternoon of irreplaceable odds curves.
  Lesson: race-day capture belongs on an always-on, stationary host. (Now serverless.)
- **JV-Link is Windows-only, 32-bit.** The official feed runs nowhere else, forcing a
  two-machine airgap-and-USB design before the Mac-only scrape pivot.
- **The honest capstone.** A model that predicts well alone but blends to zero weight
  against the market is the most intellectually satisfying failure in the project —
  proof the market is the frontier, not a strawman.
- **The WIDE bug a user caught.** A tester noticed a WIDE ticket the app called a
  "loss even on win" actually delivered the best return — because WIDE is the only bet
  where multiple of your lines can win in one race (when three of your horses fill the
  board, three pairs pay). The fix made the displayed math match reality and is a clean
  vignette about why correctness, not cleverness, is the moat.

## Article angles to consider

1. **"I tried to beat the horses with data. The most valuable thing I built was the
   proof that I couldn't."** The honesty pivot as the whole thesis.
2. **Build-in-public velocity** — 122 commits in 17 days, solo, ADRs as you go, AI in
   the loop; what that rhythm actually looks like.
3. **Engineering against the real world** — Japanese codepages, a 32-bit COM bridge,
   sleeping laptops, point-in-time correctness as a non-negotiable.
4. **Designing for honesty** — making "not betting advice" a tested behavior and a
   single deliberate disclaimer, and a recommender that refuses to show a doomed ticket.

## Source pointers

`docs/adr/` (decision records) · `git log` (timeline) · `docs/device-topology.md`
(the cross-device war stories) · the market-test scoreboard on the splash page.
