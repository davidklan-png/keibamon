# Phase 3 — Social layer (follows, cheers, profiles, feed, share)

Builds on Phase 1 (Clerk identity + `keibamon_social` D1) and Phase 2
(per-user ticket persistence + auto-settle). Phase 3 turns the cosmetic
social proof — hardcoded friend counts, local-only claps, a share-toast
stub — into real multi-user state on the existing social D1.

**No new datastore. No websockets. Counts refresh on the existing 45s
`/api/live` poll.**

The racing tier (racing D1, `/api/live`, the asset Worker, `tools/jravan`,
`ingestion/`, `src/keibamon_core`) is **not modified**.

## What lives where

| Concern | Where |
|---------|-------|
| Schema (new tables) | `workers/social/migrations/0003_social.sql` — `follows`, `cheers`, `rate_limits` + `idx_users_handle_unique` partial index |
| Worker routes | `workers/social/src/index.ts` — `/api/social/follow/:userId`, `/api/social/tickets/:id/cheer`, `/api/social/users/:handle`, `/api/social/feed`, `/api/social/friends/on-card`, `/api/social/races/:raceKey/friends`; `POST /api/social/me` extended (handle/dn/avatar); CORS Allow-Methods now includes `DELETE` |
| Frontend client | `frontend/src/auth/socialClient.ts` — `postMeTyped`, `follow`, `unfollow`, `cheer`, `uncheer`, `getProfile`, `getFeed`, `getFriendsOnRace`, `getFriendsOnCard` |
| App wiring | `frontend/src/App.tsx` — `MtView` adds `"profile"`, `ProfileView`, set-handle modal, real counts, cheer toggle, share export |
| Owner derivation | `frontend/src/lib/types.ts:ownerFromUser` — client-side flat→TicketOwner mapping (Decision 9) |
| Share export | `frontend/src/lib/share.ts` — `html-to-image` to PNG + Web Share API; asserts `[data-not-advice]` pre-export |
| Racing tier | UNCHANGED |

## Architecture decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | **`cheers` count is `COUNT(*)`, not denormalized** | Correctness over speed. `idx_cheers_ticket` makes the count O(log n). 45s poll hides read latency. A denormalized `claps` column would introduce a count-drift bug class (race between concurrent cheers, lost updates) for a tiny perf win. |
| 2 | **Self-cheer forbidden** (409 `cannot_cheer_own_ticket`) | Removes an inflation vector. Matches JRA social norm — cheering your own bet is weird. |
| 3 | **Uncheer (DELETE) included; idempotent** | Symmetric with follow/unfollow. Lets users correct misclicks. Uncheering a ticket you never cheered is a no-op 200. |
| 4 | **Handle is explicit user-set with uniqueness** | Auto-deriving from Clerk email leaks PII into a public handle; generated `player-abc123` is impersonal. `idx_users_handle_unique` (partial — NULLs exempt) enforces collision-free lookups. |
| 5 | **Follow is asymmetric (Twitter-style)** | Matches the public-profile / viral model. INSERT = follow; no acceptance step. |
| 6 | **Profile routing = new `MtView` value, not a router** | `App.tsx` has no router today; adding one is out of scope. The state-machine already switches on `MtView`; adding `"profile"` slots in cleanly. |
| 7 | **`html-to-image` for share PNG** | ~12 KB gzipped, pure JS, browser-only. Server-side render is a Phase 4 stretch. |
| 8 | **Rate limits: per-user, per-minute, in D1** | "Minimal but present" (per plan). Token bucket / sliding window would be Phase 4 in KV. D1 keeps the infra surface flat. |
| 9 | **Owner object is client-derived** | `ownerFromUser(user)` maps flat `{id, handle, display_name, avatar}` → `TicketOwner {en, ja, color, initial, initialJa}`. Keeps DB lean and avoids duplicating i18n-aware fields. |

## Schema (`0003_social.sql`)

```sql
CREATE TABLE follows (
  follower_id TEXT NOT NULL REFERENCES users(id),
  followee_id TEXT NOT NULL REFERENCES users(id),
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX idx_follows_followee ON follows (followee_id);
CREATE INDEX idx_follows_follower ON follows (follower_id);

CREATE TABLE cheers (
  ticket_id  TEXT NOT NULL REFERENCES tickets(id),
  user_id    TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (ticket_id, user_id)
);
CREATE INDEX idx_cheers_ticket ON cheers (ticket_id);

CREATE TABLE rate_limits (
  user_id  TEXT NOT NULL REFERENCES users(id),
  action   TEXT NOT NULL,     -- 'follow' | 'cheer' | 'ticket'
  bucket   INTEGER NOT NULL,  -- floor(now/60)
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, action, bucket)
);

CREATE UNIQUE INDEX idx_users_handle_unique
  ON users (handle) WHERE handle IS NOT NULL;
```

## API

