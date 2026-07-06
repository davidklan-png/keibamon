# CLI agent prompt — #11 + #14: close the two Playwright coverage gaps

> Runs on the **Mac** (mac-dev — the visual suite needs the real vite/esbuild
> binaries the sandbox can't run). Prepared by the Cowork/Claude agent
> (sandbox) 2026-07-06; paths verified that day. One session, two commits
> (one per issue).

```
Read CLAUDE.md first. Run `python tools/whichdevice.py` — MUST be mac-dev.
Both issues are test-infrastructure only — zero product-behavior change
intended. Any product code you touch must be provably dead in prod builds.

## PART A — #11: CI pixel coverage for signed-out UI

Today the whole visual suite boots signed-in: playwright.config.ts line ~41
bakes VITE_PLAYWRIGHT_BYPASS_AUTH=1 into the webServer command, and
AuthProvider.tsx's PLAYWRIGHT_VALUE (line ~79) hard-codes isSignedIn:true.
So the ADR-0013 signed-out My Tickets empty state ("sign in to save your
marks", frontend/src/screens/MyTicketsEmpty.tsx) and the signed-out account
slot (ADR-0012 bottom tab bar) have ZERO regression protection — a refactor
could break the surface that motivates the ADR-0018 cross-device-sync
promise and CI would stay green.

### Recommended mechanism (per-test runtime flag, no second webServer)

Inside the PLAYWRIGHT_BYPASS branch ONLY, read a runtime flag — e.g.
localStorage "kbm.pw.signedout" === "1" (set via page.addInitScript before
goto, same pattern the specs already use for keibamon.lang) — and serve a
signed-out AuthState (isSignedIn:false, userId:null, clerkMounted:false,
getToken → null; openSignIn can stay a no-op). Prod builds never set
VITE_PLAYWRIGHT_BYPASS_AUTH, so the branch stays dead code there — preserve
the existing "constant at module load / Rules of Hooks" property (read the
flag once, not per-render).

Fallback if that turns out unclean: a second Playwright project + webServer
without the env var. It doubles CI boot time — only go there if the flag
approach genuinely can't work, and say why in the handback.

### New specs (frontend/tests/visual/visual.spec.ts, en + ja like the rest)

  - signed-out My Tickets empty state — BOTH variants MyTicketsEmpty renders:
    zero local marks (gentle variant) and ≥1 local marks (the N-horses/M-races
    teaser; seed the localStorage impression store via addInitScript —
    check src/lib/impressions.ts for the exact kbm.impressions.v1 shape).
  - signed-out tab bar / account slot visible in those captures (assert the
    sign-in affordance exists, not just pixels).
  - Keep the frozen-clock + installApiMocks prologue so captures stay
    deterministic; /api/social calls must not be reached signed-out (no
    Authorization header exists) — assert none fire if cheap to do.

## PART B — #14: fixtures missing surface/distance → race-context bar unexercised

The ADR-0017 RaceContextBar (frontend/src/components/RaceContextBar.tsx)
renders venue · R# · surface/distance · status — but the fixture race in
frontend/tests/visual/fixtures.ts (FIXTURE_SNAPSHOT, ~line 30) never sets
`surface` / `distance_m`, so every baseline shows the bar with those segments
omitted and a regression in the formatter would pass CI.

  - Add to the fixture race: surface: "turf", distance_m: 2000. Check
    frontend/src/api.ts LiveRace (~line 35-58) for exact field names first;
    if `going` has landed on LiveRace by the time you run (it was
    prop-only-optional at ADR-0017 time), set it too and note it.
  - Add an explicit locator assertion in one race-step test per lang that the
    bar renders the localized pair — en "turf 2000m" (space), ja "芝2000m"
    (no space — CJK joiner, see ADR-0017). Pixel diffs alone rot when
    baselines get regenerated wholesale; the text assertion is the durable
    net.
  - Regenerate affected baselines (npm run test:visual -- --update-snapshots)
    and EYEBALL every diff: the only change must be the context-bar segment
    appearing. Any other drift = stop and report.

## Verification
  cd frontend && npx tsc --noEmit && npm test && npm run test:visual
  All green, new baselines committed. Two commits: "test(visual): signed-out
  coverage (fixes #11)" and "test(visual): surface/distance fixtures +
  context-bar assertion (fixes #14)".

## Constraints
- No behavior change outside the PLAYWRIGHT_BYPASS branch. If the signed-out
  flag forces edits to AuthProvider's signed-in bypass path, stop and report.
- Don't "fix" unrelated baseline drift you notice — report it.

## Handback to the verifier (Cowork/Claude, sandbox)
Report: AuthProvider diff (with the prod-dead-code argument spelled out),
the new spec list, before/after baseline images for the signed-out captures
and one context-bar capture, full test output, commit hashes.
```
