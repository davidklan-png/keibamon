# Keibamon — Claude Design brief

Paste this into Claude Design to seed the session, then point it at the real UI
(web-capture the deployed `/app/`, or point at `frontend/`).

## What it is / who it's for
A recreational JRA horse-racing **ticket companion** for a casual younger fan —
turn a feeling about a race into a fun, understandable exotic ticket. Not a tip
sheet, not betting advice, not a profit claim.

## Current screens (post-Codex)
- **Race** — date-first picker, then a race select showing `R<n> · name · venue`.
  Runners are now a read-only list (no manual odds, no add-runner, no win%).
- **Style** (optional refinement) — one "how you play" personality control +
  budget; advanced knobs hidden behind a disclosure.
- **Tickets** — up to three cards, each: **cost** + **"if it hits"** + one plain
  **mood label** (safer / balanced / spicier). One-tap reachable; no setup required.
- **Why** — plain-language sentence first, the math (fair value, takeout) below.

## Hard guardrails (design must not break these)
- **One-tap default (ADR-0005):** a casual user gets three tickets with zero
  setup. Don't reintroduce wizard ceremony.
- **Honest, not advice:** cost at least as prominent as payout; takeout reminder
  and "not betting advice" stay reachable; never "guaranteed / lock / sure thing."
- **Two live states to design (ADR-0006):** `registered` (odds not open → grayed,
  "est." odds, "odds pending") vs `open` (live odds), plus `result`. The
  grayed→live upgrade is a real moment worth designing.
- **Audience:** expressive, fast, friendly — avoid a dense sportsbook /
  trading-screen aesthetic.
- **Bilingual JA/EN:** Japanese strings run ~1.2–1.4× longer; design for both
  (`i18n/en.ts`, `ja.ts`).
- **Presentation only:** the recommender/math (`lib/recommender.ts`,
  `lib/fairvalue.ts`) are off-limits — design the surface, not the engine.

## Look-and-feel goals (fill in / react to)
- Make the **ticket card the hero** — it's the shareable object.
- A clear visual language for **registered (grayed) vs open (live)**.
- A friendly **date-first race picker** that doesn't feel like a form.
- Palette / type / motion that reads young and expressive, still legible at a glance.

## Advanced-behavior candidates (pick what to prototype)
- Live odds refresh with a subtle update animation.
- Drift indicators (firming / draining) on a runner or ticket.
- The `registered → open` auto-upgrade transition (estimate fades to live price).
- Shareable ticket card (image/export).
- Remix micro-interaction on the tickets.
- Empty / standby states (no card registered yet).

## How to bring the real UI in
- **Web-capture** `https://<your-worker-or-keibamon.com>/app/` after a deploy —
  best fidelity, captures the real states.
- Or **point at the codebase**: `frontend/src/App.tsx` (single-file React 19) +
  `frontend/src/styles.css` (plain CSS variables) + `i18n/`.
- Export edits back to **standalone HTML** to diff against `styles.css`.
