# CLI Agent Prompt: Social UX Fixes

Copy everything below the line into the CLI agent, run from the repo root.
`docs/requirements-social-ux-fixes.md` is the source of truth for behavior.

---

Implement the social UX fixes specified in
`docs/requirements-social-ux-fixes.md`. Read it fully first. Root causes are
already diagnosed — confirm them, don't re-derive: (a) `?friend=` is generated
in FriendsScreen but consumed nowhere; (b) handle setup exists only as the
buried MyTickets `HandlePromptModal`, never enforced; (c) there is no shared
header — bell and EN/JP toggle are mounted ad hoc per screen and FriendsScreen
lacks the toggle.

Work in three phases on a new branch `feat/social-ux-fixes`. Standing rules
apply: every checkpoint ends with commit + push; hold after each phase with a
summary, unmet items, and decisions that constrain later work.

## Phase A — Shared AppHeader (do this first; B and C mount into it)

1. Build `AppHeader` (screen title/context left; EN/JP toggle + bell right,
   fixed order) and mount it once in the app shell.
2. Delete all per-screen bell and lang-toggle mounts (App browse header,
   FriendsScreen, ReferenceScreen, MyTickets bar, FeedView toggle). Exactly
   one NotificationBell instance — and therefore one 60s poller — per session.
3. Audit BottomTabBar presence/order/badging across all tabs and sub-views;
   fix drift; document intentional exceptions in code comments.
4. Extend the Playwright visual suite: header+footer snapshot per main screen,
   EN and JA both. These exist to make future drift fail CI.

## Phase B — Handle onboarding at first login

1. One shared handle-setup component: single field, debounced availability
   check, suggested default from display name/email prefix, charset errors
   shown only on violation. Rules: 3–20 chars, `[a-z0-9_]`, case-insensitive
   unique, stored lowercase.
2. Blocking step after first sign-in; also triggers on next sign-in for any
   existing account without a handle. Not skippable.
3. Remove/replace the MyTickets `HandlePromptModal` — one handle UI in the
   codebase. Backend: ensure a handle-availability check endpoint exists and
   handle writes are validated server-side with the same rules.

## Phase C — Invite deep link (deferred, pre-approved)

1. Consume `/?friend=<handle>` at app boot. Signed-in: interstitial with the
   inviter's profile card and one "Add @handle" button → tap forms the
   friendship immediately (pre-approved both sides; server-side this is
   create-request + auto-accept in one call — add an endpoint if needed) →
   land on Friends tab + success toast.
2. Deferred context: if signed out / no account, persist the invite through
   the full auth round-trip AND the new handle-setup step (sessionStorage or
   equivalent that survives OAuth redirects), then resolve the interstitial.
   The invite must never be silently dropped during signup.
3. Edge cases: already friends → Friends tab + "already friends" toast;
   existing pending request either direction → accept it; block in either
   direction → silent no-op (no existence leak, no error); unknown handle →
   friendly error state.
4. Invite sharing UI: `navigator.share` where available, clipboard fallback,
   from the Friends tab Add pane. The invite section must never render blank:
   with a handle → link + share button; without (transitional) → the
   set-handle CTA routing into the Phase B component.
5. Tests: unit-test the deep-link resolver state machine (all five states)
   and the deferred-context persistence; integration-test stranger-with-no-
   account → signup → handle → one-tap friend → both sides see friendship.

## Hard constraints

- No tokens/expiry in invite links (handle only); no QR (deferred,
  local-library-only when it comes); no OS push; no referral rewards.
- No behavior changes to solo flow, tickets, or feed beyond specified.
- Full suites green both packages; new visual snapshots committed.
- Update `docs/` copies of the requirements if implementation forces a
  deviation — say so explicitly in the checkpoint, don't silently diverge.

## Verification (final checkpoint)

Fresh-account walkthrough scripted end-to-end: create account → forced
handle → invite link visible → second account opens link logged-out →
signup → handle → one-tap add → friendship visible both sides → bell fires
→ EN/JP toggle present and identically placed on all four screens including
Friends. Report raw test output and the visual-diff summary.
