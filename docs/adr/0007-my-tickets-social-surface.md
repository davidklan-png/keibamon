# ADR-0007: "My Tickets" — committed-bet log + social surface

- **Status:** Accepted (2026-06-21); **Phase 5 IN REVIEW** (2026-06-22)
- **Date:** 2026-06-21
- **Deciders:** David Klan
- **Builds on:** the `/api/live` D1 projection from [[ADR-0003]]; the
  registered→open→result lifecycle from [[ADR-0006]]; the simplified
  recommender surface from ADR-0005.
- **Source:** `KeibamonDesign` handoff ("My Tickets — committed tickets, live
  odds, shareable card").

## Phase status

| Phase | State | Where |
|-------|-------|-------|
| 0 — UI on localStorage | Shipped (commit on main) | `frontend/src/App.tsx` `Step="mine"` |
| 1 — Clerk auth + identity skeleton | Merged | `frontend/src/auth/*`, `workers/social/` |
| 2 — Per-user persistence (social D1) | Merged | `workers/social/migrations/0002_tickets.sql`, `frontend/src/lib/settle.ts`, `frontend/src/auth/{socialClient,ticketQueue}.ts` |
| 3 — Social (follows, cheers, profiles, feed, share) | Merged | `workers/social/migrations/0003_social.sql`, `frontend/src/lib/share.ts`, `frontend/src/auth/socialClient.ts`, `frontend/src/App.tsx` |
| **4 — Hardening (settle sweep, dead-heat/scratch, block/report, fonts, snapshots)** | **In review** (`feat/adr-0007-phase4-hardening`) | `workers/social/{migrations/0004_blocks_reports.sql,src/{settle,sweep}.ts,wrangler.jsonc}`, `frontend/{public/fonts/,src/app.snapshot.test.tsx,src/styles.css}` |
| **5 — Visual regression (App.tsx decomposition + Playwright)** | **In review** (`feat/adr-0007-phase5-visual-regression`) | `frontend/src/{screens/*,lib/{mytickets-view,format}.ts,components/Footer.tsx,auth/AuthProvider.tsx,App.tsx}`, `frontend/{playwright.config.ts,tests/visual/}` |

## Context

Today the app ends at "here are three ticket ideas" (`Step = race → style →
tickets → explain`). The handoff adds the missing half of the loop:
**commit → live → result → cheer → share**, framed for a young, social OTB
audience, on a new **light** theme.

The UI half is well specified to the pixel. The hard part is everything the
prototype fakes: it persists to `localStorage`, invents friends and cheers from
seed data, and wiggles odds on a 3s timer. Turning that into the product David
chose means standing up infrastructure the repo **does not have today**:

- **No identity.** `backend/keibamon_api/main.py` serves only the read-only
  `/api/live` snapshot. There is no auth, no user record, no app write path.
- **D1 is spoken for.** Per `CLAUDE.md`, the racing D1 is **owned by
  capture-pc** and the Worker/app are read-only against it. User accounts,
  social graph, and cheers **cannot** live there without breaking that boundary
  and mixing PII into the medallion lake.

So this ADR is mostly an **infrastructure** decision: where the new write-side
tier lives, how identity works, and how it stays clear of the lake.

## Decisions

David's selections (two rounds of review, 2026-06-21):

| # | Decision | Choice | Future impact |
|---|----------|--------|---------------|
| 1 | Theme scope | **Re-theme the whole app to light** | One theme to maintain; every existing screen (Race/Style/Tickets/Why) needs a visual pass + regression check. Replaces the `:root` dark palette app-wide. |
| 2 | Persistence | **Per-user backend now** (not localStorage-only) | Commits sync across devices; gates the UI behind an auth + storage epic before it can ship. |
| 3 | Social layer | **Real social backend** | Friends, follower counts, shared cheers are live multi-user state — a backend program, not a UI stub. |
| 4 | Navigation | **My Tickets becomes the home** | Returning users land on their feed; the 4-step flow moves behind "+ New bet". Changes the app's entry point. |
| 5 | Auth | **Clerk** (managed consumer auth) | External vendor + per-MAU cost; fastest path to real identity + social login. Drop-in consumer UX, clean fit beside a separate D1. |
| 6 | Data backend | **New Cloudflare D1 + Workers app, separate from the racing D1** | Keeps the capture-pc / lake boundary clean, PII isolated, native to the edge stack. D1 is young — complex social queries cost more than Postgres. |
| 7 | Realtime | **Poll, reuse the existing 45s cadence** | No new infra; cheers/counts lag up to ~45s. Durable Objects/WebSockets deferred. |
| 8 | Privacy model | **Public profiles / follow model** | More viral. Framed as a **game, not a betting app** — a persistent disclaimer/notice is the agreed mitigation (Decision 9), not age-gated visibility. |
| 9 | Product framing | **Game, not betting** — disclaimer suffices | The persistent "for fun — not betting advice" notice is the compliance posture. No age-gated visibility or legal-review gate required for launch. |

## Architecture

Four tiers. The racing lake and capture-pc pipeline are **untouched**.

```
                 ┌──────────────────────────────┐
  Auth vendor ───▶  Frontend (App.tsx, re-themed) │
  (Clerk/…)        │  home = My Tickets feed       │
                 └───────┬───────────────┬────────┘
                         │ reads          │ reads+writes (JWT)
                         ▼                ▼
              /api/live (racing D1,   NEW social Worker
              read-only, capture-pc)  + NEW social D1
                  [ADR-0003/6]        (users, tickets,
                  UNCHANGED            follows, cheers)
```

- **Identity** comes from the managed auth vendor (issues a JWT the social
  Worker verifies). The age-gate hook backs the existing under-20 notice.
- **Racing data** still flows through the existing read-only `/api/live`. A
  committed ticket stores a `RaceSnapshot` and re-matches live odds/result by
  `raceKey` (`date|venue|race_no|name`, the key `App.tsx` already computes).
- **Social/user data** is a **separate Cloudflare D1**, written through a new
  Worker. It never touches the racing D1.

### Social D1 schema (sketch)

```sql
users    (id PK, handle, display_name, avatar, created_at, age_verified)
tickets  (id PK, user_id FK, serial, race_key, payload JSON,  -- CommittedTicket
          state, payout_base, returned, created_at)
follows  (follower_id FK, followee_id FK, created_at, PK(follower,followee))
cheers   (ticket_id FK, user_id FK, created_at, PK(ticket,user)) -- 1 cheer/user
```

`payload JSON` carries the recommender's `Ticket` + `RaceSnapshot` (frontend
`lib/types.ts`, added per the handoff) so the engine output is stored verbatim
and the lake schema is irrelevant to the social tier.

