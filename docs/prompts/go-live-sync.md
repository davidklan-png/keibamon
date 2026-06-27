# CLI agent prompt — front/back go-live sync (ADR-0007)

> Run on the **Mac** (mac-dev). The frontend (Phases 0–5) is deployed, but the
> backend is behind: the snapshot publisher is stale (last publish 2026-06-13,
> "DRY-RUN PING"), R1/R2 (result feed) are unmerged, and the social Worker isn't
> deployed — so committed tickets never settle. This prompt diagnoses and
> reconciles front↔back so settlement actually works end to end.

```
You are reconciling the Keibamon front/back deployment so committed tickets
settle in production. Read CLAUDE.md, docs/adr/0007-my-tickets-social-surface.md,
docs/r1-result-feed-brief.md, and docs/my-tickets-rollout.md first. Run
`python tools/whichdevice.py` — this MUST be mac-dev (has git, lake, scrape,
wrangler). If not, stop.

Settlement chain (so you know what "synced" means):
  publisher (tools/jravan/expose_live.py → publish_d1.py) writes a snapshot to
  D1 (live_snapshot, key='current') → Worker /api/live serves it → when a race
  carries status:'result' + a `result` block, the frontend auto-settle effect
  AND the social Worker cron sweep resolve OPEN tickets via the shared resolver.
  Today that chain is broken in THREE places. Fix them in order, verifying each.

## STEP 0 — Diagnose first, report before changing anything
Produce a short "sync report": current branch, `git status`, and:
  - curl -s https://keibamon.com/api/live | jq '.meta'   # how stale is published_at?
  - Are R1/R2 merged?  git merge-base --is-ancestor feat/adr-0007-r2-result-confirmation main
  - Is the social Worker deployed?  (wrangler deployments list in workers/social, or curl a social route)
Do not proceed to fixes until the report is printed.

## STEP 1 — Revive the snapshot publisher (HIGHEST PRIORITY)
Nothing settles (or even shows fresh odds) until this publishes again. Diagnose
why it stopped (last publish 2026-06-13):
  - launchctl list | grep -i keibamon  — is com.keibamon.expose-race loaded?
  - Inspect the plist's StandardOutPath/StandardErrorPath logs for errors.
  - CRED PREFLIGHT (known failure mode, see CLAUDE.md + memory): publish_d1.py
    reads os.environ["CF_*"] and fails SILENTLY per cycle if they're missing.
    Confirm CF_ACCOUNT_ID / CF_API_TOKEN (and any CF_D1_* the publisher needs)
    are present in the launchd environment, not just your interactive shell
    (setx-style persistence doesn't apply on macOS — source from a profile/file).
  - Run one cycle by hand to see real errors:
      PYTHONPATH=src python tools/jravan/expose_live.py --once   # (use the tool's real flags)
Fix the root cause (reload the agent / supply creds / repair the scrape). 
VERIFY: curl -s https://keibamon.com/api/live | jq '.meta.published_at' is now
recent, and races carry live runners/odds for the current card.

## STEP 2 — Merge R1/R2 and make /api/live emit result blocks
R2 contains R1 (R2 ⊇ R1) and is a clean merge onto main.
  - First remove the verification-layer temp files (cannot be deleted from the
    sandbox): rm -f workers/social/verify_r1.ts workers/social/test/r1_verify.spec.ts
  - Verify the branch: cd workers/social && npm ci && npm test ; cd - ;
    PYTHONPATH=src python -m pytest -q
  - Merge:  git checkout main && git merge --no-ff feat/adr-0007-r2-result-confirmation
            -m "Merge ADR-0007 R1+R2: /api/live result feed + 確定 gate"
  - Delete the merged branches with -d after `git branch --merged main` confirms.
Now the publisher (Step 1) will attach a `result` block for finished, 確定 races.
VERIFY against a race that has FINISHED today/this weekend:
  curl -s https://keibamon.com/api/live | jq '.races[] | select(.status=="result") | {race_no, result}'
  → a finished race shows status:"result" with placings + payouts. (If none have
  finished yet, this is correct — re-check after the next race confirms.)

## STEP 3 — Redeploy the main Worker + frontend (sync the served code)
splash/app is gitignored — a git push does NOT deploy it. Rebuild + deploy:
  - Set the Clerk key so the app gets past sign-in (without it the app loads but
    is stuck on the sign-in screen): ensure frontend/.env has
    VITE_CLERK_PUBLISHABLE_KEY=pk_live_… (see frontend/.env.example).
  - cd frontend && npm run build           # regenerates splash/app, hashes in sync
  - cd .. && npx wrangler deploy            # uploads splash/ + the /api/live Worker
VERIFY: curl -sI https://keibamon.com/app/assets/  (the JS referenced by
/app/index.html returns 200), and /app/ renders (not blank).

## STEP 4 — Deploy the social Worker (per-user persistence + cron sweep)
Without this, MyTickets runs in degraded localStorage/seed mode and "settlement"
only touches the local cache. In workers/social:
  - Apply D1 migrations to keibamon_social (local + remote):
      npx wrangler d1 migrations apply keibamon_social --remote
  - Set secrets (Clerk):  npx wrangler secret put CLERK_SECRET_KEY  (+ JWKS/issuer)
  - npx wrangler deploy
  - Confirm the cron sweep is scheduled (wrangler.jsonc triggers) — it's the
    backstop that settles tickets for users who are offline at post time.
VERIFY: an authenticated GET /api/social/me returns the user; the sweep run logs
show it reading /api/live and settling OPEN tickets on result races.
(If Clerk/social isn't ready to go live yet, SKIP this step and say so — Steps
1–3 already make the public app show fresh data; per-user settlement waits.)

## STEP 5 — Clear stale seed/demo tickets
The currently-stuck tickets reference a race (Tokyo R12, Jun 21) no longer in the
feed — they're localStorage seed/cache from an earlier snapshot and cannot
retroactively settle. Confirm they're seed data (ids like kb-seed-*) and clear
the demo seed path for signed-in users (Phase 2 already gates seeds to
signed-out — verify that's actually happening in the deployed build).

## STEP 6 — End-to-end proof
Document the synced state: fresh published_at, a finished race showing
status:"result" + result block, and a committed ticket on that race resolving to
won/miss/refunded via the auto-settle effect (and the sweep). 

## Constraints
- Don't touch the racing lake / PIT rules / recommender. Keep
  `PYTHONPATH=src python -m pytest -q` and the worker/frontend suites green.
- Commit on the Mac. Never print secrets. wrangler deploy requires the Mac to be
  `wrangler login`'d; D1/secret steps need my Cloudflare + Clerk credentials — if
  any are missing, stop at that step and tell me the exact command to run.

## Handback
The sync report (before), what was stale/broken and the root cause for each of
the three breaks, what you deployed, and the Step 6 end-to-end proof. List
anything you skipped for lack of credentials. Do not mark "all live" unless
/api/live is fresh AND a finished race settles a ticket.
```
