# ADR-0011: Two-path entry, unified spine, impression-keyed marks, structural tickets

- **Status:** Accepted
- **Date:** 2026-06-27
- **Surface:** Frontend (Roundup + RaceScreen) + future structural ticket builder

## Summary

Restructure the research-and-ticket path around **one spine** with **two
on-ramps**, so a casual user and a researcher both land on the same
horse-drilldown → impression → ticket-builder pipeline. Today the RaceScreen
flow and the Roundup deep-dive flow each carry their own half of this; the
split shows in duplicated logic and a ticket model that can't represent
multi-leg structures. This ADR settles the design before Phase 1 implementation.

The decision is **architectural**: the unified spine is the target shape.
Phase 1 only migrates the impression store onto its foundation; the drill-down
extraction (Phase 2) and the structural ticket model (Phase 3) are scoped here
so the eventual refactor doesn't re-litigate decisions already made.

## The decisions

### D1 — Two-path entry, both on-ramps to one spine

Two CTAs at the top of the race experience:

- **Quick ticket** — beginner path. Preserves the current 4-step race → style →
  tickets → explain flow with default diverse tickets and minimal friction.
- **Research** — pro path. Lands on the same RaceScreen but surfaces the
  per-horse drill-down inline + opens the structural ticket builder.

The choice is **remembered + switchable** (per-device, in localStorage). The
on-ramp selector sits ABOVE the existing surfaces so neither path is hidden
behind a settings menu; a single tap flips mode mid-flow. Both paths converge
on the same spine (D2) — only the entry affordance and the default surface
density differ.

### D2 — Unified spine underneath

Three components, owned once, embedded by both surfaces:

| Component | Owned by | Embedded in |
|---|---|---|
| `HorseDrillView` (one horse drill-down) | `frontend/src/screens/HorseDrillView.tsx` (Phase 2) | RaceScreen (lightweight, modal-style) + Roundup deep-dive (rich, inline) |
| Impression store (D3) | `frontend/src/lib/impressions.ts` (Phase 1) | Both — same store, same horse_key |
| Ticket builder (D4) | `frontend/src/lib/structuralTicket.ts` (Phase 3) | Both — `fromImpressions()` consumes the same store |

Today the FormPanel is the de-facto horse drill-down but lives only on
RaceScreen; the Roundup's per-horse deep-dives are static generator output with
no marking affordance. Phase 2 extracts HorseDrillView from FormPanel so the
Roundup can embed it (rich, inline, with mark chips + impression-vs-drift),
and RaceScreen keeps the lightweight version. Both write to the same store.

### D3 — Impression store (local-first, odds-stamped, race+horse keyed)

- **Storage**: localStorage (Phase 1). Will migrate server-side (Clerk user +
  D1) when Phase 3 lands; the client-side shape stays the read model.
