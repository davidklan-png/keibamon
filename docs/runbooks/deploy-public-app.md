# Deploy keibamon.com/app

`keibamon.com/app` is served by the Cloudflare Worker in `wrangler.jsonc`.
The Worker serves static assets from `splash/` and handles `/api/live` by reading
the `live_snapshot` row `key='current'` from the `keibamon-live` D1 database.

There are two production surfaces:

1. the React app bundle under `splash/app`;
2. the live race snapshot in D1.

Both have to be current for the public app to look right.

## Frontend assets

From the repo root:

```bash
npm --prefix frontend test
npm --prefix frontend run build
npx wrangler deploy
```

The Vite build writes to `splash/app` (`frontend/vite.config.ts`). Wrangler then
uploads `splash/` and redeploys the `keibamon` Worker.

Verify the deployed app:

```bash
curl -sS https://keibamon.com/app/ | rg '/app/assets/index-.*\.(js|css)'
asset=$(curl -sS https://keibamon.com/app/ |
  sed -n 's/.*src="\([^"]*index-[^"]*\.js\)".*/\1/p')
curl -sS "https://keibamon.com${asset}" |
  rg 'Popular races|date-chip|race-card|Manual Odds|Intuition'
```

Expected for the current race picker: `Popular races`, `date-chip`, and
`race-card` are present; `Manual Odds` and `Intuition` are absent.

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
