# Weekend orchestration — who does what, and the verifier contract

Two CLI-agent prompts do the build/deploy on the **Mac**; the **Cowork/Claude
agent** (Linux sandbox) is the verifier. David runs the irreversible steps.

## Order to run (Wed → race day Sun Jun 28)
1. **`weekend-go-live.md`** FIRST. The app must show fresh data for the two G3s
   before anything else is useful. This is mostly deploy/ops on the Mac.
2. **`horse-jockey-form-lookup.md`** in parallel/after. It's a code build on a
   branch (feat/weekend-form-lookup) and does NOT need to block go-live; it ships
   when the verifier signs off. David accepted it may not be 100% by Saturday —
   horse form ships first, jockey form may trail (see the JOCKEY GAP note).

## Why this split (the durable decision)
- The sandbox **cannot** `wrangler deploy`, `git push/commit`, apply D1
  migrations via CLI, or import the USB — all Mac-only. So irreversible/secret
  steps live in the CLI-agent prompts and David executes them.
- The sandbox **can** verify cheaply and independently: run the full test
  suites, review diffs, rebuild the form mart from silver and recompute numbers,
  and query the **live D1 directly via the Cloudflare connector**. That's a real
  second pair of eyes that isn't just trusting the builder's own output.

## Verifier contract (what the Cowork agent does on each handback)
After the CLI agent pushes a branch / reports, hand it back to the Cowork agent.
It will:

**For the form feature (branch feat/weekend-form-lookup):**
- `PYTHONPATH=src python -m pytest -q` and `npm --prefix frontend test` — green.
- Review the full diff for: PIT leaks (available_at filter present and correct),
  any aggregation on horse_id (must be horse_name), guardrail copy.
- Rebuild the mart from silver and independently recompute one horse's last-5
  and one jockey's win% — confirm they match the API output.
- Craft an `as_of` mid-history and prove rows after it are excluded.
- Sign-off = "verified, safe to merge + deploy" OR a specific defect list.

**For go-live:**
- Query the keibamon-live D1 via the Cloudflare connector: read live_snapshot
  key='current', check published_at freshness and that both G3s + runners exist.
- Confirm the social DB migrations applied and the test ticket row persists.
- Sign-off = "live verified" only if fresh AND a ticket persisted.

## What David runs (irreversible — never delegated to either agent silently)
- `git merge` / `git push` on the Mac after verifier sign-off.
- `npx wrangler deploy` (main + social workers), `d1 migrations apply --remote`,
  `wrangler secret put` — these need David's Cloudflare/Clerk creds.
- Sign-in for both accounts + the mutual follow.

## Job-health dashboard
Deferred by decision. Interim freshness check David can run any time:
    curl -s https://keibamon.com/api/live | jq '.meta.published_at, (.races|length)'
If `published_at` is stale (older than ~a few minutes during a race day), the
publisher has silently died — re-check CF_* creds / the expose-race launchd job
(weekend-go-live.md STEP 1). The real dashboard is next week's build.
```
