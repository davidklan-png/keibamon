# Codebase review — 2026-07-08

Full health check of the Keibamon repo (architecture, quality, tests, risk),
reviewed from the cowork sandbox on `main` @ `68f8771`. Focus: the big
decisions and their future impact.

## Snapshot

| Area | Size | Tests | Status |
|---|---|---|---|
| Python lake/pipeline (`src`, `tools`) | ~26.5k LOC | 345 passed, 4 skipped | Green |
| Frontend (`frontend/src`) | ~22.5k LOC | 468 passed (46 files) + Playwright visual | Green |
| Social Worker (`workers/social`) | ~8k LOC | 153 passed | Green |
| Racing Worker root suite | (in `src/form`, `src/reference`) | 88 tests, Mac/CI only | Green in CI |
| Data lake (`./data`, gitignored) | 5.2 GB (3.0 raw / 1.9 normalized) | — | — |

Sandbox note: the initial pytest "failures" and root-suite failures here were
environmental (missing `pyarrow`; darwin-built `better-sqlite3`/rollup
natives). With deps installed everything runnable in the sandbox passes. The
root Worker suite is correctly gated in CI (`deploy.yml`) as
`docs/device-topology.md` prescribes.

**What's in good shape:** 18 ADRs with honest supersession notes; device
topology with enforced guards (`whichdevice`, ACP=932 assert); point-in-time
discipline embedded in code and tests (`features/point_in_time.py`,
`DATA_TRAPS` referenced at every trap site); the ADR-0004 cross-validation
gate built and passing its first real overlap (2026-07-04/05, 0.0000%
mismatch); a deploy pipeline with a single source of truth and serialized
deploys; only 3 TODO/FIXME markers across ~27k lines of Python. This is a
disciplined codebase for a solo project.

## The big items, ranked by future impact

### 1. No lake backup strategy — and ADR-0004 makes it worse (P1)

Nothing in `docs/` or the runbooks describes backing up the 5.2 GB lake. Today
the PC-era topology gives you accidental redundancy: bronze exists on the PC,
the USB, and the Mac. ADR-0004 deliberately removes all of that — one Mac, one
disk, holding the source-of-truth lake including intraday odds curves that
**cannot be backfilled** (the JV-Link 1-year time-series safety net dies with
the PC). After cutover, a dead Mac SSD is an unrecoverable data loss event,
not an inconvenience.

**Impact if unaddressed:** the whole odds-curve hypothesis (your one live
signal) depends on accumulated PIT snapshots. Losing them resets the research
clock by months.

**Decision needed:** pick a backup mechanism (restic/rsync to external disk +
one off-site copy, e.g. R2 or Backblaze — the lake is already parquet and
compresses well) and add it to the cutover checklist in
`docs/runbooks/overlap-capture-weekend.md` — it is the one major cutover risk
that checklist currently misses.

### 2. "Loud monitoring on scrape failure is mandatory" — not implemented (P1)

ADR-0004 declares loud monitoring mandatory, and the cutover runbook already
lists it as an unchecked power-off criterion. No implementation exists — no
alerting anywhere in `src/` or `tools/` — no ntfy/pushover/webhook/email, no heartbeat, no
stale-feed watchdog. The poller has back-off logic but nothing that tells a
human it has been failing for an hour. The same gap cost you the June 14
afternoon curves (lid-close incident was only discovered after the fact).

**Impact if unaddressed:** post-cutover, netkeiba changing a page format on a
Saturday morning silently kills capture and settlement for the whole card.

**Decision needed:** a dead-simple push alert (e.g. ntfy.sh to the phone) on
N consecutive fetch/parse failures **and** on snapshot staleness (no lake
write in X minutes during a race window). Small effort, disproportionate risk
reduction. Also a **cutover prerequisite**.

### 3. Hold the line on the PC cutover sequencing (P1, on track)

