# Keibamon UX rebuild — implementation plan & handoff loop

**Companion to `docs/ux-audit-netkeiba.md`. June 28, 2026.**

This turns the audit into discrete **sessions**, each of which is **one commit**. Work is done by a CLI agent in the sandbox working tree (which is the Mac repo, mounted), verified by me, and committed by David on the Mac. Nothing is pushed without David's sign-off.

## Codebase grounding (what's already true)

The audit's recommendations are cheaper than they look because the architecture already leans the right way:

- **Three destinations already exist** as `App.tsx`'s `view` enum (`"browse" | "mine" | "reference"`). The bottom tab bar is a *remap* of existing state, not a new router.
- **The impression/marks store is already the shared spine** (`lib/impressions.ts`), threaded through `RaceScreen`, `ReferenceScreen`, and `ExplainScreen` with `impressions` + `onSetImpressions`. "Marks flow into tickets" is mostly wiring that exists — `deriveIntuitionRecord()` already rebuilds the recommender's view from the store on every regen.
- **Marks persist locally** via `impressions.ts` (localStorage, best-effort). The anonymous-then-merge path is therefore an *addition*, not a storage rewrite.
- **Clerk is isolated** in `auth/` with a clean `useAuth()` surface (`isSignedIn`, `openSignIn`, `clerkMounted`, `getToken`). The UserButton is already last in the header.
- **Style is already optional** in the data flow (`standardTickets()` jumps past it; auto-regen never dead-ends). Demoting it out of the linear spine is a UI change, not a logic change.

The genuinely new work is narrow: (1) decouple the `funnel` lane from `view` so lanes become an in-screen control, (2) inline mark-setting on the runner *row* (today a mark requires drilling into `HorseDrillView`), (3) the merge-on-sign-in path, and (4) the `/api/live` surface/distance field for the context bar (a backend touch).

Tests are the verification surface: `frontend` runs `vitest` (`npm test`) incl. `app.snapshot.test.tsx`, `lane.test.tsx`, `crossSurface.test.tsx`, plus Playwright visual (`npm run test:visual`). Nav changes will break the snapshot and lane tests *by design* — updating them is part of each session, not a regression.

## Sessions (each = one commit)

**Each session ships with an ADR** (next free number is `0012`) recording the decision, in keeping with the repo's convention.

### Session 1 — Bottom tab bar + single top-right account slot
*Audit top-3 #1. Foundational; everything else sits on this.*
- Replace the six-element header with: a slim top row (brand · language · **one account slot**) and a **persistent bottom tab bar** (Races / My Tickets / Reference) mapped onto the existing `view` enum.
- Account slot: signed-out = "Sign in / ログイン" (calls `openSignIn`); signed-in = `<UserButton>`. One slot, two states.
- Decouple `funnel` from `view`: lanes (Quick / Research) become a **segmented control at the top of the Races view**. (Roundup stays reachable as today; its full move into the Races research-mode is Session 3.)
- Files: `App.tsx`, `styles.css`, `i18n/en.ts` + `ja.ts`, new `components/BottomTabBar.tsx`, update `app.snapshot.test.tsx` + `lane.test.tsx`.
- **Verify:** vitest green; 390px screenshot shows uncrowded top row + bottom bar; JA *and* EN labels fit three tabs.

### Session 2 — Sign-in weighting + honest signed-out My Tickets
*Audit #4.*
- Remove the My-Tickets-tab-as-auth-trigger pattern. The tab is always navigable; signed-out it shows an honest empty state ("Sign in to save your tickets") with locally-made marks shown as a teaser, plus an inline Sign-in CTA. The account slot is the *only* auth trigger.
- Files: `App.tsx`, `screens/MyTickets.tsx`, `auth/AuthGate.tsx`, `i18n`.
- **Verify:** signed-out tap on My Tickets renders the empty state, never a modal ambush; tests green.

### Session 3 — Collapse the builder spine; honesty inline
*Audit #2/#3 flow.*
- Drop Style out of the linear stepper → inline "Refine ▾" on the Tickets step. Spine becomes **Race → Tickets**.
- Make "Why" **inline-per-ticket** (fold `ExplainScreen` content into an expandable on each ticket card) instead of a terminal step — honesty pervasive, not a final gate.
- Resolve roundup placement (Research as a mode of Races vs. living under Reference).
- Files: `App.tsx` (`steps[]`, routing), `screens/StyleScreen.tsx`, `TicketsScreen.tsx`, `ExplainScreen.tsx`, `i18n`, tests.
- **Verify:** race→tickets in two steps; why reachable from every ticket; tests green.

