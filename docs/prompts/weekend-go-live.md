# CLI agent prompt — weekend go-live for the Jun 27–28 G3s

> Run on the **Mac** (mac-dev: git, lake, scrape, wrangler login, CF creds).
> Goal: by tomorrow the public app shows fresh data for this weekend's two G3s
> (Radio Nikkei Sho, Fukushima 1800m + the second G3 on the card), David and his
> friend can sign in, follow each other, and register/edit tickets that persist
> and settle. The Cowork/Claude agent (sandbox) is the **verifier** — it can
> query the live D1 directly via the Cloudflare connector — see Handback.
>
> NOTE vs the older go-live-sync.md: R1–R4 (the /api/live result feed + 確定
> gate) are ALREADY merged to main (see git log). So the three remaining breaks
> are (1) stale publisher, (2) social Worker maybe undeployed, (3) served code
> behind. Don't re-merge R1/R2.

```
You are reconciling the Keibamon front/back deployment so the two Jun 27–28 G3s
are live and committed tickets persist + settle. Read CLAUDE.md,
docs/adr/0007-my-tickets-social-surface.md, and docs/runbooks/deploy-public-app.md
first. Run `python tools/whichdevice.py` — MUST be mac-dev. If not, stop.

Settlement chain (what "live" means): expose_live.py → publish_d1.push_to_d1
writes live_snapshot (D1 keibamon-live, key='current') → Worker /api/live serves
it → frontend renders + auto-settles, and the social Worker cron sweep settles
OPEN tickets for offline users. Fix in order; verify each before moving on.

## STEP 0 — Diagnose, report BEFORE changing anything
  - git branch, git status
  - Freshness: curl -s https://keibamon.com/api/live | jq '.meta'  (how old is
    published_at / updated_at?)
  - Are the weekend G3s in the feed yet?
        curl -s https://keibamon.com/api/live | jq '.races[] | {race_no,name,venue,status}'
  - Publisher loaded?  launchctl list | grep -i keibamon ; inspect the
    expose-race plist StandardOut/Err logs for the last error.
  - Social Worker deployed?  cd workers/social && npx wrangler deployments list
        (or curl an authed /api/social/me). 
Print the report. Do not proceed until it's printed.

## STEP 1 — Revive the publisher (HIGHEST PRIORITY; nothing else matters if stale)
Known silent-failure mode (CLAUDE.md + memory): publish_d1.py reads
os.environ["CF_*"] and fails SILENTLY per cycle if missing; setx-style
persistence doesn't apply on macOS — source CF_ACCOUNT_ID / CF_API_TOKEN /
CF_D1_* from a profile/file, and confirm they're in the LAUNCHD environment, not
just your shell. Then run one cycle by hand to see real errors:
    PYTHONPATH=src ./venv64/bin/python tools/jravan/expose_live.py --once
Fix root cause (creds / reload agent / repair scrape). Entries publish Friday
(memory: special G1s Thu ~14:00) so the G3 cards should be discoverable now/by
Fri. VERIFY: curl /api/live shows a recent published_at AND both G3s present
with runners (grayed + estimated odds until the pool opens — that's correct
pre-race per ADR-0006).

## STEP 2 — Deploy the social Worker (per-user tickets + cron settle sweep)
Without it, My Tickets runs in degraded localStorage mode and David's + his
friend's tickets won't persist server-side or settle for an offline user.
In workers/social:
  - npx wrangler d1 migrations apply keibamon_social --remote   (then --local)
  - Set Clerk secrets: npx wrangler secret put CLERK_SECRET_KEY (+ JWKS/issuer
    vars the code reads — grep src/index.ts)
  - npx wrangler deploy ; confirm triggers.crons (the settle sweep) is scheduled
VERIFY: an authed GET /api/social/me returns the user; a sweep log shows it
fetching /api/live. If Clerk live keys aren't ready, STOP here and tell David
the exact secret commands — don't ship a half-authed worker.

## STEP 3 — Redeploy main Worker + frontend (sync served code)
splash/app is gitignored; a git push does NOT deploy it. Rebuild + deploy:
  - frontend/.env: VITE_CLERK_PUBLISHABLE_KEY=pk_live_… (see .env.example) — w/o
    it the app loads stuck on sign-in.
  - cd frontend && npm run build      # regenerates splash/app, asset hashes sync
  - cd .. && npx wrangler deploy      # uploads splash/ + the /api/live Worker
VERIFY: curl -sI the JS asset referenced by /app/index.html returns 200, and
/app/ renders (not blank).

## STEP 4 — Friend setup (follow-based; this is the chosen "with my friend" model)
The app's friend model is follow-based: you each register your own tickets and
see each other's on a race via the friends-on-race / friends-on-card strip
(/api/social/friends/on-card). So:
  - David and friend each sign in (Clerk), set a handle (PATCH/POST per
    src/index.ts handle route), and follow each other
    (POST /api/social/follows).
VERIFY: GET /api/social/races/<g3-raceKey>/friends returns the friend once they
have a ticket on that race; the app's friends strip shows their avatar.

## STEP 5 — End-to-end proof
Register a small test ticket on a G3 from David's account; confirm it persists
(GET /api/social/me or the tickets route shows it) and the friends strip surfaces
it to the friend. Full settlement completes after the race confirms (確定) — the
auto-settle effect + cron sweep resolve it; note that it's pending until then.

## Constraints
- Don't touch the racing lake / PIT rules / recommender. Keep
  PYTHONPATH=src python -m pytest -q and the worker/frontend suites green.
- Commit on the Mac. Never print secrets. wrangler deploy needs the Mac to be
  `wrangler login`'d; D1/secret steps need David's Cloudflare + Clerk creds — if
  any are missing, STOP at that step and print the exact command for David.

## Handback to the verifier (Cowork/Claude, sandbox)
Report the Step-0 report, the root cause of each break, what you deployed, and
the Step-5 proof. The verifier will independently confirm from the sandbox by
querying the live D1 through the Cloudflare connector:
  - read live_snapshot key='current' from the keibamon-live DB and check
    published_at freshness + that both G3s + runners are present;
  - confirm the social DB has the migrations applied and the test ticket row.
Do NOT mark "all live" unless /api/live is fresh AND a test ticket persists.
Mark "ready for verification" and list anything skipped for missing creds.
```
