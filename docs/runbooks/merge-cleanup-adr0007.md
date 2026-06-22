# Runbook — finish merge, sync & clean up ADR-0007 (run on the Mac)

State confirmed 2026-06-21 (after Phase 5 landed) from committed history:
- `main` = Phases 0–4 (it was fast-forwarded to the phase4 tip) **but is 20
  commits ahead of `origin/main` — never pushed.**
- `feat/adr-0007-phase5-visual-regression` = `main` + 8 (clean merge; `main` is an
  ancestor). **Not merged.**
- `fix/jravan-rt-date-extraction` = the USB/0B30 fix. **Not merged** (main went to
  phase4 on a different line).
- `feat/adr-0007-phase1..4` branches still exist and are now **ancestors of main**
  (fully merged) → safe to delete.
- Program docs (rollout, prompts, r1 brief, close-out, this runbook) are
  **uncommitted** in the working tree.
- Branches have **no upstream** → almost certainly **no remote PRs**.

Do this on **mac-dev** (`python tools/whichdevice.py`). Don't skip the gates.

```bash
cd <repo>                         # /Users/dklan/projects/personal/Keibamon
git fetch origin
git status                        # AUTHORITATIVE — trust this over any notes
git branch --merged main          # phase1..4 should already be listed here

# 0. Stash loose program docs so branch switches stay clean.
mkdir -p /tmp/adr7-docs
cp docs/my-tickets-rollout.md docs/r1-result-feed-brief.md \
   docs/adr/0007-open-items-closeout.md docs/runbooks/merge-cleanup-adr0007.md /tmp/adr7-docs/ 2>/dev/null
cp -r docs/prompts /tmp/adr7-docs/prompts
# If `git status` shows a stale untracked workers/ (real copy is committed on main
# now), it should match — only remove it if it blocks a checkout/merge.

# 1. Verify phase5 before merging.
git checkout feat/adr-0007-phase5-visual-regression
( cd frontend && npm ci && npm test && npm run build )   # 105 unit tests
( cd frontend && npm run test:visual )                   # 14 Playwright baselines
PYTHONPATH=src python -m pytest -q                        # racing tier untouched

# 2. Merge phase5 (the visual-regression + extraction work).
git checkout main
git merge --no-ff feat/adr-0007-phase5-visual-regression \
  -m "Merge ADR-0007 Phase 5: App.tsx extraction + visual-regression baselines"

# 3. Merge the racing-tier USB fix (disjoint paths; conflicts unlikely).
git merge --no-ff fix/jravan-rt-date-extraction \
  -m "Merge jravan-rt 0B30 date extraction (post-USB ingest)"

# 4. Restore + commit the loose program docs.
cp /tmp/adr7-docs/my-tickets-rollout.md /tmp/adr7-docs/r1-result-feed-brief.md \
   /tmp/adr7-docs/0007-open-items-closeout.md docs/adr/ 2>/dev/null
cp /tmp/adr7-docs/my-tickets-rollout.md docs/ 2>/dev/null
cp /tmp/adr7-docs/r1-result-feed-brief.md docs/ 2>/dev/null
cp /tmp/adr7-docs/merge-cleanup-adr0007.md docs/runbooks/ 2>/dev/null
cp -r /tmp/adr7-docs/prompts/* docs/prompts/ 2>/dev/null
git add docs/my-tickets-rollout.md docs/r1-result-feed-brief.md \
        docs/adr/0007-open-items-closeout.md docs/runbooks/merge-cleanup-adr0007.md \
        docs/prompts/*.md
git commit -m "docs(adr-0007): rollout plan, phase prompts, R1 brief, open-items close-out"

# 5. Final verification on merged main.
( cd frontend && npm test && npm run build && npm run test:visual )
( cd workers/social && npm ci && npm test )
PYTHONPATH=src python -m pytest -q

# 6. SYNC — push everything (this is the step that was missing).
git push origin main

# 7. Confirm containment, then delete the merged local branches.
git branch --merged main          # phase1..5 + jravan must all appear
git branch -d feat/adr-0007-phase1-clerk feat/adr-0007-phase2-persistence \
              feat/adr-0007-phase3-social feat/adr-0007-phase4-hardening \
              feat/adr-0007-phase5-visual-regression fix/jravan-rt-date-extraction

# 8. Only if any were ever pushed (check GitHub): delete remotes + close PRs.
# git push origin --delete <branch>
```

## Safety notes
- **Never `git branch -D` (force)** until step 7's `--merged` list shows the
  branch — `-d` refusing is the guardrail you want.
- If branch protection / required checks guard `origin/main`, the push in step 6
  is rejected — open a PR from a temp branch and let CI gate it instead.
- Visual baselines are **chromium-darwin only**; run `npm run test:visual` on a
  Mac so they match. To change them intentionally: `npm run test:visual:update`.
- If step 3 conflicts, it's `tools/jravan` vs nothing app-side — keep the jravan fix.

## After the sync
With `origin/main` carrying Phases 0–5 + the USB fix, the **only open item is R1**
(`docs/r1-result-feed-brief.md`) — the racing-tier result feed that turns on real
settlement. Everything else is closed (see `docs/adr/0007-open-items-closeout.md`).
