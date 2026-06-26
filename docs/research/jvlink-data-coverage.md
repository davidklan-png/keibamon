# JV-Link data coverage — pulled vs. to-be-pulled

What JV-Link has actually ingested into the lake (measured from **silver**, the
processed layer — the local `data/raw` bronze is only the last few June deltas),
mapped against JRA-VAN's accumulated-data spec catalog
(`蓄積系提供データ一覧.xls`). All pulls/parses are capture-PC → USB → Mac; the
Mac and sandbox can't run JV-Link.

## Pulled and processed (in the lake today)
| Domain | Spec | Rows | Coverage |
|---|---|---|---|
| Race detail | RA | 39,288 | **1954 → 2026-06-14** |
| Entries (per-horse) | SE | 461,926 | 1954 → 2026-06-19 |
| Results | SE/成績 | 461,892 | 1954 → 2026-06-14 |
| Payouts | HR | 221,107 | 1986 → 2026-06-14 |
| Settled odds (win/place) | O1 | 269,934 | (full history) |
| **Intraday odds curve** | O1/O2 realtime | **83,057,558** | **2025-06-20 → 2026-06-14 (1 yr only)** |
| Data mining (predictions) | DM/TM | 1,473,273 | 2001 → 2026-06-07 |
| Training (坂路/woodchip) | HC/WC | 12,557,543 | 2003 → 2026-06-13 |
| Weather/going, body weight | in RA/SE | — | present within race + entry rows |
| Netkeiba odds (backup) | — | 8,877 | 2026-06-13 → 06-19 |

**Odds-curve pools captured:** win, place, quinella (馬連), bracket-quinella
(枠連) — that's it. The race/result spine runs back to **1954**; the intraday
*curve* is realtime-only and just **one year deep**, and (per our own rule) it
**cannot be backfilled** — depth only grows going forward.

## To-be-pulled (absent from the lake), ranked by relevance to current work

**1. Masters — KS (jockey), CH (trainer), UM (horse), BN (owner), BR (breeder).**
None are in the lake — this is why the pattern-of-life is ID-only. KS + CH
directly unlock the names task. UM/BN/BR would extend "connections" to
horse pedigree, **owner, and breeder** — richer syndicate/connection patterns for
the forensics work than jockey/trainer alone. *Small dictionary records; this is
the immediate pull.*

**2. H1 — 票数 (vote counts / true pool sizes, all bet types).** Not captured. This
is the actual **yen volume** in each pool. The anomaly detector currently *infers*
liquidity from odds; H1 gives real turnover, which is the difference between "big
move on a thin pool" (a real flag) and "big move on a deep pool" (normal). High
value-add for manipulation detection.

**3. Exotic odds O3/O4/O5/O6 — wide / exacta / trio / trifecta.**
*(Corrected — these are NOT a pull gap.)* O3–O6 are already captured in **bronze**
(realtime 0B30; verified in `jravan_rt`). They're missing from the silver curve
only because `ingestion/jravan_silver.py` filters the timeseries to `("O1","O2")`
on purpose, for cardinality (O6 trifecta ≈ 4,900 combos/race). So the **trifecta
(3連単) — the largest, most steerable pool** — is *recoverable downstream by
un-filtering existing bronze*, not by pulling. Worth doing for cross-pool depth,
but gate the scope first (full curve vs T-30-only vs a liquidity floor).

**4. JG — 競走馬除外 (scratches / exclusions).** Not separately captured. Scratches
reshape the pool and are the #1 *innocent* explanation for an apparent drift flag
— having them lets the detector exclude/explain false positives.

**5. TOKU — 特別登録馬 (special registrations).** The pre-entry 登録馬 list, available
*before* Thursday's numbered shutuba. This is the "see the field earlier in the
week" data behind the registered-races feature.

**6. WF — 重勝式 (WIN5).** Niche; low priority.

## Bottom line
The **history spine is deep and complete** (races/entries/results to 1954,
payouts to 1986, mining to 2001, training to 2003). The gaps are concentrated in
two places that happen to be exactly where the current work is headed: the
**name/connection masters** (KS/CH/UM/BN/BR) and the **money-microstructure feeds**
(H1 vote counts, O5/O6 exotic curves, JG scratches). For this weekend's PC
session, the cheap, high-leverage adds are **KS + CH** (names, this weekend's
task) and, if you want to deepen the forensics, **H1 + O5/O6** going forward.
