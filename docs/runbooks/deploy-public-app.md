# Deploy keibamon.com/app

`keibamon.com/app` is served by the Cloudflare Worker in `wrangler.jsonc`.
The Worker serves static assets from `splash/` and handles `/api/live` by reading
the `live_snapshot` row `key='current'` from the `keibamon-live` D1 database.

There are two production surfaces:

1. the React app bundle under `splash/app`;
2. the live race snapshot in D1.

Both have to be current for the public app to look right.

## Definition of done — verify against the live URL (NON-NEGOTIABLE)

A deploy or publish task is **not done** until it is confirmed against the
**deployed endpoint**, not a local build, a `/tmp` artifact, or your own
re-fetch into a file. The only acceptance signal is what
`https://keibamon.com/...` actually returns to a fresh request.

This rule exists because it has been violated repeatedly: handbacks have
reported "36 races published / settlement proven" while the deployed
`/api/live` still served a truncated 32-race card — the agent had verified
against `/tmp/proof/*.json` and a local build, not the live Worker. A publish
that advances `meta.published_at` while the card stays broken is the trap:
**a fresh timestamp is not a fresh card.**

Required for every publish/deploy — copy-paste and read the output:

```bash
# Snapshot publish — assert freshness AND completeness, cache-busted:
curl -s 'https://keibamon.com/api/live?key=current&_cb='$(date +%s) \
  | jq '{published_at:.meta.published_at, n:([.races[].race_id]|length)}'
# n must equal the EXPECTED race count for the day, not just ">= last time".
# Spot-check the specific races you claim to have fixed are actually present:
curl -s 'https://keibamon.com/api/live?key=current' \
  | jq '[.races[].race_id] | map(select(test("-05-")))'   # e.g. all of Tokyo

# App bundle — assert the deployed index.html's hashed JS returns 200:
curl -s https://keibamon.com/app/ | grep -o 'assets/index-[^"]*\.js' \
  | head -1 | xargs -I{} curl -s -o /dev/null -w '%{http_code}\n' https://keibamon.com/app/{}
```

If the deployed URL doesn't show the change, the task is **open** — regardless
of green local tests, a clean `git status`, or a successful-looking
`wrangler deploy` / publish log. Do not report success from anything other than
the live URL.

## Publish (deploy)

**A git push is not a deploy.** Pushing or merging to `main` syncs source to
GitHub; it does NOT update the live Worker. The `keibamon.com/app` bundle is
whatever `splash/app/` was last uploaded by `npx wrangler deploy` from the
Mac. There is no CI hook and no auto-deploy on push — if you skip
`wrangler deploy`, production stays on the old bundle indefinitely and
nobody will tell you. `git status` clean ≠ published.

### Clerk-key build requirement (the silent-failure trap)

`npm --prefix frontend run build` reads `frontend/.env` at build time and
inlines `VITE_CLERK_PUBLISHABLE_KEY` into the JS bundle
(`frontend/src/main.tsx:12`, `frontend/src/auth/AuthProvider.tsx:60`). That
file is **gitignored** (`.gitignore:42` ignores `.env*`; only `.env.example`
is excepted), so:

- A fresh clone has no `frontend/.env`. The build SUCCEEDS, the bundle
  deploys, and the asset-hash check below still passes — but the auth gate
  renders signed-out and every authenticated social-Worker call rejects.
  This is the silent failure: well-formed deploy, broken app.
- A branch switch across worktrees can leave `frontend/.env` pointing at a
  different Clerk instance (test vs prod `pk_…` key). Same trap, subtler.

Preflight before every publish — fails loud if the key is missing or
unfilled:

```bash
test -f frontend/.env && grep -q '^VITE_CLERK_PUBLISHABLE_KEY=pk_' frontend/.env \
  || echo "MISSING: cp frontend/.env.example frontend/.env and fill in the pk_ key"
```

Because the bundle passes the asset check regardless, ALSO load
`https://keibamon.com/app/` in a browser after each publish and confirm
the sign-in render appears (not the signed-out fallback).

### Publish command

From the repo root, on the branch you want live:

```bash
npm --prefix frontend test       # vitest + Playwright visual baselines
npm --prefix frontend run build  # writes splash/app/, inlines the Clerk key
npx wrangler deploy              # uploads splash/ to the keibamon Worker
```

The Vite build writes to `splash/app` (`frontend/vite.config.ts`). Wrangler
then uploads `splash/` and redeploys the `keibamon` Worker.

`wrangler deploy` reads `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
(the new env var names). `CF_API_TOKEN` / `CF_ACCOUNT_ID` still work but
warn at startup. The Python `push_to_d1` publisher still reads `CF_*`
directly — different path, see ## Live race snapshot.

### Verify the publish

```bash
# Asset hash matches the locally-built bundle
curl -sS https://keibamon.com/app/ | rg '/app/assets/index-.*\.(js|css)'

# Bundle content (cheap regression check)
asset=$(curl -sS https://keibamon.com/app/ |
  sed -n 's/.*src="\([^"]*index-[^"]*\.js\)".*/\1/p')
curl -sS "https://keibamon.com${asset}" |
  rg 'Popular races|date-chip|race-card|Manual Odds|Intuition'
```

Expected for the current race picker: `Popular races`, `date-chip`, and
`race-card` are present; `Manual Odds` and `Intuition` are absent. Then
do the in-browser sign-in check above — the curl checks can't see the
Clerk-key regression.

## Live race snapshot

The app never reads the local lake. It only reads:

```text
https://keibamon.com/api/live -> D1 live_snapshot[key='current'].payload
```

The snapshot must include per-race `date` and `grade_label` so the app can show
race days correctly and surface graded races first.

Normal publish path, from the Mac:

```bash
PYTHONPATH=src venv64/bin/python tools/jravan/expose_live.py \
  --dates 20260620,20260621 \
  --once \
  --key current
```

Required credentials are:

```text
CF_ACCOUNT_ID
CF_D1_DATABASE_ID
CF_API_TOKEN
```

For scheduled publishing, put them in `~/.keibamon/cf.env` (`chmod 600`) because
launchd/cron shells do not inherit interactive shell env reliably. The wrapper
`tools/jravan/expose_live_once.sh` sources that file.

Useful manual verification:

```bash
curl -sS https://keibamon.com/api/live | node -e '
let s="";
process.stdin.on("data", d => s += d).on("end", () => {
  const j = JSON.parse(s);
  console.log(JSON.stringify({
    meta: j.meta,
    races: j.races?.length,
    dates: [...new Set((j.races || []).map(r => r.date || j.meta?.date || null))],
    graded: (j.races || [])
      .filter(r => r.grade_label)
      .map(r => ({
        date: r.date,
        venue: r.venue,
        race_no: r.race_no,
        name: r.name,
        grade_label: r.grade_label,
        status: r.status
      }))
  }, null, 2));
})'
```

## Emergency D1 fallback

Wrangler can update D1 directly:

```bash
npx wrangler d1 execute keibamon-live --remote --file /tmp/snapshot.sql --yes
```

Use this only for small emergency payloads. A full two-day card can exceed the
CLI literal SQL limit and fail with `SQLITE_TOOBIG`. The normal
`expose_live.py` publisher uses Cloudflare's parameterized D1 API and is the
right path for full-card multi-date snapshots.

If using the fallback, keep the payload small enough for the SQL route and
verify `/api/live` immediately afterward.
