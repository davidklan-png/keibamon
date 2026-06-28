# Keibamon phone UI/UX audit vs. NetKeiba App

**Lead-designer consult — June 28, 2026**

## What I looked at

- The live app pulled at phone width (390px) at `keibamon.com/app/`. Confirmed the current top row carries six action elements + brand: language toggle, **Quick ticket**, **Research**, **My tickets**, **Reference**, **Open user menu** (the new Clerk `<UserButton>`). Confirmed the four-step stepper (RACE → STYLE → TICKETS → WHY), the "Two ways in" lane block, the runner list ("Tap a runner for form context"), the optional "Refine by style →", and a single footer disclaimer.
- I could not inspect the signed-in surface (My Tickets contents, the `<UserButton>` menu) — that needs a real test login, and I won't stand up a throwaway Clerk account. Everything below about signed-in states is from your description; give me test creds and I'll verify those screens directly.
- NetKeiba's patterns are taken from their official feature docs, not memory. The relevant confirmed facts: within a race screen, NetKeiba runs a **contextual bottom menu** rebuilt to focus on 予想・馬券購入; the **投票シート (voting sheet)** lives at the bottom of the race screen and carries selection → stake → IPAT purchase; per-horse **予想印 (prediction marks)** set on the card **flow directly into the voting sheet**; and race-level **Myレース印 (勝負 / 注目 / 波乱)** plus **レースメモ** can be set from anywhere in the race surface.

The single most important thing NetKeiba teaches: it separates three kinds of navigation that Keibamon currently fuses into one row — stable destinations (persistent bottom nav), in-context actions (a menu that lives *inside* the race screen), and account utility (tucked away, not in the primary nav). Your six-element header is doing all three jobs at once, and that is the root of most of what follows.

---

## 1. Header / global nav verdict

**The six-element row is not sustainable, and it's the wrong model — move to a bottom tab bar.** Two reasons, in order of weight. First, it conflates three navigation types: lane selection (Quick / Research), destination switching (My Tickets / Reference), and account utility (language, UserButton). A user can't tell "what mode am I in" from "where am I" from "my account" because they're all the same visual row. Second, it fights muscle memory — every Japanese racing fan who opens your app has a thumb that expects a persistent bottom bar, because that's where NetKeiba and effectively every JP racing surface put primary nav. The top-row model asks them to relearn nav on a surface that's already intimidating.

**The integration that matters — don't make the two lanes two tabs.** Quick and Research are entry *framings* into the same drill-down and the same impression store; they are not parallel destinations. If you promote them to two bottom tabs you fragment the marks store across two homes and reintroduce the "where am I" confusion at a different layer. Instead, collapse the lanes *into* the Races destination as a segmented control at the top of that screen ("Quick card | Research roundup"), both feeding the same card + drill-down. The lane model survives as a product feature; it just stops being global chrome. This is exactly NetKeiba's discipline: the bottom tabs are stable, and mode choices live inside the screen.

**Proposed bottom bar (3 destinations):** Races (レース) · My Tickets (マイ) · Reference (用語). Races is the default and the convergence point for both lanes.

**Where `<UserButton>` lands:** top-right corner, paired with the language globe — the *only* two things up top besides the brand. That makes the top-right the universal, unchanging "account + settings" anchor on every screen, never crammed into nav, never moving. Signed out, that same slot is a single explicit "Sign in / ログイン" affordance; signed in, it's the UserButton avatar. One slot, one job, state-dependent. (Detail in §4.)

This one move fixes nav muscle memory, the orientation problem in §2-C, and the sign-in weighting in §4 simultaneously.

---

## 2. Information hierarchy (A / B / C)

**A — "What race am I on, and what's its status?"** Currently weak *in depth*. The card list shows track · R# · surface · distance · status (ODDS OPEN, etc.), but once you're inside the stepper that identity isn't pinned — it falls away as you move through style/tickets/why. Fix without chrome: a slim **persistent race-context bar** directly under the top utility row — `track · R# · surface/distance · status chip` — that travels through every step. It costs no new real estate because it reclaims the space the stepper currently spends on bare labels. This is NetKeiba's always-visible race header, and it's the highest-frequency question your user asks.
*System dependency:* the context bar can't show surface/distance on live races until `/api/live` carries `surface` + `distance_m` — that gap is already logged. The context bar is the user-facing reason to close it.