- **Key**: `(race_id, horse_key)` where `horse_key = normalizeName(horse_name)`
  — the same NFKC + drop-whitespace transform the Worker uses for
  `horse_name_key`. This is what makes a marked horse resolve to the same key
  the form-panel fetch uses, AND what lets a mark survive a renumber (a horse's
  umaban shifts on a scratch, but its name doesn't).
- **Value**: `{ mark, umaban, odds_when_marked, odds_snapshot_at, formed_at }`.
  The odds context is stamped AT MARK TIME so the UI can later show
  **impression-vs-drift** ("you marked this at 4.2 when the snapshot was T1;
   the live is now 6.8") without a separate capture.
- **Marks**: reuse the existing taxonomy (`like | distrust | priceHorse | avoid |
  anchor`). **No taxonomy expansion in this ADR** — the five existing marks
  cover the research surface; new kinds wait on a proven need.
- **Composite-key fallback**: when a race has no JRA `race_id` (manual entry,
  legacy snapshot), the store falls back to the existing composite
  `date|venue|race_no|name` key. Marks don't cross between the two keying
  schemes — they're not user-visible as the same race.

### D4 — Structural ticket model (Phase 3)

The ticket shape becomes **structural**, layered on top of the existing
`lib/fairvalue` combo math:

```ts
interface StructuralTicket {
  betType: BetType;
  structure: "single" | "box" | "wheel" | "formation";
  legs: Leg[];          // position-aware for ordered family; set for set family
  unitStake: number;
}
```

The existing `recommender.ts` stays the uma-keyed math it is today; the
structural layer **expands to flat combos** for pricing and collapse to the
existing Ticket shape for the recommender's input. This keeps the recommeder's
proven ROI-tested math intact while letting the UI express multi-leg structures
(馬単 wheel, 3連単 formation, etc.) the current model can't represent.

### D5 — Output organized by selection shape, not bet type

The render path branches on **selection shape**:

- **Set family** (馬連 / ワイド / 枠連 / 3連複): one shared "set" selection UI.
  - **Option A** — consolidated summary (compact readable list)
  - **Option B** — card-style fill guide (the markable, printable, mobile-legible
    artifact)
- **Ordered family** (馬単 / 3連単): position-column UI.
  - **Option C** — formation (pick 1st/2nd/3rd leg separately)
  - **Option D** — wheel (axis + opponents)

枠連 (wakuban-set) brackets **derive from the gate-draw data** already in the
snapshot (`runner.gate` — Phase: gate+going enrichment, ADR-0010 follow-on).
No separate scrape; the fill guide just groups by gate.

単勝 / 複勝 are **deferred** — they're single-position plays that don't benefit
from the structural layer and the existing flat-value surface handles them
adequately. They slot in later as a degenerate case of the ordered family.

### D6 — Mark-card fidelity

Card-styled and **mobile-legible**, NOT a pixel-accurate OMR replica. The
fill guide is the share/export artifact (QR/image/PDF) — reuses the
data-not-advice gate already in `lib/share.ts`. The visual treatment takes
liberties with spacing/typography as long as the cell-to-number mapping is
unambiguous when the user marks the physical mark card.

This explicitly rejects the "scan a real mark card and overlay" path: it would
either lock the layout to JRA's exact spec (fragile, no design freedom) or
require image recognition we don't need.

### D7 — Guardrail: data + user marks, never app-generated picks

The app surfaces **data + the user's own marks**. It NEVER generates picks,
rankings, or recommended horses as part of the research surface. The
`recommender.ts` "diverse tickets" output on the Quick-ticket path stays
honest as a STYLE application (personality + budget) over the user's marks or
the field — not as a horse-picking claim.

This is the rule that lets the structural ticket model coexist with the
recreational-not-betting-advice framing: the user picks horses; the app
structures tickets around those picks. The app never says "you should back
this horse."

## Phases

### Phase 1 — Impression store migration (BUILD NOW)

**Goal**: replace the uma-keyed `Record<uma, IntuitionState>` with a
`(race_id, horse_key)`-keyed store, behavior-preserving for the current
single-race flow.

- New `frontend/src/lib/normalizeName.ts` (frontend-local copy of
  `src/form/normalize.ts` — Worker/frontend build boundary prevents a shared
  module; parity is fixture-tested).
- New `frontend/src/lib/impressions.ts` — localStorage-backed store.
- Migrate `App.tsx`, `RaceScreen.tsx`, `FormPanel.tsx`, `ExplainScreen.tsx`
  off uma-keyed intuition. The recommender's `RecommendInput.intuition`
  interface stays uma-keyed (its math is uma-internal); App.tsx derives that
  record from the store via the current runners list.
- Stamp `odds_when_marked` + `odds_snapshot_at` at mark time from the runner's
  current odds + the snapshot's `published_at`.

### Phase 2 — HorseDrillView extraction + two-path selector (DEFERRED)

- Extract `HorseDrillView` from `FormPanel` (rich version with mark chips +
  impression-vs-drift display).
- Embed inline in Roundup deep-dives; RaceScreen keeps the lightweight version.
- Add the Quick-ticket / Research selector above the existing surfaces.
- Persist the chosen path in localStorage; switchable mid-flow.

### Phase 3 — Structural tickets + A/B/C/D output (DEFERRED)

- Structural ticket model on top of `lib/fairvalue` (expand → flat combos for
  pricing).
- Consolidated-set output (Option A) + card-style fill guide (Option B) for
  set family (馬連/ワイド/枠連/3連複).
- Position-column formation (Option C) + axis/opponents wheel (Option D) for
  ordered family (馬単/3連単).
- 枠連 brackets derive from `runner.gate`.
- Mark-card share artifact (reuses `lib/share.ts` data-not-advice gate).
- Roundup "build tickets from my reads" bridge — feeds the marked horses from
  the Roundup deep-dives into the structural builder.

## Trigger conditions for revisiting

1. **horse_key drift**: if the Worker's `normalizeName` and the frontend's
   copy ever diverge (a horse_name_key that one computes and the other
   doesn't), the impression-vs-form-data join breaks. The parity fixture in
   `frontend/src/lib/normalizeName.test.ts` is the regression gate.
2. **Store volume**: localStorage caps at ~5MB. A power user marking every
   horse on every card over a season could approach this; revisit when the
   migration path to server-side (Phase 3) is built.
3. **Structural model collapse**: if the structural layer's expand-to-flat
   ever stops being a clean superset of fairvalue's combo math (e.g. a bet
   type that needs pool-aware pricing fairvalue can't provide), revisit
   before shipping Phase 3.

## What stays

- The recommender (`lib/recommender.ts`) — uma-keyed math, ROI-tested,
  unchanged interface in Phase 1.
- The fairvalue combo math (`lib/fairvalue.ts`) — the structural layer in
  Phase 3 expands to it.
- The guardrail scan (`i18n/guardrails.test.ts`) — banned phrases apply
  identically to whatever copy the new surfaces introduce.
- The data-not-advice gate (`lib/share.ts`) — the fill guide's share/export
  artifact reuses it; no new advice-framing loophole.
