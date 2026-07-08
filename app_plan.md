# Keibamon App Plan

> **⚠ SUPERSEDED (2026-07-08).** Historical planning doc from 2026-06-17.
> Superseded by ADR-0005 (one-tap simplification), ADR-0011 (research/ticket
> restructure), ADR-0012+ (NetKeiba UX rebuild) and
> `docs/ux-implementation-plan.md`. Kept for the origin record only — do not
> implement from this file.

## Next Development Target

Build Keibamon into a recreational race companion for younger horse-racing fans.
The product should help a user turn preferences, personality, and intuition into
understandable exotic-ticket structures.

The positioning is:

> Tell Keibamon how you like to play. It turns your race intuition into smarter
> exotic ticket ideas.

This is not a tip sheet, an edge claim, or real-money automation. The app should
stay honest about pari-mutuel takeout and market efficiency while making exotic
ticket construction more fun, legible, and personal.

## Product Principles

- Start with user intent, not math. The first interaction should ask how the user
  wants to play and what they feel about the race.
- Explain every ticket in plain language. Users should understand what they are
  buying: coverage, upside, fragility, and cost.
- Make the free product genuinely useful. The paywall should unlock convenience,
  live intelligence, and deeper context rather than basic functionality.
- Keep risk visible. Cost should be clearer than payout fantasy, and high
  variance tickets should be labeled honestly.
- Avoid claims that imply guaranteed value, market-beating skill, or betting
  advice.

## Core User Loop

1. Pick a race.
2. Choose a betting personality.
3. Add intuition about specific horses.
4. Set budget and preferred ticket complexity.
5. Receive three ticket recommendations.
6. Expand a ticket to understand why it was suggested.
7. Optionally adjust constraints and remix.

## Betting Personalities

- Safe-ish: wants action and a higher hit rate, accepts smaller payouts.
- Balanced: wants a mix of plausible tickets and fun upside.
- Longshot Hunter: wants chaos, price horses, and bigger payout potential.
- Fan Pick: has one horse they emotionally want included.
- Anti-Chalk: wants to fade obvious public favorites and avoid crowded combos.

These should map to algorithmic constraints rather than only labels. For example:

- Safe-ish should prefer wide, quinella, and small trio structures.
- Balanced should mix quinella, trio, and selected exacta ladders.
- Longshot Hunter should allow lower hit probability, more price-horse slots,
  and capped trifecta shots.
- Fan Pick should anchor tickets around the selected horse.
- Anti-Chalk should penalize all-favorite combinations and surface alternatives.

## Intuition Inputs

The app should let users express race opinions without requiring expert language:

- I like this horse.
- I do not trust the favorite.
- Include one price horse.
- Avoid this horse.
- Use this horse as an anchor.
- I want a jockey upgrade angle.
- Keep it under my budget.
- Make this ticket more conservative.
- Make this ticket spicier.

Internally, these become constraints and scoring weights for ticket generation.

## Free Tier

Free should cover the basic companion experience:

- Manual odds entry.
- Basic race picker from available published snapshot.
- Personality-based ticket recommendations.
- Budget-aware ticket sizing.
- Scratchpad exotic calculator.
- Fair odds and estimated pool payout.
- Human-readable "why this ticket" explanations.
- Shareable ticket card.
- Clear recreational-use and not-betting-advice framing.

The free tier should feel like a complete lightweight product, not a disabled
demo.

## Paid Tier

Paid features should focus on live convenience, richer context, and advanced
ticket construction:

- Live odds refresh.
- Late odds movement and drift labels.
- "This combo got more expensive" and "favorite is drifting" notes.
- Horse lookup with recent form, running style, distance/surface notes, and
  wet-track hints.
- Jockey and trainer lookup with course stats, recent form, and combination
  signals.
- Advanced ticket modes: key horse, wheel, banker, formation, and constrained
  boxes.
- Saved betting profiles such as Conservative G1, Longshot Saturday, and Fan
  Pick Mode.
- Alerts for selected horse movement, race close, and ticket cost changes.