### Frontend

- Re-theme `styles.css` `:root` to the light palette in the handoff (new tokens
  listed there); visual-regression pass on the 4 existing screens.
- New `Step` value `"mine"` as the landing area; create flow (`race → style →
  tickets → explain`) reached via "+ New bet".
- Reuse the **real** `recommend()` for the three "vibe" options
  (Safer→`safe`, Balanced→`balanced`, Spicier→`longshot`); do **not** port the
  prototype math. Drive live odds from the existing 45s poll, not the 3s timer.

## Risks & required call-outs

1. **Guardrail conflict — RESOLVED.** The handoff's `mine.commit = "Lock it in"`
   failed `guardrails.test.ts` (`/\block\b/i`). Copy is changed to **"Confirm"**
   ("確定"). The guardrail test stays green.
2. **Public profiles (Decision 8) — accepted via game framing (Decision 9).**
   The product is a **game, not a betting app**; the persistent "for fun — not
   betting advice" notice on every screen and shared card is the agreed
   mitigation. No age-gated visibility or legal-review gate for launch. Keep the
   not-advice micro-line on the share card (the design already does).
3. **Scope/sequencing.** Decisions 2/3/5/6 mean the *full* feature can't ship
   until Clerk + social Worker + social D1 exist. The critical path is the
   backend — so we build **Phase 0 (UI on localStorage) first** to de-risk the
   design in parallel.

## Delivery plan (phased)

Each phase is independently shippable behind a flag; later phases need earlier
ones.

- **Phase 0 — Frontend, offline (no backend).** Re-theme to light; build the
  three views (feed/new/detail) against the real `recommend()` and `/api/live`;
  persist to `localStorage` as a temporary stand-in; fix the "lock" string.
  *Ships the look + the share-card payoff for review without waiting on infra.*
- **Phase 1 — Identity.** Integrate the chosen auth vendor; add `users`; gate
  My Tickets behind sign-in; wire the age check to the under-20 notice.
- **Phase 2 — Per-user persistence.** New social D1 + Worker; move committed
  tickets server-side (localStorage becomes offline cache); settle from
  `status:'result'`.
- **Phase 3 — Social.** `follows` + `cheers`; public profiles; friend/cheer
  counts via the 45s poll; image-export share of the card.
- **Phase 4 — Hardening.** Compliance/ToS review (Risk 2), rate limits on
  cheers/follows, self-hosted fonts, visual-regression sign-off on all screens.

## Open items — all resolved (2026-06-21)

1. **Auth vendor → Clerk.**
2. **Compliance posture → game framing, disclaimer suffices** (Decision 9); no
   age-gated visibility for launch.
3. **Phase 0 first** — confirmed. UI on localStorage now, Clerk + social backend
   as fast-follow.

## Note on this environment

This was prepared in the Cowork sandbox, which **cannot git commit/push** (per
`CLAUDE.md`). This ADR is written to `docs/adr/0007-my-tickets-social-surface.md`
for you to review and commit on the Mac.

## Phase 1 — Decisions made in implementation (2026-06-21)

These resolve the choices the ADR left open when Phase 1 hit the hard
constraints (racing Worker owns `keibamon.com/*`; cannot share that origin
without editing it). The racing tier is untouched — see "Diff scope" below.

