# Odds-flow anomaly scan — flag, not verdict

A first-pass detector for *unusual money movement* in the JRA win market, built
on the lake's intraday odds curves. **This flags statistically unusual betting
flow. It does not — and cannot — establish that any race was fixed.** An anomaly
is a prompt to look, not a conclusion. Most have innocent explanations (informed
stable money, late scratches reshaping the pool, syndicate betting, noise).

## Data + method
- **Sample:** 48,378 runners across 3,504 races (Jun 2025 – Jun 2026), from the
  83M-row `jravan_odds_timeseries` (win + quinella pools).
- **Don't trust the opening board.** The first pari-mutuel price is thin-pool
  noise (a few yen swing it wildly). Every reading here is taken from a
  *stabilized* point ~30 min before post (`T-30`) to the posted (final) price,
  validated as ≈ official result odds (ratio 1.000).
- **Signal A — steam/plunge:** how far a horse's price *shortened* from T-30 to
  posted, normalized within its odds band (robust z on the band's own
  distribution). Big = money rushed in faster than that band normally moves.
- **Signal B — cross-pool:** each horse's win-pool implied share vs its
  quinella-implied top-2 share. A horse heavily backed in one pool but not the
  other is hard to explain innocently.

## Headline finding 1 — unusual plunges *overshoot* (and don't pay)
The money that rushes in pushes the price **shorter than the horse's true
chance**:

| plunge strength | n | actual win rate | posted-odds implied |
|---|---|---|---|
| z > 1.5 | 1,283 | **12.9%** | 16.0% |
| z > 2.0 | 79 | **16.5%** | 24.8% |

The stronger the plunge, the *worse* the overshoot. Backing into a plunge is
negative-EV — you'd be taking ~16–25% implied on a horse that wins ~13–16%. So
unusual money here is **not informed money beating the market**; if anything the
market over-reacts to the flow. This is consistent with Keibamon's standing
result: even anomalous public signals don't clear the bar.

## Headline finding 2 — the pools are coherent (no manipulation fingerprint)
The classic integrity flag elsewhere is one pool out of line with another. Here
the win and quinella markets agree almost everywhere — in full fields the largest
win-vs-quinella share gaps are only ~1–3 points (e.g. 24.6% vs 21.9%). There is
**no systematic cross-pool incoherence** that would fingerprint coordinated
money. The Japanese pari-mutuel pools price themselves consistently.

## The stories the detector surfaces
Vivid individual cases exist in both directions — but read as informed money vs
hype/over-reaction, not coordination:

**Money was right (plunge → won):**
- オリオンブレード — Hanshin, 2026-04-11: 7.5 → 2.0, won
- リカントロポ — Hanshin, 2025-06-21: 45.5 → 13.0, won
- マーゴットブロー — Nakayama, 2025-09-13: 38.9 → 14.1, won

**Money was wrong (plunge → flopped — your "undeserving favorite"):**
- エリーニック — Hanshin, 2026-02-22: 126.6 → 40.7, finished **last (13/13)**
- リドルトリガー — Chukyo, 2025-12-07: 49.3 → 12.8, finished **last (14/14)**
- ファツアップ — Chukyo, 2025-12-20: 35.7 → 8.7, finished 10/16
- セイウンリメンバー — Niigata, 2025-08-10: 21.3 → 7.1, finished 15/18

The floppers are exactly the phenomenon you intuited — money moving hard toward a
horse that didn't deserve it. They're real. But the aggregate (finding 1) says
they read as **over-reaction/hype**, and you can't profit by spotting them
because the price overshoots.

## Honesty + limits
- **Flag ≠ fix.** Base rate of actual fixing is very low, especially in the
  tightly-policed JRA; false positives dominate. Attribution is an integrity
  unit's job with corroborating evidence, not a data lake's.
- Pari-mutuel only — no fixed-odds bookmaker line to cross-check against.
- The lake's place-pool odds are null, so cross-pool used quinella only.
- Result is shown as *context*; flags are not conditioned on it (no hindsight).
- Sanity: top-50 flags have median 143 snapshots over median 15-runner fields —
  well-captured real races, not capture artifacts.

## Pattern-of-life — the money clusters on *people*, and it's mostly wrong
Baseline strong-plunge rate is **2.8%** of runners. Some connections attract it
several times more often — and far beyond chance:
- A handful of **trainers** carry a 5–9% plunge-flag rate (up to **3.2× baseline,
  z ≈ 5.8**) — their horses get money-dumped far more than average.
- Some **jockeys** likewise (z up to ≈ 6.2).

The revealing part is the *outcome split* of those flagged plunges, which cleanly
separates two populations:
- **"Informed-looking" connections** — when their horses are plunged, they win
  ~25–28% of the time (real barn/rider confidence that mostly pays).
- **"Popularity/hype" connections** — when their horses are plunged, they win
  0–9% and finish out of the money 30–65% of the time. Money pours in on the
  *name*; the horse rarely delivers.

**The most parsimonious — and innocent — reading is popularity bias attached to a
person.** A famous jockey or a buzzed-about barn pulls crowd money regardless of
the specific horse's chance; that correlated, uninformed demand overshoots
(finding 1) and clusters on the same connections (this scan). That is *not*
evidence of wrongdoing — it's the favorite-longshot bias wearing a name.

**Hard caveats:** these are stable IDs, not names (resolve before reading
anything into them); over-representation ≠ misconduct; we ran hundreds of
connections, so weaker z-scores invite multiple-testing false positives; and a
high flop rate is exactly what *popular* connections produce honestly. Flag, not
verdict — emphatically.

## Why it happens (mechanics)
The overshoot is a **herding/information-cascade** effect: the odds board is
public and live, so a price dropping pulls in followers who read the move itself
as a signal, amplifying it past fair value. The *source* of the initial money is
mostly uninformed and correlated — sports-paper / 予想家 / SNS tipster touts that
followers act on near post, and "story" money (lucky numbers, name puns,
memorial/anniversary bets, viral picks). Our data fits this: the money is
correlated (clusters on names) and loses (overshoots), which is the signature of
crowd/tip demand, not informed money. Critically, **a win-pool dump on a bad
horse does not profit the dumper — the bet simply loses.** The parties who
actually make money are the *tipster* (selling the pick, on fees, regardless of
result) and the *track* (takeout on the churn). Deliberate, profitable
manipulation would require exotic-pool steering or outright race-fixing — the
former is undercut by our cross-pool coherence finding, the latter is rare in the
tightly-policed JRA and is a matter for its integrity unit, not a data lake.

## Where this could go next
1. **Pattern-of-life** — the real integrity signal: do the *same connections*
   (stable / jockey / owner) recur across flagged races? One race is noise; a
   repeated signature is a pattern. (Connections are already in the feature table.)
2. **Graded / big-field focus** — concentrate on races where money is deep enough
   that flow is meaningful.
3. **Live weekend tracking** — score this weekend's G3s as the odds firm up and
   watch the flow in real time, building a forward calibration set.
