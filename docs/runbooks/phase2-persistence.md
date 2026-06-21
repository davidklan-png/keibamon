# Phase 2 — Per-user ticket persistence + auto-settle

Builds on Phase 1 (Clerk identity + `keibamon_social` D1 + `users` table).
Phase 2 moves committed tickets off `localStorage` into the existing
social D1 — keyed by Clerk user id — and resolves win/miss when a ticket's
race reaches `status:'result'`, driven by the existing `/api/live` poll.

The racing tier (racing D1, `/api/live`, the asset Worker, `tools/jravan`,
`ingestion/`, `src/keibamon_core`) is **not modified**.

## What lives where

| Concern | Where |
|---------|-------|
| Tickets schema | `workers/social/migrations/0002_tickets.sql` |
| Worker routes (new) | `workers/social/src/index.ts` — `POST/GET /api/social/tickets`, `PATCH /api/social/tickets/:id` |
| Frontend persistence | `frontend/src/auth/socialClient.ts`, `frontend/src/auth/ticketQueue.ts`, `frontend/src/App.tsx` (`MyTickets`) |
| Settlement resolver | `frontend/src/lib/settle.ts` |
| Racing tier | UNCHANGED |

## Schema (`0002_tickets.sql`)

```sql
CREATE TABLE tickets (
  id           TEXT PRIMARY KEY,        -- CommittedTicket.id ("kb-…")
  user_id      TEXT NOT NULL REFERENCES users(id),
  serial       TEXT NOT NULL,
  race_key     TEXT NOT NULL,           -- date|venue|race_no|name
  payload      TEXT NOT NULL,           -- verbatim CommittedTicket JSON
  state        TEXT NOT NULL,           -- open | won | miss
  payout_base  INTEGER NOT NULL,
  returned     INTEGER,                 -- NULL until settled
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_tickets_user_created ON tickets (user_id, created_at DESC);
```

`payload` is the recommender's full `CommittedTicket` (ticket + `RaceSnapshot`
+ mood + unit + claps). The flat columns (`state`, `returned`, `race_key`,
`payout_base`) are the resolver / query surface — kept denormalized so a
future server-side settle sweep doesn't have to parse JSON to find OPEN
rows for a given race.

## API (all Clerk-authenticated; 401 without a valid JWT)

| Method | Path | Body | Returns |
|--------|------|------|---------|
| POST | `/api/social/tickets` | full `CommittedTicket` | the inserted row (with `state`, `returned` overlaid from the columns) |
| GET | `/api/social/tickets` | — | `{ tickets: CommittedTicket[] }`, newest first |
| PATCH | `/api/social/tickets/:id` | `{ state?, returned?, claps? }` | the patched row |

Ownership is enforced on every write:

- INSERT fixes `user_id` from the JWT; it cannot be changed.
- PATCH looks the row up by `id`; if its `user_id` ≠ the caller, HTTP 403.
- Unknown `id` → HTTP 404.
- `state` outside `{open, won, miss}` is silently ignored (the column stays
  unchanged) so a buggy client can't corrupt the row.

## Settlement rules (`frontend/src/lib/settle.ts`)

For each of the user's OPEN tickets, the `/api/live` poll effect (45s)
matches the ticket's `race.raceKey` against a race in the snapshot. When
that race's `status === 'result'`, the resolver runs:

| Bet type | Hit condition |
|----------|---------------|
| `quinella` | the line's 2 horses match the top-2 finishers as a **set** |
| `wide`     | both horses in the line finish in the top 3 |
| `exacta`   | the line's 2 horses match the top-2 finishers **in order** |
| `trio`     | the line's 3 horses match the top-3 finishers as a **set** |
| `trifecta` | the line's 3 horses match the top-3 finishers **in order** |

For each winning line:

- If `result.payouts` carries the matching `{pool, combo, yen}` row,
  `returned += yen * unit/100` (JRA convention: payouts are per 100-yen stake).
- Otherwise the commit-time `avgPayout` is used and the figure is tagged
  `source:'estimate'` so the UI can mark it provisional.

The combo key matches `netkeiba_payouts.py`: dash-separated umabans,
canonicalized **ascending for unordered types** (so `"16-5"` matches our
`"5-16"`) and **preserved in order for exacta/trifecta**.

The resolver is **idempotent** and **pure** — it does not mutate the input
ticket. The auto-settle effect in `App.tsx` is what calls PATCH.

### Payout-source gap (2026-06-21)

**Today's `/api/live` producer (`tools/jravan/expose_live.py`) does NOT
populate `LiveRace.result`.** `snapshot.py:87` passes `raw.get('result')`
through unchanged and no upstream emits it. The historical splash page
implied the shape `{ top3: [{pos, umaban}], payouts: [{pool, combo, yen}] }`,
but no current builder emits it.

Consequence: in production today, **every "result" race has an empty result
block**. The resolver returns `{state:'open', reason:'no_finishers_yet'}`
and the ticket stays open — the UI shows the commit-time estimate
(`payoutBase`). No false settlement, no fabricated payout.

When a future change to `expose_live.py` (out of Phase 2 scope — that file
is owned by capture-pc and the racing tier boundary) starts emitting
finishing order + payouts, this resolver resolves them with **no UI
change** — same contract, same shape. Tracked as a Phase 2 follow-up.