Paywall language should sell better context and faster live workflows, not
promises of profit.

## Younger Demographic Fit

The UX should feel expressive and fast:

- Prefer mood and personality language over pro-bettor terminal language.
- Let users begin from a hunch before exposing the math.
- Use friendly labels such as Main Horse, Chaos Slot, Trust Anchor, Fade the
  Crowd, and Price Horse.
- Make ticket cards shareable and visually distinct.
- Keep advanced controls available but not dominant.
- Avoid a dense sportsbook or trading-screen aesthetic.

## MVP V2 Screens

### 1. Race

- Select live or manual race.
- Show runners, odds, market rank, and basic status.
- Keep live freshness visible when live data is available.

### 2. My Style

- Pick personality.
- Set budget and unit stake.
- Choose conservative, balanced, or spicy complexity.
- Select favorite/longshot preference.

### 3. My Intuition

- Mark horses as liked, disliked, anchor, or chaos slot.
- Allow one-tap "do not trust the favorite."
- Allow "include one price horse" as a constraint.

### 4. Tickets

- Show three recommendations: Safe, Balanced, and Spicy.
- Each ticket shows lines, cost, estimated hit probability, average payout,
  ticket shape, and variance label.
- User can remix, lock a horse, or exclude a horse.

### 5. Explain

- Plain-language explanation first.
- Expandable math details second.
- Include fair odds, Henery model note, takeout reminder, and why the ticket
  matches the chosen personality.

## Recommendation Engine Direction

Use the current Henery-based fair-price calculator as the math core, then add a
preference layer above it:

- Generate candidate tickets by pool type and shape.
- Apply user constraints: budget, unit stake, anchors, excludes, personality,
  favorite/longshot preference, and desired complexity.
- Score candidates on hit probability, payout profile, crowd/chalk exposure,
  price-horse inclusion, and budget fit.
- Return a small, diverse set of recommendations instead of a ranked table of
  every possible combo.
- Explain the selected ticket in terms of the user's stated preferences.

The engine should optimize for coherent recreational structure, not expected
profit.

## Guardrails

- Do not use "guaranteed", "sure thing", "lock", or "beat the market" language.
- Do not hide ticket cost behind payout estimates.
- Label high-variance tickets clearly.
- Add soft budget friction when a remix exceeds the user's stated budget.
- Keep "not betting advice" visible but not intrusive.
- Before monetization, review age-gating, jurisdictional requirements, data
  licensing, and app-store/payment-platform rules.
- Real-money betting automation remains out of scope.

## Implementation Milestones

### Milestone 1: Companion UX

- Replace the current helper's technical-first controls with a Race, My Style,
  My Intuition, Tickets, and Explain flow.
- Add horse intent states: liked, disliked, anchor, chaos slot.
- Add three named recommendation cards: Safe, Balanced, Spicy.
- Add shareable ticket-card rendering.

### Milestone 2: Preference Engine

- Move ticket generation logic into a testable module.
- Add constraints for anchors, excludes, anti-favorite, one-price-horse, budget,
  and ticket complexity.
- Add deterministic recommendation snapshots for tests.
- Add plain-language explanation templates.

### Milestone 3: Live Companion

- Add live odds freshness and refresh state.
- Add odds movement annotations.
- Add race-close and selected-horse movement alerts.
- Gate live auto-refresh behind the paid tier placeholder.

### Milestone 4: Lookup And Paid Surfaces

- Design horse, jockey, and trainer lookup panels.
- Add locked paid feature states before implementing payment.
- Wire available local data into lookup summaries.
- Keep paywall copy focused on context and convenience.

## Immediate Next Build

The next implementation pass should target Milestone 1 and the first half of
Milestone 2:

- Rework `/helper` into the five-step companion flow.
- Preserve the current manual/live odds fallback behavior.
- Preserve the existing Henery fair-price math.
- Add intuition tags for each runner.
- Generate Safe, Balanced, and Spicy cards from user style and intuition.
- Add tests around the extracted recommendation engine before expanding paid
  features.

