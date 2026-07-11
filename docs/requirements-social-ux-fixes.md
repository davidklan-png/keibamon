# Requirements: Social UX Fixes — Handle Onboarding, Invite Deep Link, Header Consistency

## Context

Production smoke testing of the friend-interactions feature (live 2026-07-11)
surfaced three issue clusters. Root causes were confirmed in the merged code:

1. **Invite link blank / dead.** The link is built from the user's handle
   (`FriendsScreen.tsx` → `/?friend=<handle>`), but most users have no handle —
   handle setting exists only as `HandlePromptModal` buried in MyTickets, never
   enforced. Worse, **no code consumes the `?friend=` parameter**: the invite
   link does nothing even when it renders.
2. **No handle onboarding.** Nothing prompts a handle at first login, so the
   social identity most features depend on is usually missing.
3. **Header inconsistency.** There is no shared header component. The
   notification bell is mounted ad hoc per screen (App browse header,
   FriendsScreen, ReferenceScreen, MyTickets bar) and drifts in placement. The
   EN/JP toggle exists in App, ReferenceScreen, and FeedView — but not on the
   Friends screen.

## Decisions (Locked)

| Decision | Choice |
| --- | --- |
| Handle enforcement | Required at first login (and next login for existing users without one). Blocking step — social identity is not optional. |
| Invite link semantics | Pre-approved friend request: opening the link and confirming forms the friendship in one tap. The inviter generated the link — that is their consent; no second approval on the inviter's side. |
| Invite for logged-out / new users | Deferred deep link: the `?friend=` context survives sign-in AND new-account creation (including the handle-setup step), then resolves to the accept screen. |
| Header architecture | One shared `AppHeader` component (bell + EN/JP toggle + screen context), mounted once in the app shell — per-screen header mounts are removed, not patched. |

## 1. Handle Onboarding (First Login)

- After first sign-in, before anything else, show a handle-setup step:
  single input, inline availability check (debounced), clear charset rules
  shown only on violation, suggested default derived from display name /
  email prefix so most users can accept-and-continue in one tap.
- Existing users without a handle get the same step on next login.
- Not skippable. Keep it one screen, one field, one button — the friction
  budget for this step is near zero (mobile-game norm: name pick is the only
  blocking onboarding step).
- Handle rules (locking the earlier open question): 3–20 chars,
  `[a-z0-9_]`, case-insensitive unique, stored lowercase. Rename allowed
  (rare), old handle released; invite links use current handle only.
- The buried `HandlePromptModal` in MyTickets is removed or repurposed to
  the same shared component; there must be exactly one handle-setup UI.

## 2. Invite Deep Link (the friction-free add loop)

Flow when `/?friend=<handle>` opens:

- **Signed in, no relationship:** interstitial with inviter's profile card
  (avatar, @handle, display name) + one button: "Add @handle as a friend."
  Tap → friendship formed immediately (pre-approved both sides) →
  land on Friends tab with a success toast.
- **Signed out or no account:** stash the invite context (survives the OAuth
  round-trip and the handle-setup step), then resolve as above after auth.
  This is deferred deep linking — the industry-standard pattern; the invite
  must never be lost during signup.
- **Edge cases:** already friends → open Friends tab with "You're already
  friends" toast. Pending request between the two → accept it. Inviter
  blocked you / you blocked them → silent no-op (no existence leak). Handle
  not found (renamed/deleted) → friendly error, not a blank screen.
- **Sharing the invite:** use `navigator.share` (Web Share API) on
  supporting devices with copy-to-clipboard fallback — one tap to share into
  LINE/Messages, where race-day friend groups actually live.
- Invite links contain the handle only — no tokens, no expiry in v1
  (pre-approval is scoped: the link only lets someone friend *you*).

## 3. Header / Footer Consistency

- Create `AppHeader`: left = screen title/context, right = EN/JP toggle +
  notification bell, one fixed order, one mount in the app shell. All
  per-screen bell and lang-toggle mounts are deleted.
- One `NotificationBell` instance app-wide (also removes the 4× duplicate
  60s polling from the per-screen mounts).
- `BottomTabBar` audit: verify identical presence/order/badging on all four
  tabs and any sub-views that hide it; document intentional exceptions.
- Visual regression: extend the existing Playwright visual suite with a
  header/footer shot per main screen in both languages, so drift fails CI
  instead of reaching production.

## Mobile-Game Patterns Applied (research notes)

- Invite context must survive install/signup (deferred deep linking);
  invitee lands on the relationship screen, not home.
- One-tap accept from a profile interstitial; no code entry, no search.
- Name/handle pick is the single blocking onboarding step; everything else
  is deferred.
- Multiple add paths (search, link; QR later) — Pokémon GO-style numeric
  friend codes are unnecessary given handles + links.
- Links break silently — test the deep-link route explicitly and keep it
  covered in CI.

## Out of Scope (unchanged deferrals)

QR rendering (local-library-only when it comes), OS push, contact sync,
invite rewards/referral incentives (worth considering later — proven growth
loop, but incentive mechanics need guardrail review first).

## Acceptance

- New account: first login forces handle → Friends tab shows a working
  invite link immediately.
- Invite link opened by a stranger with no account: signup → handle setup →
  lands on "Add @inviter" → one tap → both see the friendship.
- Bell and EN/JP toggle appear in the same position on Browse, Friends,
  Reference, and My Tickets — including the Friends tab (currently missing
  the toggle).
- Exactly one bell poller per session.