**B — "What can I do next?"** Mostly present but contested. On the race/runner screen the forward action competes with "Refine by style →" and "tap a runner." Fix: one unambiguous primary CTA per screen (the flow's "next"), style demoted to a secondary inline control (§3), and the bottom bar always offering My Tickets as a standing escape hatch. The next action should never be a toss-up between three similarly-weighted affordances.

**C — "Where am I in the app?"** This is the weakest of the three today, because location is signalled three inconsistent ways at once: lane pills, sibling tabs, and the stepper. The bottom tab bar fixes it for free — the active tab is your app-level location, and the stepper handles your position *within* the builder. You go from three muddled location signals to two clean levels.

---

## 3. Choice architecture on the ticket builder

**Collapse the spine from four steps to two; keep the marks as the connective tissue.** NetKeiba gets race → bet short by letting the 予想印 you set on the card flow straight into the voting sheet — there is no separate "style" detour and no terminal "explain" gate. Apply the same logic:

- **Style is already optional** ("Style is optional refinement — adjust later"), so it should not occupy a slot in the linear spine. Demote it to an inline "Refine ▾" control on the Tickets step. Removing a step the user is told to skip is free speed.
- **"Why" should be inline-per-ticket, not a terminal step.** Right now honesty is something you arrive at last and might skip. Attach the explanation to *every* recommendation (tap a ticket → why), so the de-vigged-probability honesty is pervasive instead of a final checkpoint. For a research tool whose first truth is honesty posture, the reasoning should be one tap from every number, everywhere.

That yields a two-step spine: **Race (pick race + set impression marks on the runner list) → Tickets (recommendations with marks echoed, style refine inline, why inline per ticket).**

**Protecting the differentiator while you shorten the flow.** The impression/marks store is the spine, so move mark-setting *onto the runner list* — extend today's "Tap a runner for form context" to also set the impression mark right there — and make those marks visibly carry into the Tickets step (the recommender reads and echoes them). This is precisely NetKeiba's 予想印 → 投票シート muscle memory, which your audience already has, so it shortens the flow *and* foregrounds the one thing that makes Keibamon not-NetKeiba. Marks get more prominent as the flow gets shorter — those goals are aligned, not in tension.

---

## 4. Sign-in / sign-out weighting

**Kill the dual-purpose "My Tickets" tab as the sign-in trigger.** A destination that's secretly an auth gate is the clunky part — the label promises content and delivers a modal ambush. Separate the two concerns cleanly:

- **Signed out:** top-right shows one explicit "Sign in / ログイン" affordance (opens Clerk `openSignIn`). My Tickets still exists as a bottom tab, but tapping it lands on an honest in-tab empty state — "Sign in to save your tickets" — with the marks they've *already* made shown locally as a teaser. No ambush; the value of signing in is visible before the ask.
- **Signed in:** top-right is the `<UserButton>` avatar (profile / sign-out); My Tickets shows real content.

**Weight sign-in low until there's something to save.** Let casual fans build tickets and set marks anonymously, and surface sign-in exactly at the moment of value — save, place, or share. Don't gate the funnel behind auth; that's friction on the most friction-sensitive audience you have, and it's contrary to the low-friction, non-salesy posture. The UserButton is the only persistent account chrome; the Sign-in CTA appears only when signed out, only top-right. One account slot, two states, never overloaded onto a destination tab.
*System impact:* this needs the impression store to persist client-side pre-auth and reconcile/merge on sign-in via Clerk. That's a real but bounded piece of work — a local store that survives until login, then a one-time merge — and it's the thing that lets you keep the funnel open to anonymous users.

---

## 5. Three things I'd change first

1. **Replace the six-element top row with a bottom tab bar (Races · My Tickets · Reference) and move account utility — UserButton + language — to the top-right corner.** Highest leverage because it fixes nav muscle memory, the "where am I" gap, and the sign-in weighting in a single move, and it's your biggest divergence from what every JP racing fan expects.
2. **Set impression marks on the runner list and carry them into the Tickets step, dropping Style out of the linear spine.** This shortens race → bet to match NetKeiba's 予想印 → 投票シート flow *while* promoting the marks store — your one true differentiator — instead of burying it.
3. **Add the persistent race-context bar (track · R# · surface/distance · status) under the top row.** It answers your highest-frequency question on every screen with zero added chrome, and it gives the `/api/live` surface/distance gap a concrete reason to get closed.

---

## System-level impacts (so this is buildable, not just pretty)

- **Lane state moves from global to local.** Today the funnel/lane is top-level React state; under the bottom-bar model it becomes a parameter of the Races route. This simplifies the top-level tree but touches the wiring between the lane toggle and the shared impression store — plan it as a routing refactor, not a repaint.
- **The marks → Tickets flow is wiring, not a rebuild.** The impression store is already the shared source of truth between surfaces; this change makes the recommender read it at the Tickets step and echo it. The architecture supports it; the work is in the read path and the runner-list UI.
- **Anonymous-marks-then-merge is the one genuinely new capability.** Client-side persistence of marks pre-auth plus a merge-on-sign-in path against Clerk. Bounded, but it's the keystone that keeps the funnel open to logged-out casual fans.
- **Bilingual survives the bottom bar better than the current row.** JA tab labels are short (レース / マイ / 用語); the risk is EN (Races / Tickets / Glossary), which still fits three tabs comfortably — far more robust than six EN labels overflowing one row.
- **What I'd verify with test creds next:** the signed-in `<UserButton>` menu contents and the My Tickets / social-feed surface, to confirm the empty-state and merge design land cleanly against the real Clerk flow.