### Session 4 — Marks on the runner row
*Audit #2 differentiator; the NetKeiba 予想印→投票シート muscle memory.*
- Add an inline impression-mark control on each `RaceScreen` runner row (set a mark without drilling), writing through the existing `onSetImpressions`. Keep the drill-down for form context. Echo marks visibly on the Tickets step.
- Files: `RaceScreen.tsx`, small `RunnerMark` component, `TicketsScreen.tsx`, tests (`impressions.test`, `RaceScreen.test`).
- **Verify:** tapping a mark on a row updates the store and reshapes tickets; tests green.

### Session 5 — Persistent race-context bar + anonymous-marks merge
*Audit #3 (hierarchy A) + the one genuinely new capability. May split into 5a / 5b.*
- **5a (frontend):** slim race-context bar (track · R# · surface/distance · status) below the top row, travelling through every step. Shows what's available now; lights up surface/distance when the API field lands.
- **5b (keystone):** merge locally-made (anonymous) marks into the account on Clerk sign-in.
- **Backend dependency (separate commit):** `/api/live` race objects must carry `surface` + `distance_m` (already-logged gap). This touches the racing Worker, not the frontend — flag as its own session if it's not already in flight.
- Files: `App.tsx`, `api.ts`, new `RaceContextBar`, `auth/` merge logic; (backend) worker `/api/live`.
- **Verify:** bar persists across steps; marks made signed-out survive and reconcile after sign-in.

## The handoff loop (per session)

The loop is **spec → build → verify → iterate → commit-package → sign-off**:

1. **Spec.** I write the session brief: exact scope, files, acceptance criteria, "do not touch" list, and the rule that the agent must not run any `git` write (the sandbox can't, and commits are David's).
2. **Build.** I hand the brief to a CLI agent. It edits in the mounted working tree and runs `npm test` in `frontend/`. It returns a **summary** (what changed, test results, anything it punted).
3. **Verify (me, not the agent's word).** I independently read the actual `git diff`, run the full `vitest` suite myself, and take a 390px Chrome screenshot of the dev build. The agent's summary is a claim; my checks are the gate.
4. **Iterate.** If verification fails, I `SendMessage` the *same* agent (context intact) with the specific defect, and re-verify. Loop until green.
5. **Commit package.** On green, I produce: the **commit message**, the **file list**, and the exact `git add … && git commit …` command — staged in the working tree, nothing run.
6. **Sign-off.** David runs the commit on the Mac (his checkpoint). Because the sandbox mounts the Mac repo, his commit simply records what's already in the tree. Next session starts only after the commit lands.
7. **Final push.** After the last session, David reviews the commit series and **pushes** — his sign-off, his hand on the trigger.

**Boundaries.** The agent works in the real tree (not an isolated worktree) so David's commit captures it. No session bundles two commits' worth of change; if scope grows mid-session (e.g. 5 splitting), I stop and re-spec. Sessions are ordered by dependency — 1 is foundational; 2–4 are largely independent and could reorder; 5 depends on the backend field for full value.

**Standing rule from Session 1 (the FAB bug).** The persistent bottom tab bar sits at `z-index: 50`. Any fixed or sticky bottom-anchored element (FABs, sticky CTAs, toasts) must clear it — bottom offset `calc(72px + env(safe-area-inset-bottom))`, the same clearance `.app` already uses — or the bar steals its pointer events. Session 1's `.mt-fab` overlap proved this is invisible to `tsc`/unit tests and only the Mac visual gate catches it; every later session that adds bottom-anchored UI must honor the clearance and the Mac visual pass is mandatory.

## Sandbox / device constraints (per `CLAUDE.md`)

- This runs in **cowork-sandbox**: edits + `vitest` only. **No git commit/push** here (the sandbox's `.git/index.lock` is unreliable) and no USB import. Every commit and the final push happen on **mac-dev**, run by David.
- Two of the five sessions' verification (visual screenshots) use the live dev server at phone width; the rest is the `vitest` suite, which the sandbox runs natively.
