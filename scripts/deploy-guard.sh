#!/usr/bin/env bash
# Guarded manual deploy — fallback for when you must deploy by hand instead of CI.
#
# Refuses to deploy a stale or unbuilt tree (the exact thing that 404'd /app/):
#   - working tree must be clean
#   - HEAD must equal origin/main (no deploying a local-only or behind checkout)
#   - rebuilds the SPA into splash/app from the CURRENT commit before deploying
#
# Normal path is CI (.github/workflows/deploy.yml on push to main). Use this only
# for an out-of-band hotfix, and prefer reverting + pushing to main instead.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ fetching origin/main"
git fetch -q origin main

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ working tree is dirty — commit or stash before deploying." >&2
  exit 1
fi

HEAD_SHA="$(git rev-parse HEAD)"
ORIGIN_SHA="$(git rev-parse origin/main)"
if [ "$HEAD_SHA" != "$ORIGIN_SHA" ]; then
  echo "✗ HEAD ($HEAD_SHA) != origin/main ($ORIGIN_SHA)." >&2
  echo "  Deploy only what's on main. Pull/rebase or push first." >&2
  exit 1
fi

: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"

echo "→ building SPA into splash/app from $HEAD_SHA"
( cd frontend && npm run build )

echo "→ wrangler deploy"
npx wrangler deploy

code=$(curl -s -o /dev/null -w "%{http_code}" https://keibamon.com/app/)
echo "/app/ → $code"
test "$code" = "200" && echo "✓ live" || { echo "✗ /app/ not 200" >&2; exit 1; }
