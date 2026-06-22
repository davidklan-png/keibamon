# ADR-0007 — open-items close-out register

Disposition of every open item across the My Tickets program. Companion to
`docs/my-tickets-rollout.md`. As of 2026-06-21, Phases 0–4 are merged.

| # | Item | Disposition | Closure path |
|---|------|-------------|--------------|
| A | **R1 — `/api/live` result feed** (finishing order, ties, scratches, payouts) | 🟢 **Ready to execute** | `docs/r1-result-feed-brief.md` (brief + paste-to-CLI). Racing-tier work on mac-dev; closes when the agent lands it, pytest green, merged. **Gates settlement value.** |
| B | **Phase 5 — App.tsx extraction + full visual regression** (closes Decision-1 re-theme gate) | ✅ **Done (code), in review** | Landed on `feat/adr-0007-phase5-visual-regression` (App.tsx 2731→316, 14 baselines, bundle size identical, suite proven to fail on a style break). Closes on merge. |
| C | Settle sweep + dead-heat/scratch resolver | ✅ **Done (code)** | Landed in Phase 4 against fixtures. Real-data exercise is gated on **A**. |
| D | Self-host fonts | ✅ **Done** | Phase 4. |
| E | Block / report moderation | ✅ **Done** | Phase 4 (`blocks_reports` migration). |
| F | Server-side card renderer | ⛔ **Closed — won't-do (accepted)** | No cross-platform inconsistency data justifies it; client `html-to-image` with the not-advice line is sufficient. Reopen only if share images prove uneven. |
| G | KV token-bucket rate limiting | ⛔ **Closed — accepted as-is** | The Phase-4 D1 minute-bucket (extended to block/report) is adequate for launch. Optional KV upgrade folded into Phase 5 *only if trivial*. |
| H | ToS / compliance review | ✅ **Closed** | By Decision 9 — product is framed as a game; the persistent "not betting advice" disclaimer is the agreed posture. No legal gate for launch. |
| I | Moderation review-queue UI (Phase 6 backlog) | ⛔ **Closed — accepted/deferred** | Block/report **backend** shipped (item E). Reports are persisted and reviewable directly in D1 at launch volume; a dedicated queue UI is a scale feature. Reopen when report volume warrants it. |
| J | Multi-platform visual baselines (Phase 6 backlog) | ⛔ **Closed — accepted/deferred** | Phase 5 committed chromium-darwin baselines — sufficient as the regression gate today. WebKit/Firefox + Linux/Windows baselines wait on multi-platform CI runners. |

## Net state

**Closed:** B, C, D, E, F, G, H, I, J — Phase 5 done (pending merge), the rest
done-in-code, accepted/won't-do, or closed by decision.

**The one truly open item is A (R1).** It cannot be closed from the Cowork
sandbox by design — it needs real netkeiba/JV result data and racing-tier
execution on mac-dev, and the sandbox cannot commit, push, or scrape. It is fully
specified (`docs/r1-result-feed-brief.md`) and one agent-run from closed.

## Git / sync status (as of Phase 5 complete — ACTION NEEDED)

The earlier merge was partial and **local-only**:
- `main` holds Phases 0–4 but is **20 commits ahead of `origin/main` — unpushed.**
- `phase5` and `jravan` (USB fix) are **not merged**; the phase1–5 branches are
  **not cleaned up**; the program docs are **uncommitted**.

→ Finish via `docs/runbooks/merge-cleanup-adr0007.md` (revised for this state):
merge phase5 + jravan, commit docs, **push main**, delete the merged branches.

## What's between here and GA

Only **R1 (item A)**. Run its brief on the racing tier, merge, and — once the
git sync above is done — the program is GA-ready. Nothing else is open.