1. **Separate-origin deploy for the social Worker.** The racing Worker
   (`src/worker.js`) owns `keibamon.com/*` (assets + `/api/live`). The social
   Worker therefore deploys to its own origin with `/api/social/*` and NEVER
   shares a route prefix with the racing Worker. `/api/live` stays where it
   is; `/api/social/me` lives on the social Worker. The two Workers don't
   share a `wrangler.jsonc`, D1 binding, or origin.
2. **Phase 1 deploy target: `*.workers.dev` subdomain.** Zero DNS work for
   the human — `keibamon-social.<subdomain>.workers.dev`. Custom domain
   `social.keibamon.com` is a documented Phase 2 follow-up (it needs a route
   override on the social Worker only, which is fine; the racing Worker is
   still untouched).
3. **Frontend targets the social Worker via `VITE_SOCIAL_API_BASE`.** The
   build embeds the URL; CORS is enforced in the social Worker via the
   `ALLOWED_ORIGINS` var.
4. **JWT verification with `jose` (not Clerk's SDK on the Worker).** Keeps
   the Worker dependency-light (one pure-JS lib, no Clerk runtime) and
   testable with no network. JWKS is fetched from Clerk's well-known URL on
   first verify and cached on the isolate.
5. **`AuthGate` is pure-presentational (no Clerk imports).** A thin context
   (`AuthProvider`) wraps Clerk's hooks and exposes a single `useAuth()` to
   the app. This lets `AuthGate` be exercised with `renderToStaticMarkup`
   (the i18n.test.tsx style) without pulling Clerk's runtime into the test;
   the test stubs `SignInScreen` for the same reason.
6. **Soft-fail when `VITE_CLERK_PUBLISHABLE_KEY` is unset.** Build must not
   hard-crash. In dev, a one-liner warning prints; `AuthProvider` returns a
   no-op value (signed-out, `openSignIn` warns); the app still renders.
7. **20+ self-attestation in localStorage (Phase 1) → social D1 (Phase 2).**
   The `setPublicMetadata` path the spec mentioned does not exist on Clerk's
   frontend `UserResource` in v5 (publicMetadata is read-only from the
   client). Phase 1 persists `age_verified` to `localStorage` keyed by Clerk
   user id AND to the social D1 row via POST `/api/social/me`. Phase 2 will
   replace the localStorage read with a `GET /api/social/me` fetch in
   `AuthProvider` so the D1 is the single source of truth.

### Phase 1 diff scope

`git diff main...feat/adr-0007-phase1-clerk --stat` will show:

- `frontend/src/auth/` (new) — AuthProvider, AuthGate, SignInScreen, AgeGate,
  socialClient, storageKey, and the two test files.
- `frontend/src/main.tsx`, `frontend/src/App.tsx`, `frontend/src/i18n/{en,ja}.ts`,
  `frontend/src/styles.css`, `frontend/src/vite-env.d.ts`, `frontend/package.json`,
  `frontend/.env.example`.
- `workers/social/` (new) — isolated Worker package, D1 migration, tests.
- `docs/adr/0007-my-tickets-social-surface.md`, `docs/runbooks/phase1-clerk-auth.md`.

NOT touched: root `wrangler.jsonc`, `src/worker.js`, `backend/`, `splash/`,
`tools/jravan/`, `ingestion/`, `src/keibamon_core/`, the racing D1,
`/api/live`.

## Phase 2 — Decisions made in implementation (2026-06-21)

Phase 2 moves committed tickets server-side and adds settlement. The hard
constraint stayed the same: the racing tier (racing D1, `/api/live`, asset
Worker, `tools/jravan`, `ingestion`, `src/keibamon_core`) is **untouched**.
The Phase 1 Worker + D1 + Clerk JWT layer is **reused** — no new datastore.

1. **Tickets table on `keibamon_social` (not a new D1).** Phase 1 already
   stood up the social D1 with a `users` table; Phase 2 adds `tickets` as
   a sibling. `payload JSON` carries the verbatim `CommittedTicket` so the
   social tier stays opaque to the lake schema; the flat `state` /
   `returned` / `race_key` / `payout_base` columns are the
   resolver / query surface. A `(user_id, created_at DESC)` index backs
   the feed.
2. **Settlement is client-side, driven by `/api/live`.** The 45s poll in
   `App.tsx` already exists; a new effect on the same snapshot iterates
   the user's OPEN tickets, matches `raceKey`, and resolves win/miss when
   `status==='result'`. PATCH is fired per ticket. No new infra, no
   server cron, no Durable Object. (A future server-side sweep for
   offline-at-post-time users is a Phase 3+ follow-up.)
3. **The manual "Watch the result" button is gated behind
   `import.meta.env.DEV`.** Production users never see it. Phase 0's
   stub-settle path is inert in prod; the real path is the auto-effect.
4. **Offline commit queue in localStorage (`ticketQueue.ts`).** Commits
   are optimistic; failed POSTs queue under `kbm.pending.<userId>` and
   flush before the GET on the next signed-in load. Cap 50 (FIFO
   eviction), de-dupe by id. PATCH (settle / claps) is NOT queued — it's
   idempotent and retried on the next poll.
5. **localStorage demoted to a read-through cache.** The first server GET
   replaces state and mirrors the response into the same `kbm.v4.<userId>.<lang>`
   key Phase 1 used; the cache renders instantly on the next load and
   survives offline. Clearing it loses nothing for signed-in users
   (the GET rebuilds it).
6. **Settlement resolver is pure + idempotent (`lib/settle.ts`).**
   Implementations for all 5 bet types the recommender emits
   (`quinella`, `wide`, `exacta`, `trio`, `trifecta`). Payout lookup
   canonicalizes combos to the form `netkeiba_payouts.py` uses
   (ascending-sort for unordered types, preserve-order for exacta /
   trifecta). The resolver returns `{state:'open', reason:'no_finishers_yet'}`
   when the result block is empty — it never fabricates a settlement.
7. **Payout-source gap is REAL and accepted (2026-06-21).** Today's
   `/api/live` producer (`tools/jravan/expose_live.py`) does NOT emit a
   result block. `snapshot.py:87` passes `raw.get('result')` through
   unchanged and no upstream populates it. So in production, every
   "result" race still has empty `result` → resolver returns
   `{state:'open', reason:'no_finishers_yet'}` → ticket stays open → UI
   shows the commit-time estimate (`payoutBase`). No false settlement,
   no fabricated payout. When the producer starts emitting finishing
   order + payouts (a racing-tier change, separate branch), this
   resolver resolves them with no UI change. Tracked as Phase 2
   follow-up #1.
8. **Demo seed gated to signed-out users.** Phase 0's two demo tickets
   were a stand-in for the missing backend; signed-in users now get
   their real server feed (or an honest empty-state).
9. **`claps` stays local-only.** Phase 3 will add a `cheers` table and
   cross-user sync; for now claps are persisted in the ticket's payload
   (so the cache survives a reload) and PATCHed best-effort, but they
   are NOT shared across users. The cheer UI works exactly as before.

### Settlement hit conditions (resolver contract)

For each OPEN ticket, the 45s `/api/live` poll matches `race.raceKey`; if
`status === 'result'`, the pure resolver (`lib/settle.ts`) applies:

| Bet type | Hit condition |
|----------|---------------|
| quinella | the line's 2 horses match the top-2 **as a set** |
| wide     | both horses in the line finish in the **top 3** |
| exacta   | the line's 2 horses match the top-2 **in order** |
| trio     | the line's 3 horses match the top-3 **as a set** |
| trifecta | the line's 3 horses match the top-3 **in order** |

Winning-line payout: the `result.payouts` row matched by pool + canonicalized
combo → `yen * unit / 100` (JRA per-¥100 convention). If payouts are absent,
fall back to the commit-time `avgPayout` tagged `source:'estimate'`. Combo key
matches `netkeiba_payouts.py`: ascending-sort for unordered types, preserve
order for exacta / trifecta. The resolver never mutates its input.

### Known correctness gap: dead heats & scratches (to verify before GA)

The hit conditions above assume a single strict finishing order. Two real JRA
cases break that assumption and must be honored when follow-up #1 lands the
result contract:

1. **Dead heats (同着).** A tie at a placing means JRA pays multiple combos. The
   resolver must derive the placing **set** from the result's placing data
   (which can list ≥2 horses at a position), not from one ordered array, or a
   legitimately winning ticket on a tie race will mis-settle as a MISS.
2. **Scratches / refunds (出走取消・返還).** A scratched horse in a line should
   trigger a refund path, not an automatic MISS.

Neither can be exercised today (the producer emits no result block), so this is
a **design requirement on the result contract**, tracked with follow-up #1 — the
`/api/live` producer must carry ties and scratches, and `settle.ts` must have
table-driven tests for both before settlement goes live for real users.

### Phase 2 diff scope

`git diff main...feat/adr-0007-phase2-persistence --stat` will show:

- `workers/social/migrations/0002_tickets.sql` (new) — tickets table +
  `(user_id, created_at DESC)` index.
- `workers/social/src/index.ts`, `workers/social/test/social.test.ts` —
  ticket CRUD endpoints + ownership tests (real in-memory D1 fake).
- `frontend/src/api.ts` — optional `result: RaceResult | null` on
  `LiveRace`.
- `frontend/src/auth/socialClient.ts` (extended) — `listTickets`,
  `postTicket`, `patchTicket` typed helpers.
- `frontend/src/auth/ticketQueue.ts` + test (new) — offline commit queue.
- `frontend/src/lib/settle.ts` + test (new) — settlement resolver for
  all 5 bet types, table-driven.
- `frontend/src/App.tsx` — server-first load, optimistic commit, auto-
  settle effect, DEV-only manual trigger, signed-out-only seed.
- `frontend/src/i18n/{en,ja}.ts` — three new strings (`estimate`,
  `empty`, `offlineQueued`).
- `docs/adr/0007-*.md`, `docs/runbooks/phase2-persistence.md`.

NOT touched: root `wrangler.jsonc`, `src/worker.js`, `backend/`, `splash/`,
`tools/jravan/`, `ingestion/`, `src/keibamon_core/`, the racing D1,
`/api/live`, `expose_live.py`.

### Phase 2 follow-ups

1. **Drive `/api/live` to emit `result` (incl. ties + scratches).** Closes the
   payout-source gap (Decision 7) AND supplies the placing/scratch data the
   dead-heat & refund handling needs (see "Known correctness gap"). A
   racing-tier change; separate branch + PR. **This gates the feature's value:**
   until it lands, no ticket ever settles in prod and the result→cheer→share
   loop never fires for real users — treat it as the critical-path dependency,
   not tail-end cleanup.
2. **Server-side settle sweep.** A Worker cron / Durable Object alarm that
   PATCHes tickets when their race reaches `result`, so users offline at
   post-time still settle on reconnect. Client-only settlement is best-effort;
   for a product whose payoff moment is the point, pull this forward (Phase 3 /
   early Phase 4) rather than leaving it open-ended.
3. **Dead-heat & scratch handling in `settle.ts`.** Table-driven tests for 同着
   ties (multiple winning combos) and scratch refunds, landed together with
   follow-up #1's result contract. Must be green before settlement goes GA.
4. **`cheers` table + cross-user sync.** Phase 3. ✓ Landed.
5. **Rate limits on POST /tickets.** Phase 3 landed a minute-bucket counter
   in D1 (covers follow/unfollow/cheer/uncheer/ticket). Phase 4 will replace
   it with a real token bucket / sliding window in KV.

## Phase 3 — Decisions made in implementation (2026-06-21)

Phase 3 turns the cosmetic social proof — hardcoded counts, local-only
claps, a share-toast stub — into real multi-user state on the existing
`keibamon_social` D1. No new datastore, no websockets. Counts refresh on
the existing 45s `/api/live` poll. The 9 architecture decisions are
documented in `docs/runbooks/phase3-social.md` and summarized here:

1. **`COUNT(*)` from `cheers`, not denormalized.** Correctness over speed —
   `idx_cheers_ticket` makes the count O(log n); the 45s poll hides any
   read latency. A denormalized `claps` column would introduce a count-drift
   bug class (race between concurrent cheers, lost updates).
2. **Self-cheer forbidden** (409 `cannot_cheer_own_ticket`). Removes an
   inflation vector; matches JRA social norm.
3. **Uncheer (DELETE) included; idempotent.** Symmetric with follow/unfollow.
4. **Handle is explicit user-set, with uniqueness.** Auto-deriving from
   Clerk email leaks PII; generated `player-abc123` is impersonal. Partial
   unique index `idx_users_handle_unique` (NULLs exempt) enforces collisions.
   Bootstrap UX: first social action with `handle === null` pops a set-handle
   modal.
5. **Asymmetric (Twitter-style) follow.** No acceptance step.
6. **Profile routing = new `MtView` value `"profile"`, not a router.**
   App.tsx has no router today; the state-machine already switches on `MtView`.
7. **`html-to-image` for share PNG.** ~12 KB gzipped, pure JS. The export
   is gated on the presence of `[data-not-advice]` — fails loudly rather
   than silently shipping an advice-less card.
8. **Per-user per-minute rate limits in D1.** follow/unfollow 30/min,
   cheer/uncheer 60/min, ticket 20/min. 429 + `Retry-After`. Phase 4
   will replace with a token bucket in KV.
9. **Owner object is client-derived.** `ownerFromUser(user)` maps the flat
   server shape `{id, handle, display_name, avatar}` to the existing
   `TicketOwner` (`{en, ja, color, initial, initialJa}`) via a deterministic
   color from `user.id` hash. Keeps the DB lean and avoids duplicating
   i18n-aware fields.

### Public-safe profile projection

The Worker's `publicUser()` helper is the ONLY shape that leaves the server
on profile/feed/friends routes: `{id, handle, display_name, avatar,
created_at, follower_count, followee_count, is_following?}`. `clerk_user_id`,
`email`, and `age_verified` NEVER leave the Worker. A test (`public profile
response omits clerk_user_id, email, age_verified`) pins this contract.

### Phase 3 diff scope

`git diff main...feat/adr-0007-phase3-social --stat` will show:

- `workers/social/migrations/0003_social.sql` (new) — `follows`, `cheers`,
  `rate_limits` tables + `idx_users_handle_unique` partial index.
- `workers/social/src/index.ts` (extended) — new routes (follow/unfollow,
  cheer/uncheer, profile, feed, friends) + extended `postMe` (handle/dn/
  avatar) + extended `decodeTicket` (owner overlay + cheers count + strip
  legacy `claps`) + D1-backed rate limiter + CORS Allow-Methods += DELETE.
- `workers/social/test/social.test.ts` (extended) — new fake D1 branches
  for follows/cheers/rate_limits + the JOIN queries; 14 new tests.
- `frontend/src/auth/socialClient.ts` (extended) — `postMeTyped`,
  `follow`, `unfollow`, `cheer`, `uncheer`, `getProfile`, `getFeed`,
  `getFriendsOnRace`, `getFriendsOnCard`; `patchTicket` no longer takes
  `claps` (Phase 3 hoisted claps to `COUNT(*)` from cheers).
- `frontend/src/auth/socialClient.test.ts` (new) — path/method/auth
  contract assertions on the new helpers.
- `frontend/src/lib/share.ts` + `share.test.ts` (new) — PNG export with
  the `[data-not-advice]` hard gate.
- `frontend/src/lib/types.ts` (extended) — `PublicUser`, `ownerFromUser`,
  `cheers`/`cheeredByMe`/`ownerUser` on `CommittedTicket`.
- `frontend/src/App.tsx` — `MtView` adds `"profile"`; new state (profile,
  friendsOnCard/Race, viewerHandle, handlePrompt); `cheer()` rewritten as
  a toggle with optimistic + reconcile; `patchTicket({claps})` removed;
  real counts replace hardcoded `n:12`/`n:8`; `ProfileView` + set-handle
  modal; share button wired to `exportTicketCard`; `data-not-advice`
  attribute on the detail-card micro-line.
- `frontend/src/i18n/{en,ja}.ts` — `profile.*`, `mine.{cheering,uncheered,
  cannotCheerOwn,rateLimited,share,shareFailed,setHandle*}`.
- `frontend/package.json` — `+html-to-image`, `+jsdom` (devDep, for the
  share test).
- `docs/adr/0007-*.md`, `docs/runbooks/phase3-social.md` (new).

NOT touched: root `wrangler.jsonc`, `src/worker.js`, `backend/`, `splash/`
(as a Worker — only the rebuilt frontend bundle lands there),
`tools/jravan/`, `ingestion/`, `src/keibamon_core/`, the racing D1,
`/api/live`, `expose_live.py`, `styles.css` (fonts stay on Google Fonts
for Phase 4).

### Phase 4 backlog (carried forward + new)

- **Full rate limiting** — token bucket / sliding window in KV (replaces
  the minute-bucket counter landed here).
- **Block + report** — moderation primitives for the public social graph.
- **Self-host fonts** — replace Google Fonts `@import` in `styles.css`.
- **Server-side card renderer** — consistent cross-platform share output.
- **Visual-regression snapshots** — across all screens × both languages.
- **Server-side settle sweep** (Phase 2 follow-up #2).
- **Drive `/api/live` to emit `result`** with ties + scratches (Phase 2
  follow-up #1) — still the critical-path dependency for the whole social
  loop; without it, no ticket settles in prod and the cheer→share moment
  never fires for real users.

## Phase 4 — Decisions made in implementation (2026-06-21)

Phase 4 closes reliability, correctness, and privacy/safety gaps. **No new
product surface.** Scope cuts decided up front: D1 rate limits stay (no KV
token bucket), HTML-string snapshots only (no Playwright CSS-pixel), server-
side card renderer deferred. The 11 architecture decisions are documented in
`docs/runbooks/phase4-hardening.md` and summarized here:

1. **Settle resolver's canonical home is the Worker; frontend re-exports
   via shim.** Worker owns the sweep (server-side authority); no fork.
   Vite + tsc resolve the cross-dir relative import; frontend's richer
   `Ticket` is structurally compatible with the minimal resolver input.
2. **Dead-heat via `placings?:{pos,umabans[]}[]`; resolver enumerates
   orderings.** `finishers: number[]` cannot express 同着 (two horses at
   pos=2). Placings-as-sets is the JRA semantics; `expandPlacings` yields
   the cartesian product across tied positions and a line hits if it
   matches ANY expanded ordering.
3. **Scratch via `scratched?:number[]`; refunded variant.** JRA refunds
   all lines containing a scratched horse (返還). Today a scratch silently
   mis-settles as MISS. New `{state:"refunded", reason:"scratched"}`
   surfaces the refund path without polluting `won`/`miss`.
4. **Cron Trigger every 5 min UTC.** Client `/api/live` poll is the fast
   path; sweep is the offline-backstop. CF Cron Triggers are the lightest
   mechanism — no DO, no Queue.
5. **Sweep → `/api/live` via `LIVE_BASE` secret + `fetch()`.** Worker has
   no service binding to the racing Worker today; adding one would require
   editing root `wrangler.jsonc` (forbidden). A secret is in-bounds — only
   the social Worker is touched.
6. **Rate limits: extend D1 coverage, skip KV.** D1 minute-bucket counter
   works; KV token bucket deferred (Phase 5 backlog).
7. **Asymmetric one-way block (Twitter model).** `INSERT` = blocked;
   `DELETE` = unblock. Block severs existing follows in both directions
   and prevents future follow/cheer either direction. Feed filter is
   one-way (only hides B from A's feed); B can still see A's tickets.
8. **Reports are write-only.** `reports(reporter_id, target_type,
   target_id, reason, created_at)`. No moderation review UI — store for
   later. Surfacing a queue is Phase 5 scope.
9. **Self-host fonts as woff2 subsets.** Removes the only runtime
   third-party request. ~7 files, ~460 KB uncompressed, ~140 KB after
   brotli. Subsetting to ~660 codepoints (ASCII + hiragana + katakana +
   app kanji + half-width kana) keeps each weight small. OFL 1.1 license
   bundled.
10. **Server-side card renderer: DEFER.** Client `html-to-image` works;
    no data justifying the work. Phase 5 backlog.
11. **Visual regression via HTML-string snapshots, not Playwright.**
    Cheaper; catches DOM + i18n regressions. CSS-pixel drift deferred
    (acknowledged gap). Scope reduced to 4 baselines (auth surface)
    because the 8 legacy screens live inside App.tsx as inline functions
    — pulling them out is a Phase 5 refactor.

### Phase 4 diff scope

`git diff main...feat/adr-0007-phase4-hardening --stat` shows only
`frontend/`, `workers/social/`, `docs/`. Highlights:

- `workers/social/migrations/0004_blocks_reports.sql` (new) — `blocks` +
  `reports` tables.
- `workers/social/src/settle.ts` (new) — extracted from
  `frontend/src/lib/settle.ts`; dead-heat + scratch + refunded variant.
- `workers/social/src/sweep.ts` (new) — cron settle sweep, idempotent +
  bounded at 200 tickets/run.
- `workers/social/src/index.ts` (extended) — `{ fetch, scheduled }`
  default export; block/report routes; `RATE_LIMITS` extended; feed
  filter gains `NOT EXISTS blocks`; follow/cheer block guards.
- `workers/social/wrangler.jsonc` — `triggers.crons = ["*/5 * * * *"]`.
- `workers/social/test/{settle,sweep}.test.ts` (new) — port + new
  fixtures (dead-heat, scratch, refund, sweep cases).
- `workers/social/test/social.test.ts` (extended) — block/report
  branches + 14 new Phase 4 tests.
- `frontend/src/lib/settle.ts` (becomes shim) + `settle.test.ts`
  (extended with dead-heat/scratch/refund fixtures).
- `frontend/src/auth/socialClient.ts` (extended) — `block`, `unblock`,
  `report`.
- `frontend/src/App.tsx` — Block/Report buttons + report modal.
- `frontend/src/i18n/{en,ja}.ts` — `profile.{block,unblock,blocked,
  report,reportReason,reportSent,cannotBlockSelf}`.
- `frontend/public/fonts/*.woff2` (7 new) + `LICENSE.txt`.
- `frontend/src/styles.css` — 7 `@font-face` rules replace `@import`.
- `frontend/src/app.snapshot.test.tsx` (new) + `__snapshots__/` (4 files).
- `docs/runbooks/phase4-hardening.md` (new); this ADR updated.

NOT touched: root `wrangler.jsonc`, `src/worker.js`, `/api/live`,
`tools/jravan/`, `ingestion/`, `src/keibamon_core/`, the racing D1.

### Phase 5 backlog (carried forward)

- **KV token bucket rate limits** (Phase 4 backlog #1 — partially closed:
  extended D1 coverage to `block`/`report`; KV deferred).
- **Server-side card renderer** for share image (Phase 4 backlog #4 —
  deferred, no data justifying the work).
- **CSS-pixel visual regression** with Playwright (Phase 4 used HTML-string
  snapshots; covers DOM regressions but not pixel drift, and only the auth
  surface — the 8 legacy screens need extraction from App.tsx first).
- **Moderation review queue UI** (Phase 4 stores reports but doesn't
  surface them for review).
- **Drive `/api/live` to emit result** (Phase 2 follow-up #1 — racing-tier
  dependency; the sweep has nothing to settle against without this).

## Phase 5 — Decisions made in implementation (2026-06-22)

Phase 5 closes the CSS-pixel gap left by Phase 4's HTML-string snapshots and
un-blocks it by decomposing the 2.7k-line `App.tsx` monolith into per-screen
components. **No new product surface, no behavior change.** Scope cuts: KV
token bucket deferred again, server-side card renderer deferred again. The
11 architecture decisions are documented in `docs/runbooks/phase5-visual-regression.md`
and summarized here:

1. **Extract pure helpers first; screens second; MyTickets last.** Pure
   helpers (no closures over React state) are the safest move; the 4 legacy
   screens have explicit props interfaces; the 1709-line MyTickets move is
   highest-risk so it goes last.
2. **Bundle byte-size as the behavior-preservation gate.** After each
   extraction, `npm run build` produced identical `dist/assets/index-*.js`
   size (364.17 kB) — strong evidence no code changed semantically. Visual
   baselines are the second gate.
3. **`MyTickets.tsx` stays as one file (not split into feed/new/detail).**
   All three views share ~10 `useState` + ~10 `useEffect` and would balloon
   props if separated. A single 1709-line component with internal
   `render{Feed,New,Detail,Profile,ReportModal}` functions preserves the
   closures exactly.
4. **Test-only auth bypass env var (`VITE_PLAYWRIGHT_BYPASS_AUTH=1`).**
   AuthProvider returns a fake signed-in session. Off in production builds
   (env var unset → dead branch eliminated). Cheapest path to full MyTickets
   coverage under Playwright.
5. **`page.route()` mocks for `/api/live` + `/api/social/*`.** One fixture
   race + two CommittedTickets (open quinella owned by "you", won win owned
   by "Rin"). Deterministic shape → deterministic render.
6. **Freeze `Date.now()` via `page.addInitScript`.** The countdown chip
   (post_time=15:40 JST) ticks every second under wall-clock. Override
   `Date.now` to `2026-06-21T13:00:00+09:00` → countdown renders
   "2:40:00 to go" (en) / "開始まで 2:40:00" (ja) deterministically.
7. **`maxDiffPixelRatio: 0`** — strictest possible. A single intentional
   style change (`.mt-brand-name` font-size 17→22 px) failed the suite
   during sign-off; reverting brought it green.
8. **Walk forward via UI clicks, not URL deep-links.** `App.tsx` always
   starts at `step="mine"`; each test lands on the feed, then clicks
   `.mt-fab` → `.mt-back-head .lang-toggle` (Builder/詳細) → stepper.
9. **`workers: 1, fullyParallel: false, retries: 0`.** Visual regression
   can't be parallelized safely; no flaky retries hiding real regressions.
10. **Self-hosted fonts (Phase 4) are critical infrastructure.** If the
    runtime Google Fonts `@import` were still in `styles.css`, every visual
    baseline would fail intermittently (network-dependent glyph
    substitution). Phase 4 made Phase 5's strict threshold achievable.
11. **KV token bucket: SKIP again.** Phase 4's D1 minute-bucket counter
    covers current volume. Phase 6 backlog.

### Phase 5 diff scope

`git diff main...feat/adr-0007-phase5-visual-regression --stat` shows only
`frontend/` and `docs/`. Highlights:

- `frontend/src/App.tsx` — 2731 → 316 lines (state, effects, loadLive,
  applyRace, recommend regen, stepper nav). Default export unchanged.
- `frontend/src/screens/MyTickets.tsx` (new, 1709 lines) — `MyTicketsHome`
  exported + internal `MyTickets` component with feed/new/detail/profile/
  report-modal render functions.
- `frontend/src/screens/{Race,Style,Tickets,Explain}Screen.tsx` (new) —
  legacy 4-step builder, explicit props interfaces.
- `frontend/src/lib/mytickets-view.ts` (new) — pure mt* view-model helpers.
- `frontend/src/lib/format.ts` (new) — `yen`, `fmt` shared helpers.
- `frontend/src/components/Footer.tsx` (new) — shared footer.
- `frontend/src/auth/AuthProvider.tsx` (extended) — `PLAYWRIGHT_BYPASS`
  branch; unreachable in prod builds.
- `frontend/playwright.config.ts` (new) — vite dev on :5174 with the bypass
  env var; `maxDiffPixelRatio: 0`; workers: 1.
- `frontend/tests/visual/{fixtures,smoke.spec,visual.spec}.ts` (new) —
  deterministic mocks + 14 baselines × {en, ja} + 1 smoke test.
- `frontend/tests/visual/visual.spec.ts-snapshots/*.png` (14 new) —
  chromium-darwin baselines for every screen.
- `frontend/package.json` — `+@playwright/test`; new scripts
  `test:visual` and `test:visual:update`.
- `.gitignore` — `frontend/test-results/` added (Playwright runtime artifacts).
- `docs/adr/0007-*.md`, `docs/runbooks/phase5-visual-regression.md` (new).

NOT touched: root `wrangler.jsonc`, `src/worker.js`, `/api/live`,
`tools/jravan/`, `ingestion/`, `src/keibamon_core/`, the racing D1,
`workers/social/`.

### Phase 6 backlog (carried forward)

- **KV token bucket** for rate limits (carried from Phase 4).
- **Server-side card renderer** for share image (carried from Phase 4).
- **Moderation review queue UI** (carried from Phase 4).
- **Drive `/api/live` to emit result** (carried from Phase 2 — the
  racing-tier dependency that gates real settlement in prod).
- **Multi-platform visual baselines** (chromium-darwin only in Phase 5;
  WebKit/Firefox and Linux/Windows baselines if/when CI grows multi-platform
  runners).
