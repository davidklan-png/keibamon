# CLI agent prompt — Keibamon Phase 1: Clerk authentication (ADR-0007)

> Paste everything in the fenced block below into the CLI agent running on the
> **Mac** (mac-dev). It assumes ADR-0007 Phase 0 is already merged.

```
You are implementing Phase 1 of ADR-0007 ("My Tickets" social surface) in the
Keibamon repo. Read docs/adr/0007-my-tickets-social-surface.md and CLAUDE.md
before doing anything. Phase 0 (the My Tickets UI on localStorage) is already
merged; you are adding IDENTITY only.

## First
Run `python tools/whichdevice.py`. This is mac-dev work (git + builds + wrangler
available). If you are not on mac-dev, stop and tell me.

## Goal
Add Clerk authentication and gate the My Tickets home behind sign-in, backed by a
NEW Cloudflare D1 + Worker that is separate from the racing D1. Per ADR-0007:
auth vendor = Clerk; storage = new Cloudflare D1 ("keibamon_social"), never the
racing D1; product is framed as a GAME, so a lightweight 20+ self-attestation
plus the existing disclaimer is sufficient — do NOT build document KYC.

## Hard constraints (do not violate)
- DO NOT touch the racing D1, the /api/live endpoint, the Worker that serves it,
  wrangler.jsonc for the splash/app assets, or anything under tools/jravan,
  ingestion, src/keibamon_core, or the JV-Link/capture pipeline.
- DO NOT build Phase 2/3 (per-user ticket persistence, follows, cheers). Only
  identity + a users table land in Phase 1.
- Keep both test suites green: `cd frontend && npm test` and, from repo root,
  `PYTHONPATH=src python -m pytest -q`.
- Bilingual: every new user-facing string needs en + ja in i18n/en.ts + ja.ts.
- Honesty guardrails are enforced by frontend/src/i18n/guardrails.test.ts: never
  use "guaranteed", "lock", "sure thing", or "beat the market" in copy. Keep the
  not-betting-advice Footer and the under-20 notice present and reachable.
- Never commit secrets. Keys go in .env (gitignored) / `wrangler secret`.

## Tasks

1. Frontend — Clerk provider + gate
   - Add @clerk/clerk-react. Wrap the app root (frontend/src/main.tsx) in
     <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>.
   - Gate the My Tickets home: signed-out users see a light-themed sign-in screen
     (reuse the brand mark + tokens from styles.css; <SignInButton> / Clerk's
     <SignIn/>). Signed-in users see the existing My Tickets surface.
   - Make per-account on-device separation now: namespace the localStorage key by
     Clerk user id (e.g. `kbm.v4.<clerkUserId>.<lang>`) so two accounts on one
     device don't share logs. (Server persistence is Phase 2 — leave a TODO.)
   - On app load for a signed-in user, call POST /api/social/me with the Clerk
     session token (useAuth().getToken()) to upsert their profile; ignore failures
     gracefully (offline-first).

2. Social backend skeleton (NEW, isolated)
   - Create workers/social/ : a new Cloudflare Worker with its own wrangler config
     and a NEW D1 binding "keibamon_social" (do not reuse the racing D1).
   - Migration workers/social/migrations/0001_users.sql:
       users(
         id            TEXT PRIMARY KEY,      -- our id
         clerk_user_id TEXT UNIQUE NOT NULL,
         handle        TEXT,
         display_name  TEXT,
         avatar        TEXT,
         age_verified  INTEGER NOT NULL DEFAULT 0,
         created_at     INTEGER NOT NULL
       );
   - Endpoint GET/POST /api/social/me : verify the Clerk session JWT (Clerk JWKS
     via `jose`), then upsert and return the user's profile. Reject invalid/absent
     tokens with 401. Route it so it never collides with /api/live (use the
     /api/social/* prefix).

3. Age self-attestation (light, game framing)
   - On first sign-in, show a one-time "I'm 20 or older" confirm (checkbox +
     continue). Persist age_verified=1 in the users row and in Clerk
     publicMetadata. Keep the under-20 notice in the Footer regardless of this.
   - Do not block the app behind heavy verification; this is a self-attestation.

4. Secrets & setup (human-in-the-loop — prepare, don't guess)
   - I (the human) will create the Clerk app and the D1. Produce the exact
     commands and dashboard steps I need to run, including:
       * `wrangler d1 create keibamon_social` and where to paste the database_id.
       * Which env vars to set: VITE_CLERK_PUBLISHABLE_KEY (frontend build),
         CLERK_SECRET_KEY / CLERK_JWKS_URL or issuer (worker, via `wrangler secret`).
   - Put placeholders in .env.example and the wrangler config; never hardcode keys.

5. Tests
   - frontend: a vitest asserting signed-out users get the sign-in gate (mock
     Clerk), and that the localStorage key is namespaced by user id.
   - worker: a test for /api/social/me — 401 on missing/invalid token, 200 + upsert
     on a valid (mocked) token. Keep all existing tests green.

6. Docs
   - Write docs/runbooks/phase1-clerk-auth.md: setup, env vars, D1 create/migrate,
     local dev, deploy, rollback.
   - Update docs/adr/0007-my-tickets-social-surface.md: mark Phase 1 status and
     record any decisions you had to make (e.g., route prefix, JWT verification lib).

## Acceptance criteria
- Signed-out → sign-in screen; signed-in → My Tickets home.
- A new authenticated user appears as a row in keibamon_social.users with
  age_verified set after the 20+ confirm.
- Racing D1, /api/live, and the ingestion pipeline are untouched (show me the
  diff scope to prove it).
- `cd frontend && npm run build` succeeds; both test suites pass.
- No secrets committed; .env.example + runbook explain every key.

## Workflow
Work on a branch `feat/adr-0007-phase1-clerk`. Make small commits. When done,
summarize the diff, the commands I must run myself (Clerk + D1 + secrets), and any
follow-ups for Phase 2. Do not merge — open it for my review.
```
