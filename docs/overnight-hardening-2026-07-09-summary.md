# Overnight hardening — 2026-07-09 summary

Device: `mac-dev`. Seven commits on `main` (NOT pushed — David pushes; a push
triggers the CI deploy). Built on top of `781c4df`. Full suite green at HEAD:
Python **377** · root Worker **89** · social Worker **170** · frontend **495** ·
Playwright **23** (all tsc clean; frontend build `index-DSq0e7On.js`).

## Commit ledger

| Commit | Stage | Test delta | Notes |
|--------|-------|-----------|-------|
| `5e83609` | 1 — ticket ownership + UUID ids | social 153→**154**; FE +2 (ticketId) | **Must-land.** Cross-user upsert now 404 (anti-oracle); `kb-`+UUIDv4 ids. |
| `a84e7ef` | 2 — indexes (0009) | — | `(race_key,state,created_at)` + `(state,created_at)`; EXPLAIN-verified. |
| `e4c15c1` | 3 — CI gates | root tsc now green | social worker + root `tsc` + Python (via `requirements-ci.txt`) gate the deploy. Fixed 34 pre-existing root-tsc test-file errors. |
| `23e0db2` | 4 — payload validation + flat cols (0010) | social 154→**167**; new `tickets.test.ts` | Byte cap, type allowlist, line/combo/unit bounds, derived flat columns, CI handle index. |
| `fb1fe3c` | 5 — perf | social 167→**170**; root +1; FE 493→495 | cheer LEFT JOIN, batched friends+form, weekly-latest, rate_limit TTL. |
| `4597321` | 6 — UX guardrails + copy | FE 495; Playwright 2 snapshots updated | Formation cost warning, save-ticket copy, honest failure states. |
| `73ad3d0` | 8 — ADR 0019 | — | Deletion/cascade policy (Proposed, no migration). |

Stage 7 (frontend module splits) — **deferred**, see below.

## Playwright snapshots updated (Stage 6, deliberate)

Only two drifted, both from the intended `placeCta` "Place ticket" → "Save
ticket" copy change (verified via the diff image — exactly the 3 ticket-card
CTAs, nothing else):

- `tests/visual/visual.spec.ts-snapshots/legacy-tickets-en-chromium-darwin.png`
- `tests/visual/visual.spec.ts-snapshots/legacy-tickets-ja-chromium-darwin.png`

Updated with `playwright test --update-snapshots -g "legacy tickets"`. The
other 21 baselines matched exactly (the manual-entry snapshot captures only the
"Build manually" entry button, not the builder's register CTA, so the
`manual.register` rename didn't reach it).

## Decisions David should review

### Security / validation bounds
- **Cross-user upsert → 404, not 403.** Stage 1 returns the same shape as
  "not found" so the endpoint can't be probed for which ids exist. Confirm this
  anti-oracle posture is what you want vs. a distinct 403.
- **Ticket-type allowlist = 6 exotic types** (`quinella/wide/exacta/trio/
  trifecta/bracket_quinella`). The brief listed `win`/`place` too, but they are
  NOT committable in this codebase (confirmed vs `fairvalue.ts` BetType + the
  manual builder). Intentionally omitted so a phantom type can't be stored.
- **Byte cap = 1 MB, line cap = 5000** — NOT the brief's "~16 KB". Reason: box/
  formation tickets store *fully-expanded* priced lines (a full-field trifecta
  formation = 18P3 = 4896 lines ≈ 390 KB); 16 KB would reject legit large
  tickets. 1 MB is an abuse backstop under D1's ~1 MB row ceiling. Reconsider
  if you want formations compacted instead (would let the cap shrink).
- **`ticket_type` CHECK on ADD COLUMN** works in D1's SQLite (existing NULL rows
  pass). The deferred `tickets.state` CHECK is in ADR 0019 (needs a table rebuild).

### Index choices (0009)
- `idx_tickets_race_state_created (race_key, state, created_at DESC)` — leftmost
  `race_key` covers the sweep snapshot pass + friends-on-* lookups. **`state`
  in the middle is not a seek column for any current race_key-scoped query**
  (none filters both) — it's forward-looking and lets this one index substitute
  for a standalone `(race_key)`. Alternative `(race_key, created_at DESC)` is
  marginally smaller. Your call.
- `idx_tickets_state_created (state, created_at DESC)` — the sweep fallback pass
  has no race_key equality (it joins `race_results` + `NOT IN`), so it needs its
  own state-leading index.
- **Handle index swap (0010):** dropped the case-sensitive `idx_users_handle_unique`
  (0003) for `idx_users_handle_ci_unique ON users (lower(handle))`. `upsertUser`'s
  UNIQUE-catch already maps collisions to `handle_taken`; a remote collision would
  fail the migration apply — run the pre-check query in the migration first.