All `POST/DELETE` require a Clerk JWT (401 without). `GET /users/:handle` and
`GET /users/:id` accept JWT optionally — signed-out viewers can read public
profiles; `is_following` defaults to false when no JWT.

| Method | Path | Auth | Body / Returns | Rules |
|--------|------|------|----------------|-------|
| POST | `/api/social/me` | JWT | extended body: `{age_verified?, handle?, display_name?, avatar?}` → user row | handle uniqueness enforced by index; 409 `{error:"handle_taken"}` on collision; bad format → 400 `bad_handle` |
| POST | `/api/social/follow/:userId` | JWT | `{ok:true}` | idempotent INSERT ... DO NOTHING; 403 if `:userId` === caller (`cannot_follow_self`); 404 if followee doesn't exist; rate-limited (30/min) |
| DELETE | `/api/social/follow/:userId` | JWT | `{ok:true}` | idempotent DELETE; rate-limited (30/min) |
| POST | `/api/social/tickets/:id/cheer` | JWT | `{count, cheeredByMe:true}` | won-only (`tickets.state='won'`, else 409 `not_won`); self-cheer → 409 `cannot_cheer_own_ticket`; PK dedupe → second tap is no-op 200; rate-limited (60/min) |
| DELETE | `/api/social/tickets/:id/cheer` | JWT | `{count, cheeredByMe:false}` | idempotent; rate-limited (60/min) |
| GET | `/api/social/users/:handle` | **public** (JWT optional) | `{handle, display_name, avatar, created_at, follower_count, followee_count, tickets:[...], is_following?}` | **public-safe fields only** — never `clerk_user_id`, `email`, `age_verified`. With JWT, each ticket carries `cheeredByMe` and the user carries `is_following`. |
| GET | `/api/social/feed` | JWT | `{tickets:[...]}` newest first, cap 100 | own + followees' tickets, each with owner + cheer count + `cheeredByMe` |
| GET | `/api/social/races/:raceKey/friends` | JWT | `{count, avatars:[{handle, display_name, avatar}...]}` cap 8 | followed users with ≥1 ticket on `raceKey`; `count` is truth, `avatars` is sample |
| GET | `/api/social/friends/on-card?race=k1&race=k2...` | JWT | `{count, avatars:[...]}` | followed users with ≥1 ticket on any race in the supplied list — powers "today's card" strip |

### Rate-limit thresholds

Per-user, per-minute (Decision 8; D1-backed, minute-bucketed):

| Action | Limit | HTTP on exceed |
|--------|-------|----------------|
| `follow` / `unfollow` | 30 / min | 429 `{error:"rate_limited"}` + `Retry-After: 60` |
| `cheer` / `uncheer` | 60 / min | 429 |
| `ticket` (POST) | 20 / min (carried from Phase 2) | 429 |

Phase 4 will replace this with a real token bucket in KV.

## Cheer / follow rules

- **Won-only cheering.** `cheer` POSTs return 409 `{error:"not_won"}` if the
  ticket's state is not `'won'`. Cheering is a celebration, not pre-race hype.
- **Self-cheer forbidden.** The ticket owner cannot cheer their own ticket
  (409 `{error:"cannot_cheer_own_ticket"}`).
- **Self-follow forbidden.** 403 `{error:"cannot_follow_self"}` (the table's
  `CHECK (follower_id <> followee_id)` is the backstop).
- **Idempotent everywhere.** Repeat follow/cheer is 200; uncheering an
  uncheered ticket is 200.

## Handle-bootstrap UX

The signed-in viewer's `handle` is `null` until they set one. The frontend
reads it via `postMe()` on sign-in. The first social action (cheer / follow /
share / open own profile) when `handle === null` pops a small modal:

- Title: "Pick your handle"
- Hint: "This is how other players see you. You can change it later."
- Input constrained to `[a-zA-Z0-9_]+`, max 32 chars
- Save → `POST /api/social/me {handle}`. Collision → inline "taken" message.

After a successful save, the original social action proceeds on the next tap.

## Share export

`frontend/src/lib/share.ts:exportTicketCard(node, filename)`:

1. Uses `html-to-image.toPng(node, {cacheBust:true, pixelRatio:2})`.
2. **Pre-export assertion:** the node must contain a child matching
   `[data-not-advice]`. Throws `MissingNotAdvice` if absent — fails loudly
   rather than silently shipping an advice-less card. The detail-card footer
   micro-line carries `data-not-advice=""`.
3. Prefers `navigator.share({files:[...]})` when `navigator.canShare({files})`
   is true (iOS Safari + Android Chrome); otherwise downloads via
   `<a href download>`.
4. Returns `{kind:'shared'}` / `{kind:'downloaded'}` / `{kind:'none'}`. The
   caller shows a friendly error toast only on `{kind:'none'}`.

## Setup — run these yourself

### 1. Apply the migration

The `keibamon_social` D1 already exists from Phase 1. Apply the new migration
locally and remotely:

