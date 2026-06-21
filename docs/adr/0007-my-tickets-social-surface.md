# ADR-0007: "My Tickets" — committed-bet log + social surface

- **Status:** Accepted (2026-06-21); **Phase 1 IN PROGRESS** (2026-06-21)
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
| **1 — Clerk auth + identity skeleton** | **In review** (`feat/adr-0007-phase1-clerk`) | `frontend/src/auth/*`, `workers/social/` |
| 2 — Per-user persistence (social D1) | Pending | ADR-0007 §Phase 2 |
| 3 — Social (follows, cheers) | Pending | ADR-0007 §Phase 3 |
| 4 — Hardening (rate limits, ToS) | Pending | ADR-0007 §Phase 4 |

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