## Offline queue (`ticketQueue.ts`)

- Commits are optimistic: the UI + cache update immediately, then the POST
  fires next tick.
- If the POST fails (network, 5xx), the CommittedTicket is appended to
  `kbm.pending.<userId>` in localStorage.
- On the next signed-in load, the queue is flushed BEFORE the GET, so the
  freshly-loaded feed already reflects the recovered commit.
- Queue caps at 50 entries (FIFO eviction) and de-dupes by id.
- PATCH (settle / claps) is best-effort and idempotent; failures are
  retried on the next `/api/live` poll, so they don't need to live here.

## Manual settle trigger

The "Watch the result" button is gated behind `import.meta.env.DEV`. It
never appears in production builds. In production, settlement is driven
exclusively by the `/api/live` poll.

## Setup — run these yourself

### 1. Apply the migration

The `keibamon_social` D1 already exists from Phase 1. Apply the new
migration locally and remotely:

```bash
cd workers/social

# Local shadow DB (for `npm run dev`)
npx wrangler d1 execute keibamon_social --local \
  --file migrations/0002_tickets.sql --yes

# Remote (production) — required before `wrangler deploy`
npx wrangler d1 execute keibamon_social --remote \
  --file migrations/0002_tickets.sql --yes
```

Verify both:

```bash
npx wrangler d1 execute keibamon_social --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
# Expect: users, tickets (and sqlite internal tables).

npx wrangler d1 execute keibamon_social --remote \
  --command "PRAGMA table_info(tickets)"
# Expect 9 columns + the new index in sqlite_master.
```

### 2. No new secrets

Phase 2 reuses `CLERK_ISSUER`, `ALLOWED_ORIGINS`, and the `DB` D1 binding
from Phase 1. No new Wrangler secrets are required.

### 3. Deploy

```bash
cd workers/social
npx wrangler deploy
# Note the URL — same *.workers.dev subdomain as Phase 1.

cd ../..
npm --prefix frontend test
npm --prefix frontend run build
# The racing Worker re-deploys with the new frontend bundle; the social
# Worker is independent.
```

### 4. Verify

- Sign in, age-gate, land on My Tickets.
- Commit a ticket from the New-bet flow. Open devtools → the POST
  `/api/social/tickets` returns 200 with the inserted row.
- Reload the page → the GET returns the same ticket (server is the source
  of truth). Clear localStorage and reload → ticket re-appears (cache is
  rebuildable).
- In a different browser / device, sign in with the same account → the
  ticket is there.
- The manual "Watch the result" button must NOT appear in the production
  build (`npm run build` then `npm run preview`).

## Rollback

The Phase 2 surface is opt-in via the social Worker + the new migration.
To disable:

1. Set the social Worker to "disabled" in the Cloudflare dashboard, or
   roll back the deploy: `npx wrangler deployments list` then
   `npx wrangler deployments rollback` from `workers/social/`.
2. The frontend falls back to the localStorage cache + offline queue. No
   committed tickets are lost — the queue holds them and they re-sync if
   the Worker is restored. (If you also want to drop the queue, clear
   `kbm.pending.*` from localStorage.)
3. The `tickets` table is inert without the Worker; you can leave it or:

```bash
npx wrangler d1 execute keibamon_social --remote \
  --command "DROP TABLE IF EXISTS tickets"
npx wrangler d1 execute keibamon_social --remote \
  --command "DROP INDEX IF EXISTS idx_tickets_user_created"
```

## Common gotchas

- **Forgot to run the migration remotely.** `--local` only seeds the
  shadow DB; the prod Worker sees an empty schema. Verify with
  `PRAGMA table_info(tickets)` against `--remote`.
- **CORS missing PATCH.** The Worker reflects
  `Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS`. If a stale
  deploy still serves the Phase 1 list (no PATCH), browser preflights
  fail. Redeploy the Worker.
- **Manual settle button in production.** If you see it after a prod
  build, `import.meta.env.DEV` isn't being tree-shaken — check the Vite
  config / build target.
- **Settlement never fires.** Confirm `/api/live` actually carries
  `status:'result'` for the race (today, NO producer emits a result
  block — see "Payout-source gap" above). Until that gap is closed, all
  tickets stay `open` and that is correct behavior.
- **Racing tier drift.** Do NOT edit `wrangler.jsonc`, `src/worker.js`,
  `/api/live`, `tools/jravan/`, `ingestion/`, or `src/keibamon_core/`
  from this branch. `git diff main...HEAD --stat` should show only
  `frontend/`, `workers/social/`, `docs/`, and the two `.env.example`
  files.

## Phase 3 follow-ups (out of scope)

- `follows` + `cheers` tables; cross-user clap sync (today claps live in
  the ticket payload and are per-user only).
- Public profiles + friend/cheer counts via the 45s poll.
- Share-image export of the ticket card.
- Server-side settle sweep: a Worker cron (or a Durable Object alarm) that
  PATCHes tickets whose race just reached `result`, so users who are
  offline at post-time still see settlement when they reconnect.
- Drive the `/api/live` producer (`expose_live.py`) to emit the result
  block — closing the payout-source gap above. This is a racing-tier
  change and must be a separate branch/PR.
