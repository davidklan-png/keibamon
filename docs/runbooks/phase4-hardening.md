# Phase 4 — Hardening (settle sweep, dead-heat/scratch correctness, block/report, self-host fonts, HTML snapshots)

Builds on Phase 1 (Clerk identity + `keibamon_social` D1 + `users` table),
Phase 2 (per-user ticket persistence + auto-settle), and Phase 3 (follows,
cheers, profiles, feed, share). Phase 4 closes reliability, correctness,
and privacy/safety gaps. **No new product surface.**

Scope cuts decided up front (see ADR-0007 Phase 4 backlog):

- **Rate limits**: Phase 3's D1 minute-bucket counter stays. Coverage extended
  to `block`/`report`; no KV token bucket.
- **Visual regression**: HTML-string snapshots only. CSS-pixel drift deferred
  to Playwright in Phase 5.
- **Server-side card renderer**: deferred. Client-side `html-to-image` works;
  no cross-platform bug reports yet.

The racing tier (racing D1, `/api/live`, the asset Worker, `tools/jravan`,
`ingestion/`, `src/keibamon_core`) is **not modified**.

## What lives where

| Concern | Where |
|---------|-------|
| Settle resolver (canonical) | `workers/social/src/settle.ts` — extracted from `frontend/src/lib/settle.ts`; frontend re-exports via shim |
| Dead-heat + scratch semantics | `workers/social/src/settle.ts` — `placings?:{pos,umabans[]}[]`, `scratched?:number[]`, new `state:"refunded"` variant |
| Cron settle sweep | `workers/social/src/sweep.ts` — every 5 min UTC; fetches `${LIVE_BASE}/api/live` |
| Cron trigger | `workers/social/wrangler.jsonc` — `triggers.crons = ["*/5 * * * *"]` |
| Scheduled handler | `workers/social/src/index.ts` — `default export { fetch, scheduled }` |
| Block/report schema | `workers/social/migrations/0004_blocks_reports.sql` — `blocks` + `reports` |
| Block/report routes | `workers/social/src/index.ts` — `POST/DELETE /api/social/block/:userId`, `POST /api/social/report`; `RATE_LIMITS` extended (`block:30/min`, `report:10/min`) |
| Feed/profile filter | `workers/social/src/index.ts` — `buildFeed` / `buildProfile` gain `NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=t.user_id)` |
| Follow/cheer guards | `workers/social/src/index.ts` — `blockExistsEitherDirection` 403s follow/cheer between any blocked pair |
| Frontend wiring | `frontend/src/auth/socialClient.ts` — `block`, `unblock`, `report`; `frontend/src/App.tsx` — Block/Report buttons + report modal |
| Self-hosted fonts | `frontend/public/fonts/*.woff2` (7 files, ~460 KB uncompressed) + `frontend/src/styles.css` (7 `@font-face` rules replace `@import`) |
| Visual regression | `frontend/src/app.snapshot.test.tsx` + `frontend/src/__snapshots__/{SignInScreen,AgeGate}.{ja,en}.html` |
| Racing tier | UNCHANGED |

