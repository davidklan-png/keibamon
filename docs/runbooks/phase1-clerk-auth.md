# Phase 1 — Clerk auth + social Worker

This stands up identity only: a Clerk app, an isolated D1 + Worker
(`keibamon_social`), and the frontend wiring that gates My Tickets behind
sign-in + a 20+ self-attestation. No ticket / follow / cheer persistence yet
(Phase 2). The racing Worker, `/api/live`, and `keibamon-live` D1 are **not
modified**.

The social Worker deploys to a **separate origin** (its `*.workers.dev`
subdomain for Phase 1). The frontend targets it via `VITE_SOCIAL_API_BASE`.
CORS is handled in the social Worker.

## What lives where

| Concern | Where |
|---------|-------|
| Frontend code | `frontend/src/auth/*`, `frontend/src/main.tsx`, `frontend/src/App.tsx` |
| Frontend env | `frontend/.env` (`VITE_CLERK_PUBLISHABLE_KEY`, `VITE_SOCIAL_API_BASE`) |
| Worker code | `workers/social/src/index.ts` |
| Worker env | `workers/social/.dev.vars` (local) + Wrangler secrets (prod) |
| D1 schema | `workers/social/migrations/0001_users.sql` |
| Racing tier | UNCHANGED — `wrangler.jsonc`, `src/worker.js`, `/api/live`, `keibamon-live` |

## 1. Create the Clerk app

1. Sign up / sign in at https://dashboard.clerk.com.
2. Create an application ("Keibamon"). Enable Email + at least one social
   connection (Google, Apple, etc.) as desired.
3. From **API Keys**, copy:
   - **Publishable key** (`pk_...`) → `frontend/.env` as
     `VITE_CLERK_PUBLISHABLE_KEY`.
   - **Frontend API URL** (looks like
     `https://<frontend-api>.clerk.accounts.dev`) → use this verbatim as the
     Worker's `CLERK_ISSUER`. No trailing slash.

## 2. Configure the frontend

```bash
cp frontend/.env.example frontend/.env
# then edit:
#   VITE_CLERK_PUBLISHABLE_KEY=pk_...
#   VITE_SOCIAL_API_BASE=http://127.0.0.1:8787   # local wrangler dev
```

Builds must NOT hard-crash without a key. If `VITE_CLERK_PUBLISHABLE_KEY` is
empty, dev prints a one-liner warning and the app renders without a Clerk
session (the sign-in screen is reachable but sign-in is a no-op).

## 3. Create the social D1

```bash
cd workers/social
npx wrangler d1 create keibamon_social
```

Paste the printed `database_id` into `workers/social/wrangler.jsonc` (replace
the `<run: ...>` placeholder). Then apply the migration:

```bash
npx wrangler d1 execute keibamon_social --remote \
  --file migrations/0001_users.sql --yes
```

For local dev, also create the local shadow DB:

```bash
npx wrangler d1 execute keibamon_social --local \
  --file migrations/0001_users.sql --yes
```

## 4. Configure Worker secrets

Local:

```bash
cp workers/social/.dev.vars.example workers/social/.dev.vars
# then edit:
#   CLERK_ISSUER=https://<frontend-api>.clerk.accounts.dev
#   ALLOWED_ORIGINS=http://localhost:5173,https://keibamon.com
```

Prod:

```bash
cd workers/social
npx wrangler secret put CLERK_ISSUER        # paste the issuer URL
npx wrangler secret put ALLOWED_ORIGINS      # e.g. https://keibamon.com
# (CLERK_SECRET_KEY not needed in Phase 1 — age_verified lives in the D1 row,
# not Clerk publicMetadata. Leave it unset.)
```

## 5. Local dev (two terminals)

| Terminal | Command | Serves |
|----------|---------|--------|
| 1 | `cd frontend && npm run dev` | Vite app on http://127.0.0.1:5173 |
| 2 | `cd workers/social && npm run dev` | Worker on http://127.0.0.1:8787 |

In `frontend/.env`, set `VITE_SOCIAL_API_BASE=http://127.0.0.1:8787` so the
app talks to the local Worker. The Worker's `ALLOWED_ORIGINS` must include
`http://localhost:5173`.

## 6. Deploy

```bash
cd workers/social
npx wrangler deploy
# Note the printed URL, e.g. https://keibamon-social.<your-subdomain>.workers.dev
```

Then update the frontend build with that URL:

```bash
# frontend/.env (or your CI environment)
VITE_SOCIAL_API_BASE=https://keibamon-social.<your-subdomain>.workers.dev
```

```bash
cd ../..   # repo root
npm --prefix frontend test
npm --prefix frontend run build
npx wrangler deploy   # the racing Worker picks up the new bundle
```

## 7. Verify

- Visit the deployed app → My Tickets home should show the sign-in screen.
- Click "Continue with email or social" → Clerk modal opens.
- After sign-in → age gate appears. Confirm 20+.
- Land on My Tickets. Open devtools: a `POST /api/social/me` to the social
  Worker returned 200 with `age_verified:1`.
- Reload → the age gate is skipped (the cached flag in localStorage + the
  upserted D1 row agree).

## Rollback

The Phase 1 surface is opt-in via env vars. To disable:

1. Unset `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_SOCIAL_API_BASE` in the
   frontend build, redeploy the racing Worker. App renders without auth.
2. Set the Worker to "disabled" in the Cloudflare dashboard, or delete the
   `keibamon-social` deployment. The D1 row stays but is inert.
3. The Clerk app can be paused from its dashboard if needed.

## Common gotchas

- **Clerk JWT issuer mismatch.** `CLERK_ISSUER` must EXACTLY match the `iss`
  claim in the Clerk JWT — including `https://`, no trailing slash. Mismatch
  → all requests return 401.
- **CORS blocked.** The browser origin must be on the Worker's
  `ALLOWED_ORIGINS` list. Add `http://localhost:5173` for local dev.
- **Forgot to paste the D1 id.** If `wrangler.jsonc` still has
  `<run: ...>`, `wrangler deploy` will fail with a confusing error about the
  database. Create the D1 first (step 3).
- **Forgot to run the migration remotely.** `--local` only seeds the shadow
  DB on your laptop; the prod Worker still sees an empty schema. Always run
  `--remote` for prod.
- **Frontend built without `VITE_SOCIAL_API_BASE`.** `socialClient.postMe`
  then posts to the racing Worker origin, which 404s. The frontend swallows
  the failure (offline-first), but the upsert never lands.
- **Racing tier drift.** Do NOT edit `wrangler.jsonc`, `src/worker.js`, or
  `/api/live` from this branch. If a change is needed, raise it separately.
  `git diff main...HEAD --stat` should show only `frontend/`,
  `workers/social/`, `docs/`, and the two `.env.example` files.

## Phase 2 follow-ups (out of scope)

- Move committed-ticket persistence to the social D1; localStorage becomes an
  offline cache.
- Replace the localStorage age-verified flag with a `GET /api/social/me` fetch
  in `AuthProvider` (canonical source = the D1 row).
- Custom domain `social.keibamon.com` (currently `*.workers.dev`).
- Rate limits on POSTs.
