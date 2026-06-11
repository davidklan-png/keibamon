# ADR-0001: Adopt JRA-VAN as an additive bronze source via a Windows JV-Link worker

- **Status:** Proposed
- **Date:** 2026-06-11
- **Deciders:** David Klan

## Context

Keibamon ingests via Netkeiba polling (odds-centric, incl. the announcement-to-post
odds curve) into the local medallion lake (`data/raw → normalized → features →
marts`; see `docs/data_architecture.md`).

Netkeiba scraping is brittle, legally gray, and cannot supply JRA-VAN's
**proprietary prediction products** (TimeMining predicted times, DataMining
ratings) or the depth of clean official fields that strong models depend on. A
build-in-public peer (note.com/nao_develop_note) demonstrates a mature,
validation-driven simulator built entirely on JRA-VAN — extensive within-race
Z-scored features, pre-declared accuracy metrics, honest result verification —
but with **no odds/market layer**. The two data sources are complementary.

We are entering the feature/pre-ML phase. The **feature ceiling is set by the
data source**, so the substrate must be upgraded *before* feature/ML cost
compounds on the weaker source. JRA-VAN access is **JV-Link**, a Windows-only
32-bit COM component (Data Lab subscription ~¥2,200/mo) — it fits the Windows PC,
not the Mac.

## Decision

1. **Adopt JRA-VAN now, additively** as a new bronze source under
   `data/raw/jravan/`. No rewrite; **keep Netkeiba**. JRA-VAN = fundamentals +
   mining predictions; Netkeiba = live market. Join in silver (`normalized`).
2. **Bronze stores raw records as received** (Shift-JIS text + the seven required
   metadata fields), per `data_architecture.md`, so parsers replay on schema
   change. **Parsing lives in silver** (`src/keibamon_core/adapters/jravan.py`).
3. **Isolate Windows COM at the edge.** A standalone worker (`tools/jravan/`)
   pulls via JV-Link and writes immutable raw snapshots. The importable Mac
   package never imports `win32com`.
4. **USB-C airlock transfer.** PC is the canonical store; new snapshots are
   shipped to a 500 GB USB-C SSD and imported into the Mac lake with sha256
   verification. Full history once; watermark-driven deltas thereafter.

## Consequences

**Positive.** Strictly richer than either Nao's system (no odds) or a scraper (no
mining). Feature/ML built once on authoritative data. Raw-replayable bronze +
checksummed deltas preserve point-in-time integrity and make transfer idempotent.
Mac stack stays COM-free.

**Costs.** JV-Link integration tax (Nao spent ~2 months — the strongest reason to
collaborate). ~¥2,200/mo. Spec fine-print traps (e.g. phantom last-4F field `000`)
→ codify as Pandera rules in silver. Two ingestion paths to operate (decoupled).

**Follow-on (from Nao's playbook).** Within-race Z-score normalization (`_z`,
`clip(-3,+3)`) as the standard feature transform; his feature taxonomy as a
backlog; pre-declared accuracy acceptance metrics in the backtester; a Pandera
"trap registry" seeded with the last-4F gotcha.

## Public UI — keibamon.com (Cloudflare)

`keibamon.com` is registered on Cloudflare and will host the public-facing UI.
**Decision: publish only derived, curated marts — never raw JRA-VAN data.**

- JV-Data carries redistribution restrictions and the lake is local/private, so
  bronze and silver must not leave the local environment.
- The public site serves a **curated marts export** (e.g. weekly simulation picks
  + accuracy scorecards, in the spirit of Nao's note posts) as static
  JSON/Parquet published to Cloudflare Pages (optionally R2/KV for larger sets).
- Add a `marts → public` export step; the React UI in `frontend/` reads that
  published surface. Clean split: **local lake = private full data; published
  marts = public derived, compliant.** This also becomes our build-in-public
  channel on our own domain.

## Alternatives considered
- **Netkeiba only** — cheaper now, but caps model quality, stays brittle, no
  mining, forces a later migration. Rejected.
- **Full migration (drop Netkeiba)** — loses the odds differentiator. Rejected.
- **JV-Link on Mac (Wine/VM)** — fragile COM under emulation. Rejected.
- **Cloud sync instead of USB-C** — JV-Data terms + volume make a physical
  airlock simpler/compliant now. Deferred.