## Architecture decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | **Settle resolver's canonical home is the Worker; frontend re-exports** | Worker owns the settle sweep (server-side authority). Vite + tsc both resolve the cross-dir relative import; no fork. Frontend's richer `Ticket` is structurally compatible with the minimal resolver input. |
| 2 | **Dead-heat via `placings?:{pos,umabans[]}[]`; resolver enumerates orderings** | Today's `finishers: number[]` cannot express 同着 (two horses at pos=2). Placings-as-sets is the JRA semantics; `expandPlacings` yields the cartesian product across tied positions and a line hits if it matches ANY. |
| 3 | **Scratch via `scratched?:number[]`; refunded variant** | JRA refunds all lines containing a scratched horse (返 Fairness/返還). Today a scratch silently mis-settles as MISS. New `{state:"refunded", reason:"scratched"}` surfaces the refund path without polluting `won`/`miss`. |
| 4 | **Cron Trigger every 5 min UTC** | Client auto-settle (45s `/api/live` poll) is the fast path; sweep is the offline-backstop. 5 min is plenty. CF Cron Triggers are the lightest mechanism — no DO, no Queue. |
| 5 | **Sweep → `/api/live` via `LIVE_BASE` secret + `fetch()`** | Worker has no service binding to the racing Worker today; adding one would require editing root `wrangler.jsonc` (forbidden). A secret is in-bounds — only the social Worker is touched. |
| 6 | **Rate limits: extend D1 coverage, skip KV** | D1 minute-bucket counter works; user opted to defer the KV token bucket. Phase 4 backlog item stays open. |
| 7 | **Asymmetric one-way block (Twitter model)** | `INSERT` = blocked; `DELETE` = unblock. Block severs existing follows in both directions and prevents future follow/cheer either direction. Feed filter is one-way (only hides B from A's feed); B can still see A's tickets. |
| 8 | **Reports are write-only** | `reports(reporter_id, target_type, target_id, reason, created_at)`. No moderation review UI — store for later. Surfacing a queue is out of scope. |
| 9 | **Self-host fonts as woff2 subsets** | Removes the only runtime third-party request. ~7 files, ~460 KB uncompressed, ~140 KB after brotli. Subsetting to ~660 codepoints (ASCII + hiragana + katakana + app kanji + half-width kana) keeps each weight small. OFL 1.1 license bundled. |
| 10 | **Server-side card renderer: DEFER** | Client `html-to-image` works; no data justifying the work. Decision recorded here + in ADR Phase 4 backlog. |
| 11 | **Visual regression via HTML-string snapshots, not Playwright** | Cheaper than Playwright; catches DOM + i18n regressions; existing `i18n.test.tsx` pattern. CSS-pixel drift deferred (acknowledged gap). Scope reduced to 4 baselines (auth surface) because the 8 legacy screens live inside App.tsx as inline functions — pulling them out is a Phase 5 refactor. |

## Schema (`0004_blocks_reports.sql`)

```sql
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id TEXT NOT NULL REFERENCES users(id),
  blocked_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id),
  CHECK (blocker_id <> blocked_id)
);
CREATE INDEX idx_blocks_blocker ON blocks (blocker_id);
CREATE INDEX idx_blocks_blocked ON blocks (blocked_id);

CREATE TABLE IF NOT EXISTS reports (
  id          TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('ticket','user')),
  target_id   TEXT NOT NULL,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_reports_target ON reports (target_type, target_id);
```

## API

### Block (Clerk JWT required)

| Method | Path | Body | Returns | Rules |
|--------|------|------|---------|-------|
| POST | `/api/social/block/:userId` | — | `{ok:true}` | idempotent `INSERT DO NOTHING`; severs existing follows both directions; self-block → 403 `cannot_block_self`; rate-limited (30/min) |
| DELETE | `/api/social/block/:userId` | — | `{ok:true}` | idempotent `DELETE`; rate-limited (30/min) |

### Report (Clerk JWT required)

| Method | Path | Body | Returns | Rules |
|--------|------|------|---------|-------|
| POST | `/api/social/report` | `{target_type:"ticket"\|"user", target_id, reason}` | `{ok:true}` | reason ≤ 500 chars; rate-limited (10/min) |

### Cron settle sweep

- **Trigger:** `*/5 * * * *` (every 5 min UTC).
- **Authority:** `workers/social/src/sweep.ts:settleSweep(env)`.
- **Flow:** fetch `${LIVE_BASE}/api/live` → SELECT open tickets (cap 200) →
  match by `race_key` → `resolveTicket()` → idempotent
  `UPDATE tickets SET state=?, returned=? WHERE id=? AND state='open'`.
- **Idempotent:** already-settled tickets are filtered out by the SELECT's
  `state='open'` predicate; concurrent sweeps / client PATCHes are safe.
- **Bounded:** cap 200 per run; overflow logged as `deferred=true`.

### Rate-limit thresholds

Per-user, per-minute, D1-backed (Phase 3 mechanism extended):

| Action | Limit | HTTP on exceed |
|--------|-------|----------------|
| `follow` / `unfollow` | 30 / min | 429 `{error:"rate_limited"}` + `Retry-After: 60` |
| `cheer` / `uncheer` | 60 / min | 429 |
| `ticket` (POST) | 20 / min | 429 |
| `block` / `unblock` | 30 / min | 429 |
| `report` | 10 / min | 429 |

## Block semantics

- **Asymmetric, one-way.** A blocking B does not block B from blocking A.
- **Severs follows both directions.** Block removes any existing
  A→B and B→A follow edges.
- **Prevents future follow/cheer either direction.** `followUser` and
  `addCheer` both check `blockExistsEitherDirection` and return
  403 `{error:"blocked"}` if any block row exists between the pair.
- **Feed filter is one-way (Twitter-style).** A's feed no longer shows B's
  tickets; B can still see A's tickets. The filter clause is
  `AND NOT EXISTS (SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=t.user_id)`
  with the viewer's id bound — viewer's blocks, viewer's feed.

## Self-hosted fonts

The runtime `@import` of `fonts.googleapis.com` is replaced with 7 self-hosted
woff2 files served at `/app/fonts/*.woff2` by the racing Worker's existing
assets binding:

| File | Family | Weight |
|------|--------|--------|
| `mplus-rounded-1c-{400,500,700,800,900}.woff2` | M PLUS Rounded 1c | 5 weights |
| `space-mono-{400,700}.woff2` | Space Mono | 2 weights |

Subset to ~660 codepoints (ASCII + hiragana + katakana + app kanji +
half-width kana). Source TTFs from the `google/fonts` GitHub repo (Apache 2.0);
converted + subsetted with `pyftsubset`. OFL 1.1 license bundled at
`frontend/public/fonts/LICENSE.txt`.

`styles.css` line 3's `@import url("https://fonts.googleapis.com/...")` is
replaced with 7 `@font-face` rules. Build emits expected "didn't resolve at
build time" warnings for `/app/fonts/*` — they're runtime paths served by
the racing Worker, not build-time assets.

## Visual regression — HTML-string snapshots

`frontend/src/app.snapshot.test.tsx` renders the auth surface
(`SignInScreen` + `AgeGate`) via `renderToStaticMarkup` and asserts each
against a file snapshot under `frontend/src/__snapshots__/`. 4 baselines:

| File | Screen | Lang |
|------|--------|------|
| `SignInScreen.ja.html` | Sign-in shell | JA |
| `SignInScreen.en.html` | Sign-in shell | EN |
| `AgeGate.ja.html` | Age self-attestation | JA |
| `AgeGate.en.html` | Age self-attestation | EN |

Mock: `vi.mock("@clerk/clerk-react", ...)` returns the signed-out hook
shapes, so AuthProvider renders the NOOP_VALUE branch — the
unauthenticated shell we want to snapshot. Without the mock vitest inherits
the repo `.env`'s `VITE_CLERK_PUBLISHABLE_KEY` → CLERK_ENABLED is true →
ClerkAuthInner throws "useUser can only be used within `<ClerkProvider/>`".

**Update policy:** when an intentional change lands, run
`npm test -- src/app.snapshot.test.tsx -- -u` and commit the new baselines
alongside the change.

**Scope gap:** the original plan enumerated 8 screens × 2 langs = 16
baselines. App.tsx renders those screens as inline functions inside a 2.7k-line
component with ~10 useEffect hooks + fetch-on-mount — pulling them out for
snapshot tests would be a refactor outside Phase 4 scope. Phase 5 backlog:
CSS-pixel regression via Playwright covers both the remaining screens and
CSS drift.

## Setup — run these yourself

### 1. Apply the migration

The `keibamon_social` D1 already exists from Phase 1. Apply migration 0004
locally and remotely:

```bash
cd workers/social

npx wrangler d1 execute keibamon_social --local \
  --file migrations/0004_blocks_reports.sql --yes

npx wrangler d1 execute keibamon_social --remote \
  --file migrations/0004_blocks_reports.sql --yes
```

Verify both:

```bash
npx wrangler d1 execute keibamon_social --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
# Expect: users, tickets, follows, cheers, rate_limits, blocks, reports
```

### 2. New secret: `LIVE_BASE`

The sweep calls `${LIVE_BASE}/api/live`. Set on the social Worker:

```bash
cd workers/social
npx wrangler secret put LIVE_BASE
# paste the racing Worker URL, no trailing slash:
#   https://keibamon.kinokoholic1.workers.dev
# or, once the custom domain is wired:
#   https://keibamon.com
```

If `LIVE_BASE` is missing, the sweep logs a warning and no-ops. Tickets
still settle via the client `/api/live` poll path; the sweep is only the
offline-backstop.

### 3. Deploy (picks up the cron trigger)

```bash
cd workers/social
npx wrangler deploy

cd ../..
npm --prefix frontend run build
# Racing Worker re-serves the new bundle; social Worker is independent.
```

### 4. Verify

```bash
# Worker tests — settle + sweep + social suites
cd workers/social && npm test

# Frontend tests — includes new snapshot tests
cd ../../frontend && npm test

# Racing tier unchanged
cd .. && PYTHONPATH=src ./venv64/bin/python -m pytest -q

# Build + fonts
cd frontend && npm run build

# Scope gate
cd .. && git diff main...HEAD --stat
# Expect: only frontend/, workers/social/, docs/
```

Manual end-to-end (post-deploy):

1. **Sweep backstop.** Account A commits a ticket on a result-available
   race. Close A's browser. Within 5 min the sweep settles the ticket; on
   A's next reconnect it shows the settled state.
2. **Block flow.** A signs in, opens B's profile, taps Block. B's tickets
   disappear from A's feed. B cannot follow or cheer A (403). A's existing
   follow of B is severed. A can still see B's profile (one-way block).
3. **Report flow.** A taps Report on an offending ticket, enters a reason,
   submits. Worker stores the row (verify via D1 query:
   `SELECT * FROM reports ORDER BY created_at DESC LIMIT 5;`).
4. **Fonts.** Devtools Network after loading `https://keibamon.com/app/`:
   zero requests to `fonts.googleapis.com`. Fonts load from
   `/app/fonts/*.woff2`.
5. **Snapshots.** `npm test -- src/app.snapshot.test.tsx` passes on CI.

## Rollback

Phase 4 is opt-in via the new tables + the social Worker. To disable:

1. Roll back the Worker deploy:
   ```bash
   cd workers/social
   npx wrangler deployments list
   npx wrangler deployments rollback
   ```
2. Remove the cron trigger by deploying an earlier Worker version (the
   rollback above handles this automatically).
3. The frontend degrades gracefully — block/report buttons return errors
   that surface as toasts; tickets continue to settle via the client path.
4. To drop the new tables:
   ```bash
   npx wrangler d1 execute keibamon_social --remote \
     --command "DROP TABLE IF EXISTS reports; DROP TABLE IF EXISTS blocks;"
   ```

To revert fonts: restore `frontend/src/styles.css`'s top `@import` and
delete `frontend/public/fonts/`. Build re-bundles with the runtime Google
Fonts request — no racing-tier impact.

## Common gotchas

- **Forgot `LIVE_BASE`.** The sweep logs `settleSweep: LIVE_BASE not set;
  sweep is a no-op` and skips. Tickets still settle via the client poll,
  but the offline-backstop path is dead until the secret is set. Verify
  with `npx wrangler secret list`.
- **Cron schedule is UTC.** `*/5 * * * *` fires at 12:00, 12:05, 12:10 UTC
  — not local time. For race-day afternoons in JST this means sweeps run
  every 5 min throughout the card.
- **Fonts need cache busting on update.** The racing Worker serves
  `/app/fonts/*.woff2` with cache headers. After replacing files, users
  may see stale fonts until TTL expires or they hard-reload.
- **Block doesn't delete old cheers.** Block severs follows but does NOT
  remove existing cheers on past tickets. The cheer count stays. Future
  cheers are blocked (403). This is intentional — past celebration is
  historical fact; block prevents future interaction.
- **`toMatchFileSnapshot` is async.** Vitest 3 will fail un-awaited
  snapshot assertions. The test awaits `expect(html).toMatchFileSnapshot(...)`.
  Copy this pattern when adding new baselines.
- **CLERK_ENABLED in tests.** Vitest inherits the repo `.env`, so
  `CLERK_ENABLED` is true in tests. The snapshot test mocks
  `@clerk/clerk-react` to return signed-out hook shapes; without the mock,
  ClerkAuthInner throws under `renderToStaticMarkup`.
- **Racing tier drift.** Do NOT edit `wrangler.jsonc` (root), `src/worker.js`,
  `/api/live`, `tools/jravan/`, `ingestion/`, or `src/keibamon_core/` from
  this branch. `git diff main...HEAD --stat` should show only `frontend/`,
  `workers/social/`, `docs/`.

## Decisions deferred

- **Server-side card renderer.** Client `html-to-image` works; no
  cross-platform bug reports justifying the work. Phase 5 backlog.
- **KV token bucket rate limits.** Phase 3's D1 minute-bucket is sufficient
  for current volume. Phase 5 backlog.
- **CSS-pixel visual regression.** Phase 4 used HTML-string snapshots only.
  Playwright + visual comparisons deferred. Phase 5 backlog.
- **Moderation review queue UI.** Phase 4 stores reports in D1 but doesn't
  surface them for staff review. Phase 5 backlog.

## Phase 5 backlog (NOT done in Phase 4)

- **KV token bucket** for rate limits (Phase 4 backlog item #1 — partially
  closed: extended D1 coverage to block/report, deferred KV).
- **Server-side card renderer** for share image (Phase 4 backlog item #4 —
  deferred, no data justifying the work).
- **CSS-pixel visual regression** with Playwright (Phase 4 used HTML-string
  snapshots; covers DOM regressions but not pixel drift, and only the auth
  surface — the 8 legacy screens need extraction from App.tsx first).
- **Moderation review queue UI** (Phase 4 stores reports but doesn't surface
  them for review).
- **Drive `/api/live` to emit result** (Phase 2 follow-up #1 — racing-tier
  dependency; the sweep has nothing to settle against without this).