```bash
cd workers/social

# Local shadow DB
npx wrangler d1 execute keibamon_social --local \
  --file migrations/0003_social.sql --yes

# Remote (production) — required before `wrangler deploy`
npx wrangler d1 execute keibamon_social --remote \
  --file migrations/0003_social.sql --yes
```

Verify both:

```bash
npx wrangler d1 execute keibamon_social --local \
  --command "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
# Expect: users, tickets, follows, cheers, rate_limits (and sqlite internals)

npx wrangler d1 execute keibamon_social --remote \
  --command "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('follows','cheers','users') ORDER BY name"
# Expect: idx_cheers_ticket, idx_follows_followee, idx_follows_follower,
#         idx_users_handle_unique (+ sqlite_autoindex_*)
```

### 2. No new secrets

Phase 3 reuses Phase 1's `CLERK_ISSUER`, `ALLOWED_ORIGINS`, and the `DB`
binding. No new Wrangler secrets are required.

### 3. Frontend dependency

`html-to-image` was added to `frontend/package.json`. Reinstall:

```bash
cd frontend && npm install
```

### 4. Deploy

```bash
cd workers/social
npx wrangler deploy
# Same *.workers.dev subdomain as Phase 1/2.

cd ../..
npm --prefix frontend run build
# The racing Worker re-serves the new bundle; the social Worker is independent.
```

### 5. Verify (two-browser end-to-end)

1. Account A signs in, sets handle `alyssa` (handle prompt), commits a ticket,
   settles it (DEV trigger or wait for `/api/live` result).
2. Account B signs in, sets handle `bob`, opens `ProfileView` for `alyssa`
   (tap her avatar), taps Follow.
3. B's feed shows A's settled ticket; B taps Cheer once (count 1), taps again
   (count stays 1, second tap = uncheer → count 0 → tap again → count 1).
4. A's feed, on the next 45s poll, shows count = 1 from B's cheer.
5. B taps "Save & share" on A's ticket → PNG offered via `navigator.share`
   (mobile) or downloaded (desktop); open the PNG and confirm the not-advice
   micro-line is visible.
6. Signed-out visit to the public profile route shows the profile with no
   `clerk_user_id` / `email` / `age_verified` in the response body (devtools
   network check).

## Rollback

Phase 3 is opt-in via the new tables + the social Worker. To disable:

1. Roll back the Worker deploy:
   ```bash
   cd workers/social
   npx wrangler deployments list
   npx wrangler deployments rollback
   ```
2. The frontend degrades gracefully — social counts render as 0 and the
   social actions return errors that surface as friendly toasts. Tickets
   continue to settle via Phase 2.
3. The new tables are inert without the Worker. To drop them:
   ```bash
   npx wrangler d1 execute keibamon_social --remote \
     --command "DROP TABLE IF EXISTS rate_limits; DROP TABLE IF EXISTS cheers; DROP TABLE IF EXISTS follows; DROP INDEX IF EXISTS idx_users_handle_unique;"
   ```

## Common gotchas

- **Forgot `--remote` on the migration.** `--local` only seeds the shadow DB.
  Verify with `SELECT name FROM sqlite_master WHERE type='table'` against
  `--remote`.
- **CORS preflight missing DELETE.** Phase 3 added `DELETE` to
  `Access-Control-Allow-Methods`. A stale Phase 2 deploy won't accept
  `DELETE /api/social/follow/:id` — redeploy.
- **Public profile leaking `clerk_user_id`.** The Worker uses `publicUser()`
  to project fields — anything new added to the `UserRow` interface must be
  explicitly added to `publicUser` if it should be public, or it won't ship.
  `clerk_user_id`, `email`, `age_verified` are NEVER in the projection.
- **Rate limits are sticky for 60s.** A test that fires 31 follows will be
  locked out for a minute. The fake D1 in `social.test.ts` uses the same
  minute-bucket so this is exercised.
- **Set-handle modal steals focus.** If the modal pops during a tap flow,
  it cancels the original action; the user must tap again after saving.
  This is intentional — the action requires a handle.
- **Racing tier drift.** Do NOT edit `wrangler.jsonc`, `src/worker.js`,
  `/api/live`, `tools/jravan/`, `ingestion/`, or `src/keibamon_core/` from
  this branch. `git diff main...HEAD --stat` should show only `frontend/`,
  `workers/social/`, `docs/`, `docs/prompts/`.

## Phase 4 backlog (NOT done in Phase 3)

- Full rate limiting (token bucket / sliding window in KV)
- Block + report (moderation primitives)
- Self-host fonts (replace Google Fonts `@import` in `styles.css`)
- Server-side card renderer (consistent cross-platform share output)
- Visual-regression snapshots across all screens × both languages
- Server-side settle sweep (Phase 2 follow-up #2)
- Drive `/api/live` to emit `result` with ties + scratches (Phase 2 follow-up #1)
