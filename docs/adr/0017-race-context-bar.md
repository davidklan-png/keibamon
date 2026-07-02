# ADR-0017: Persistent race-context bar above the builder stepper

- **Status:** Accepted
- **Date:** 2026-07-02
- **Surface:** Frontend (App shell — visible on both Race and Tickets steps)
- **Companion:** `docs/ux-audit-netkeiba.md` (§2-A — hierarchy-A: "what race am I on?"), `docs/ux-implementation-plan.md` (Session 5a); builds on [ADR-0014](0014-collapse-builder-spine.md)

## Summary

Once a race is applied, the user moves between the Race step and the Tickets step (and back) without a persistent answer to the most basic hierarchy-A question: *what race am I on, and what's its status?* The race identity lives at the top of the Race screen's live card, but the moment the user steps to Tickets, that context disappears — they're left holding recommended tickets whose anchoring race is implicit. NetKeiba keeps the race header sticky for this reason.

This ADR adds a slim, persistent race-context bar directly under the App header, above the stepper. It carries venue · R{race_no} · surface/distance · status chip · optional going — enough to answer "which race, what state" at a glance on every screen of the Quick funnel.

## Decision

**A new `RaceContextBar` component (`components/RaceContextBar.tsx`) renders under the App header, above the stepper.** It mounts whenever `view === "browse" && funnel !== "research" && (selectedRace || raceLabel)` — i.e. on the Races destination, in the Quick funnel, once a race is applied (real race OR the manual sample card). It persists across BOTH builder steps; it does not appear in Research mode (the roundup carries its own context) nor on the My Tickets / Reference destinations (different shell, different question).

**The bar is fed from `selectedRace` + `raceStatus` ONLY — not the live `snap`.** The 45s snapshot rotation (`refreshSnap` replaces `snap` entirely; race may rotate off, name may drift, `meta.date` may roll) is a known trap documented in App.tsx. A snap re-lookup would silently miss on rotation and blank the bar. `App` freezes `selectedRace` at selection time precisely so this strip is stable across the 45s ticks (the same freeze `placeTicket` relies on).

**Each identity segment omits cleanly when its data is null.** `surface` and `distance_m` are both optional on `LiveRace`; the formatter handles all four cases (both, surface-only, distance-only, neither) without stray `·` separators. The status chip reuses the canonical `race.statusOpen` / `statusRegistered` / `statusResult` vocabulary plus the existing `race.manual` ("Sample card") for the manual/sample-race path — no new status string inventory.

**Surface is localized.** The publisher ships raw `"turf"` / `"dirt"` on `LiveRace.surface`. The bar adds `race.surfaceTurf` ("turf" / "芝") and `race.surfaceDirt` ("dirt" / "ダート") so JA reads `芝2000m` and EN reads `turf 2000m`. A CJK-aware joiner drops the space between surface and distance when the surface label is wide (matches JA newspaper print convention); latin labels keep the space.

**Manual-mode rendering.** When App's `seedManual()` runs (sample card), `selectedRace` is null and `raceLabel` is the `race.placeholderRace` ("(sample race)"). The bar still renders: the manual/sample-card chip carries the `race.manual` label, the trailing race-name slot shows the placeholder, and the venue/R#/surface segments are omitted (no data to show). The user always sees *something* recognizable, not a blank strip.

**Going is wired as an optional prop only.** The publisher does not yet emit going on `LiveRace` (it lives on `HorseFormCard` today); this ADR does not change that. The bar accepts `going?: string | null` and omits the segment when null/empty/whitespace. When the publisher-side change lands, App threads the prop; until then the segment is absent and the bar's contract is unaffected.

**Visual treatment is deliberately restrained.** A 390px viewport cannot hold venue + R# + surface/distance + chip + going + race name without discipline. The identity segments (`.rcb-id`) are short, `white-space: nowrap`, and never truncate. The trailing race name (`.rcb-name`) is the single variable-width element and carries `text-overflow: ellipsis` so a long graded-stakes name falls back to `Hakodate Kinen…` rather than wrapping. A 3px left border tints by status (`--turf` open / `--sky` registered / `--gold` result / `--muted` manual) so the status is readable peripherally without reading the chip.

## Scope boundary (what this ADR does NOT do)

- **The bar is read-only.** It does not navigate, does not open a race picker, does not toggle status. Tapping it does nothing. The Race screen remains the only surface for changing the applied race; the bar answers "what" and "what state", not "let me switch".
- **Research mode is unchanged.** When `funnel === "research"`, RoundupPanel renders inline (per ADR-0015) and carries its own weekend-edition context. The bar is hidden there — a second context strip would compete.
- **My Tickets / Reference destinations are unchanged.** Different shells, different questions ("what did I bet" / "what does this term mean"). The bar is a Quick-funnel Races-destination affordance only.
- **The live card on the Race screen is unchanged.** The bar duplicates the venue/R#/surface identity at a smaller weight, but the live card carries runner lists, odds, marks, and selection — the bar is a glanceable summary, not a replacement.
- **No new data fetching.** Props only. The component reads `selectedRace`, `raceLabel`, `raceStatus` from App state and an optional `going` prop; it has no effect, no store read, no fetch.

## Consequences

- The user always knows what race they're on, on every screen of the Quick funnel, without scrolling back to the live card or opening a drill. This is the audit's hierarchy-A fix.
- `selectedRace` becomes load-bearing for a third surface (RaceScreen, TicketsScreen, RaceContextBar). All three already share the frozen-at-selection-time object, so the 45s-rotation trap is contained; a future refactor that swaps to a snap re-lookup would now blank the bar too, not just silently break Place.
- The manual sample-race path now has a visible chip ("Sample card") above the stepper — a small new cue that the user is on the sample card, complementing the existing `raceLabel` ("(sample race)") on the Race screen itself.
- Three new i18n keys land in `en.ts` + `ja.ts`: `race.surfaceTurf`, `race.surfaceDirt`, `race.contextBar`. The existing canonical status vocabulary (`race.statusOpen` / `statusRegistered` / `statusResult` / `manual`) is reused as-is. The shared parity guardrail (`i18n/guardrails.test.ts`) stays green.
- `App.tsx` threading of the three props (`selectedRace`, `raceLabel`, `raceStatus`) into `<RaceContextBar>` lives in `App.tsx` and is therefore untested at the component level (per the ADR-0015 carve-out — `App.tsx` carries ~10 `useEffect` hooks and a fetch-on-mount and is excluded from the snapshot pattern by `app.snapshot.test.ts`). The contract is pinned instead by `components/RaceContextBar.test.tsx`:
  - full-fields render (venue/R#/surface/distance/chip/name/aria)
  - surface/distance each omit cleanly when null (4 cases)
  - CJK-aware join (`芝2000m` JA vs `turf 2000m` EN) + unrecognized-surface pass-through
  - status chip variants (registered/open/result/manual/unknown)
  - bilingual parity (en/ja key resolution + JA render)
  - null safety (no race + no label → returns null; manual path with null race + label; defensive empty-label)
- Playwright visual baselines for `legacy-race` and `tickets` WILL drift (new persistent element above the stepper on both). `refine-panel`, `inline-why`, and `mytickets` should NOT drift (the bar is hidden on Reference and My Tickets, and Refine/Why are below the Tickets step so the bar is above them but they don't include the shell in their baselines). Refresh the two drift cases at 390px after merge.
