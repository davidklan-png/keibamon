# CLI agent prompt — resolve jockey/trainer IDs to names + named pattern-of-life

> Goal: give the odds-flow anomaly work real names. The lake keys everything to
> JV-Link jockey_id / trainer_id but holds no name table, and the jravan↔netkeiba
> records don't overlap, so the analysis box can't resolve them. Import the
> JV-Link 騎手マスタ (KS) / 調教師マスタ (CH) master records to silver, then join
> them to the pattern-of-life output. Commit on the Mac; the Cowork verifier
> spot-checks the named result.

```
Read CLAUDE.md (device roles), docs/research/odds-flow-anomaly-scan.md (the
pattern-of-life this names), and tools/jravan/ ingest code. The pattern-of-life
is keyed by jravan jockey_id/trainer_id; it needs id→name.

## STEP 0 — Capture-PC JV-Link pull (verified gaps; JV-Link is PC-only)
Verified against the lake + the spec catalog (蓄積系提供データ一覧.xls): the
masters and several money-microstructure feeds are absent. JV-Link is Windows /
32-bit COM → **capture-pc ONLY** (CLAUDE.md: it does not run on Mac or sandbox).
There is no Mac shortcut — the netkeiba scrape's names use a different id system
with zero overlap to the jravan ids (verified). Fold this into this weekend's
overlap-capture PC session (docs/runbooks/overlap-capture-weekend.md).

On **capture-pc**: `python tools\whichdevice.py` → capture-pc, then JVOpen and
pull this set in one session (request them explicitly — the race ingest never
did). Export the bronze delta to USB → Mac (PC never pushes git). All layouts +
cp932 byte offsets are in reference/jravan/.../JV-Data仕様書 — parse on BYTES not
chars ([[jravan-silver-byte-offset-parsing]]).

**Tier 1 — REQUIRED (this weekend's names task):**
  - `KS` 騎手マスタ, `CH` 調教師マスタ — jockey/trainer id→name. Unblocks the
    named pattern-of-life. Small dictionary records.

**Tier 2 — high-leverage microstructure (pull in the SAME session; capture now):**
  - `UM` 競走馬 / `BN` 馬主 / `BR` 生産者 masters — extend connections to horse
    pedigree, **owner, breeder** (richer syndicate patterns than jockey/trainer).
  - `H1` 票数 — real per-pool **yen vote counts** = true liquidity (turns the
    anomaly detector's *inferred* liquidity into actual turnover).
  - `O1`–`O6` 蓄積 odds — settled odds incl. **exotics (O5 trio / O6 trifecta —
    the biggest, most steerable pool)** for cross-pool divergence depth.
  - `JG` 競走馬除外 — scratches/exclusions = the #1 innocent explanation for a
    false drift flag; lets the detector exclude them.

**Tier 3 — forward-only capture-config (NOT a one-time pull):** the intraday
*curve* for exotics (O3–O6) comes from the realtime feed and **cannot be
backfilled**. Add O3–O6 to the realtime odds capture subscription so exotic
curves accumulate going forward. (Separate from the 蓄積 pull above.)

Then STEP 1+ run on **mac-dev** from the USB import.

## STEP 1 — Silver master tables
Write data/normalized/jockey_master (jockey_id, name, name_kana) and
trainer_master (trainer_id, name, name_kana). Idempotent, content-hashed like
other silver. Note the DATA_TRAP: jockey_id='00000' (and the horse '0000000000'
sibling) is a non-unique placeholder — map it to a literal "(unknown/placeholder)"
label, never a real name. (Tier-2/3 feeds — UM/BN/BR masters, H1 vote counts,
O1–O6 odds, JG scratches — land as bronze this session; parse them to silver as
follow-on work. Only KS/CH are needed for the named pattern-of-life below.)

## STEP 2 — Named pattern-of-life
Re-run / extend the anomaly pattern-of-life (the trainer/jockey flag-rate +
won/flop split over strong plunges) and LEFT JOIN the masters so the output is
named. Keep the volume-normalization, the z-score, and the won-vs-flop split.
Emit a small artifact (parquet or md table) ranking named connections by
plunge-flag z, with their flagged win% / flop%.

## STEP 3 — Keep the framing honest (don't let names become accusations)
Carry the report's caveats into the named output verbatim: over-representation ≠
misconduct; a high flop rate is what *popular* connections produce honestly
(name-money overshoot); multiple-testing; flag, not verdict. The named list is a
"worth-a-look" awareness layer, not a claim about anyone.

## Constraints
- Don't touch the lake PIT rules / recommender / form mart / settlement. Commit
  on the Mac. If a PC pull is needed, stop and tell David the exact JV-Link
  step; don't fake the master.

## Handback to the verifier (Cowork/Claude)
Report: which path (bronze-parse vs PC pull), jockey_master / trainer_master row
counts, and the top ~10 NAMED pattern-of-life connections with their stats. The
verifier will spot-check resolution against a known id (e.g. the jockey_id that
appears most on graded-race winners should resolve to a marquee rider like
武豊/Ｃルメール) and confirm the placeholder id is labelled, not named. Mark
"ready for verification", not "done".
```
