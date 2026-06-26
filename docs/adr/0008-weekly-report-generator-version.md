# ADR-0008: Weekly report generator versioning (PIT reproducibility)

- **Status:** Accepted
- **Date:** 2026-06-26
- **Surface:** Reference → Weekend roundup (`frontend/src/lib/weeklyReport.ts`)

## Context

The Weekend Roundup stores **raw `WeekendInput`** (the point-in-time input — gates,
odds, conditions, snapshot timestamps) in the D1 `weekly_report` table. The
human-readable report is **regenerated client-side** on every read by the pure
deterministic `generateReport(input)` function.

This is deliberate (it keeps the archive compact and lets the generator evolve
without re-publishing old editions), but it creates a point-in-time hazard:

> A future change to `generateReport` — a reworded `marketShape` label, a new
> contender-group threshold, a different ticket-shape rule — would **retroactively
> alter what an old edition "said"** when a reader opens it today.

A reader comparing the Friday edition to the Saturday edition could no longer
tell whether a wording difference reflects a real data change (new odds, a
scratch) or simply a newer generator. That undercuts the report's value as a
fixed, point-in-time research artifact.

## Decision

1. **The archive is the PIT input of record.** `WeekendInput` rows are
   immutable once published; they capture exactly what was known at
   `published_at`. We do NOT archive rendered reports.

2. **A `GENERATOR_VERSION` constant** (`frontend/src/lib/weeklyReport.ts`,
   currently `"1.0.0"`) is the **reproducibility key**. Every generated
   `WeeklyReport` carries `generator_version: GENERATOR_VERSION`, surfaced in
   the RoundupView freshness block ("Generator version: x.y.z").

3. **Bump rule.** Increment `GENERATOR_VERSION` whenever generated copy
   **semantics** change — new/reworded framing strings, altered contender
   logic, added/removed fields. Mechanical refactors that leave output
   byte-identical do not require a bump. Use semver:
   - **patch** (`1.0.0 → 1.0.1`): fix a typo / grammar in deterministic copy.
   - **minor** (`1.0.0 → 1.1.0`): new analytical field or reworded framing.
   - **major** (`1.0 → 2.0`): structural change to the report shape.

4. **A reader comparing two editions** checks both `version` (the input
   edition — Friday=1, Saturday=2) and `generator_version`. If two editions
   differ but share a `generator_version`, the difference is a real data
   change. If `generator_version` differs, wording deltas may be generator
   drift, not data.

## Consequences

- Reproducibility is preserved: an old edition re-rendered today is honestly
  labelled with the generator that produced it. We do **not** freeze rendered
  bytes (that would block generator improvements); we tag them.
- The version is a client-side stamp only — it is NOT persisted in D1 (the
  table stores the raw input). This avoids a schema migration per generator
  bump; the stamp is derived from the running bundle's constant.
- `weeklyReport.test.ts` asserts the stamp is present and equals the exported
  constant, so a forgotten bump on a copy change is caught by the structure
  test (the constant is the single source of truth).

## Alternatives considered

- **Persist rendered reports (freeze bytes).** Rejected: doubles storage,
  blocks copy improvements, and the generator would still need a version for
  in-flight editions. The stamp gives us honesty without freezing.
- **Store `generator_version` in the D1 row.** Rejected: couples a schema
  migration to every copy bump, and the running bundle already knows its own
  version. The input-of-record model stays clean.