ADR-0004's gate has passed **one** clean weekend (2026-07-04/05). The runbook
requires 2–3 consecutive PASSes and the ADR itself calls one weekend
necessary-not-sufficient. Nothing to change — just don't let a good first
result compress the schedule. The runbook's criteria (≥2–3 consecutive
PASS weekends, lid-discipline proof, monitoring live) are sound — amend it to
add backup (#1) and then treat power-off as a checklist event, not a judgment
call.

### 4. ~~Add the `source` provenance column~~ — CORRECTION: already implemented (closed)

**Correction (2026-07-08, post-review):** this finding was wrong. The
provenance discriminator ADR-0004 recommends already exists as `source_name` —
scrape rows carry `source_name='netkeiba'` (it is part of every scrape
adapter's natural key) and JV-Link silver rows carry
`source_name='jravan'`/`'jravan_rt'`. Post-cutover data is splittable by
source at query level today. The ADR's naming-debt paragraph has been
annotated as implemented. No action needed.

### 5. The two monoliths will tax the S2–S5 UX rebuild (P2)

`workers/social/src/index.ts` is 1,769 lines (routing + auth + tickets +
impressions + settle sweep + results archive in one file) and
`frontend/src/screens/MyTickets.tsx` is 2,044 lines. Both sit exactly where
the remaining UX sessions (S2–S5) and the account-backed features (ADR-0018)
will land. The frontend is now your largest codebase and growing fastest.

**Impact if unaddressed:** each CLI-agent session pays an increasing
comprehension tax on these files, review diffs get noisier, and regressions
get likelier precisely where user-visible money features (tickets, settle)
live.

**Decision needed:** a mechanical module split (no behavior change) before or
early in S2 — e.g. social Worker into `routes/`, `settle.ts`, `impressions.ts`;
MyTickets into feed/builder/edit components. One dedicated session; the strong
test coverage (153 + 468 tests) makes this low-risk now and expensive later.

### 6. The lake pipeline has no CI (P3)

`deploy.yml` gates the edge (Worker + frontend) but the 345-test Python suite
runs only when someone remembers to run it on the Mac. The capture-PC
divergent-branch scenario in CLAUDE.md (guards bypassed off-`main`) is the
same class of problem: correctness depends on local discipline.

**Decision needed:** a second GitHub Actions workflow running
`pytest` on push. ~20 lines of YAML; makes "keep the suite green" enforced
rather than aspirational.

### 7. Housekeeping (P3)

`weekend_2026_w26_v3.insert.sql` is a one-off artifact tracked at repo root —
move under `docs/` or an `artifacts/` convention, or delete. `app_plan.md`
(June 17) predates the ADR-0005+ simplification and the NetKeiba rebuild;
mark superseded or delete. `backend/keibamon_api` survives as the Python
parity oracle for the TS form routes — that's deliberate, but a one-line
README note there would stop a future cleanup pass from deleting it. The
Cloudflare `.env` at repo root is correctly gitignored; consider scoping
`CF_API_TOKEN` minimally if it isn't already.

## Decisions and outcomes (David, 2026-07-08)

1. Lake backup — **approved as weekly USB KEIBA backup**. Implemented:
   `make lake-backup` + `docs/runbooks/lake-backup.md`; added to the cutover
   checklist.
2. Scrape alerting — **approved**. Implemented: `src/keibamon_core/alerting.py`
   (ntfy via `KEIBAMON_NTFY_TOPIC`; consecutive-failure + staleness watchdogs)
   wired into `weekend.pipeline.track`; 12 new tests.
3. Cutover sequencing — **hold the line confirmed**; checklist amended.
4. `source` column — closed (already existed as `source_name`; see correction
   above).
5. Monolith split — **implemented now**. Social Worker split into
   core/auth/tickets/social/impressions/routes (index.ts 1,769 → 57 lines);
   MyTickets split into a state-owning container (2,044 → 1,016 lines) +
   7 view components under `screens/mytickets/` reading via an explicit
   `MtCtx`. All suites green in sandbox (357 py / 468 fe / 153 worker; tsc
   clean). **Mac verification still required**: root `npm test`, `vite build`,
   and the Playwright visual baselines (the split is behavior-preserving, but
   the visual suite is the authority).
6. Python CI — **skipped** by decision.
7. Housekeeping — **approved**. Done: stray SQL → `docs/archive/`,
   `app_plan.md` marked superseded, `backend/README.md` parity-oracle note.