### CI
- **`requirements-ci.txt`** is a minimal subset of `pyproject [project.dependencies]`
  (bounds transcribed from pyproject, not guessed). Validated in a clean venv:
  377 passed. **This is 10 MORE tests than `venv64` runs locally** — `venv64` is
  missing `httpx`, so it silently skips the fastapi TestClient suite
  (`test_api`, `test_form_api`). Consider `pip install httpx` (or
  `fastapi[standard]`) into `venv64` so local runs match CI.
- **The workflow itself only verifies on the first push** (can't run Actions
  locally). The YAML mirrors existing step style; the Clerk-key bundle assertion
  is untouched. Watch the first deploy.

### Copy (Stage 6)
- **CTA verbs renamed for the "recreational, not a wager" framing:** "Place
  ticket"→"Save ticket" (en) / `馬券を登録`→`チケットを保存` (ja); "Register"→"Save
  ticket"/`保存する`. Edit-mode CTA stays "Save". The single not-betting-advice
  disclaimer is unchanged (no per-screen disclaimers added, per the
  consolidation). **Japanese copy wording especially is worth a native review** —
  I shifted 馬券→チケット to de-emphasize the wager term; if the app's voice
  should keep 馬券, revert the noun and keep only the verb →保存.
- **Failure copy:** `mine.saveFailed` ("Couldn't save — the server rejected it.
  Try again.") for HTTP 4xx/5xx (not queued); `mine.offlineQueued` for network
  failures (queued). Wording review welcome.

### ADR 0019 — open questions
Soft-delete users + own tickets; hard-cascade follows/blocks/impressions;
keep+redact cheers/reports; `race_results` untouched. Open Qs in the ADR:
ticket deletion grace window, cheer-authorship rendering, report retention,
handle-tombstone format.

## Stage 7 — DEFERRED (frontend module splits)

The three zero-behavior-change refactors were **not** landed. Rationale:

1. **Lowest priority + zero functional value.** They're pure structural cleanup;
   all the risk/value items (Stages 1–6, 8) landed first and green.
2. **Ship-risk on a deployed app.** "Zero behavior change" is verified only by
   Playwright's ~12 sampled views. The state is tightly intertwined —
   `loadLive → applyRace → selectedRace → regenerate → placeTicket` (App.tsx)
   and 1027 lines of interdependent effects in MyTickets — so a subtle
   effect-deps / closure-timing / re-render regression could slip past the
   sampled views and break at runtime.
3. The prompt's escape hatch ("can't be made green → revert + record + move on")
   covers exactly this, and the rules stress a green, deployable tree.

**Intended boundaries (for a focused review session):**
- `App.tsx` → `useLiveSnapshot` (snap/snapLoading/snapError/refreshSnap/loadLive),
  `useRaceSelection` (selectedRace*/raceLabel/applyRace/seedManual),
  `useTicketRecommendations` (runners/style/impressions/raceId/regenerate/the
  auto-regen effect), `usePlaceTicket`. Coupling: `loadLive` calls `applyRace`;
  `regenerate` reads runners/style/impressions; `placeTicket` reads
  selectedRace/style — hooks must thread these as params/returns.
- `MyTickets.tsx` → committed-tickets, settlement, social-graph, nav/detail,
  report/share hooks.
- `ManualTicketBuilder.tsx` → `useManualDraft` (state + ticket memo + handlers) +
  presentational Picker / ModeToggle / BoxGrid / FormationGrid / Preview.

Recommend doing them in a dedicated session with interactive diff review, full
suite between each, and Playwright as the no-diff authority.

## What David needs to do

1. **Review the decisions above** (especially copy wording, validation bounds,
   index column order, the CI `httpx`/venv64 note).
2. **Push `main`** — triggers CI (now gated on social + root tsc + Python) → deploy.
3. **Remote migrations** (local-only tonight):
   - `0009_ticket_indexes.sql` — additive indexes.
   - `0010_ticket_flat_columns.sql` — run the **handle-collision pre-check** in
     the file first; then apply. Adds flat columns + CHECKs + backfill + swaps
     the handle index.
4. **Stage 7** when ready (boundaries above).
5. **ADR 0019** — accept/amend/reject the cascade policy.

## Housekeeping notes
- Two untracked build artifacts appeared during the session (`tsconfig.tsbuildinfo`
  at root and in `workers/social`, plus `test-results/`). Not committed. Consider
  gitignoring `*.tsbuildinfo` and `test-results/`.
- The preflight command `npx playwright test` in the original brief needs to run
  from `frontend/` (Playwright lives there as `npm run test:visual`); root has no
  Playwright config.
