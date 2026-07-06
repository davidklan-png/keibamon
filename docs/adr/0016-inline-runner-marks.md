# ADR-0016: Inline impression marks on runner rows + read-only Tickets echo

- **Status:** Accepted
- **Date:** 2026-07-02
- **Surface:** Frontend (Race screen runner list, Tickets screen)
- **Companion:** `docs/ux-audit-netkeiba.md` (§2 — 予想印 muscle memory, §3 — list-level signal visibility), `docs/ux-implementation-plan.md` (Session 4); builds on [ADR-0011](0011-shared-impression-store.md), [ADR-0014](0014-collapse-builder-spine.md), [ADR-0015](0015-roundup-into-races.md)

## Summary

Setting an impression mark today requires opening the full per-horse drill (FormPanel → HorseDrillView → IntuitionMarks chips) — three taps and a context switch. NetKeiba's muscle-memory pattern is to set 予想印 (prediction marks) directly on the runner rows of the 投票シート (betting sheet), in two taps, with the marked set visible at a glance. This ADR closes that gap.

Each runner row on the Race screen gets a compact inline mark control. The drill stays — it carries the form/jockey context that justifies a mark. The inline path is the fast one for users who already know what they think.

## Decision

**A new `RunnerMark` component (`screens/RunnerMark.tsx`) renders inline on every Race-screen runner row.** Collapsed, it shows the current mark as a glyph badge (or a subtle `—` placeholder when unmarked). Tapped, it expands an inline chip strip with the same 5-mark vocabulary in the same order as `HorseDrillView`'s `IntuitionMarks` (like → distrust → priceHorse → avoid → anchor) plus a `clear` chip when something is active. Selecting a chip writes through `setImpression` (the same store write path `HorseDrillView` uses, with `umaban` + `odds_when_marked` + `odds_snapshot_at` stamped at mark time); tapping the active chip clears it. The strip auto-collapses after a choose so the next row is one tap away.

**Glyph mapping is the JA newspaper racing-print convention** (予想印), universal across EN/JA contexts:

| Kind | Glyph | Note |
|---|---|---|
| `anchor` | ◎ | Wheel axis (本命) |
| `like` | ○ | Contender (対抗) |
| `priceHorse` | ▲ | Upset contender (単穴) |
| `distrust` | ▽ | Doubtful — NOT △: in JA 予想印 convention △ is the 4th pick (mildly positive), so △ mis-read as a recommendation. ▽ (hollow inverted triangle) corrects the signal (issue #12, 2026-07-06) |
| `avoid` | × | No go (消し) |

Per-kind glyph colors are shared between the badge and the chip via a single `.runner-mark-<kind>` class so the two surfaces feel identical. aria-labels reuse the existing `form.intuition.<kind>` strings; the unmarked badge uses a new `race.markAdd` aria; the clear chip uses a new `race.markClear`. Both new keys land in `en.ts` and `ja.ts`.

**The runner row is restructured to satisfy the HTML constraint.** The existing tappable `<button class="runner runner-tappable">` (which opens the drill) used to be the entire row. The W3C spec forbids nesting interactive elements inside a `<button>`, so the mark control can't live inside it. Each row is now a `<div class="runner-row">` containing two siblings: the unchanged tappable button (still opens the drill — same class, same `aria-pressed`, same handler) + the `RunnerMark` control below it. The `.runner-row` takes the grid-item slot the button used to occupy directly, so the outer `.runners` grid (150px minmax cells) is preserved.

**At-a-glance visibility.** Marked rows carry a subtle row-level highlight (`.has-mark` — gold border); the anchor row additionally wears the gold gradient tint (`.is-anchor`) so the wheel axis is visible down the list without reading glyphs.

**Tickets echo is read-only.** The Tickets screen (`TicketsScreen`) renders a compact strip ABOVE the ticket list when the active race has ≥1 mark: glyph + horse number/name chip per mark. Editing stays on Race / in the drill — the Tickets strip is display-only (a `<ul>` of `<li>`, no buttons). The existing "Updated with your marks" toast and the auto-regen effect are untouched. The strip is absent in the empty-candidates state and absent when the legacy prop shape (no `runners`/`raceId`/`impressions`) is passed, so existing callers render unchanged.

**Only one row's strip is open at a time.** The open-strip state is lifted to `RaceScreen` (`openMarkUma`); `RunnerMark` receives `isOpen` + `onOpenChange(uma | null)`. This is the NetKeiba rhythm: tap-badge → pick mark → strip collapses → next row.

## Scope boundary (what this ADR does NOT do)

- The drill path is unchanged. `FormPanel` → `HorseDrillView` → `IntuitionMarks` still works verbatim and is the only path that carries form/jockey context. The two surfaces (inline badge + drill chips) share the same vocabulary, the same write path (`setImpression`), and therefore the same store — a mark made on one appears on the other next render.
- The "Box these N horses" CTA derivation (`markedSet`/`anchorUma` from the impression store) is unchanged. The inline marks feed it through the same store.
- The 0-runner registered-race state and the manual-entry state are unchanged. `RunnerMark` doesn't render when the runner list is in the empty state.
- No new server data. The marks were already server-ready (ADR-0011 Phase 3 plans the D1 migration); this ADR is purely a new client surface over the existing store.

## Consequences

- Marks are settable in **2 taps from the race list** (NetKeiba parity): tap the row's badge → tap the mark. Previously: tap row → tap IntuitionMarks title → tap chip → close = 4 taps.
- Marks are **visible at list level**: the glyph badge + the row tint let a user scan the field and read their marked set without opening anything.
- The runner row is taller (button + collapsed badge ≈ 70px vs the prior 46px). Visual density drops slightly; the trade is the at-a-glance signal. Cell width is preserved (150px minmax).
- The Tickets echo reinforces the "your marks shaped this ticket" link without duplicating the editing surface — the user sees what they marked, then the tickets those marks produced, on the same screen.
- `TicketsScreen` gains three optional props (`runners`, `raceId`, `impressions`). Existing callers (and the test render path) don't pass them; the strip is absent in that shape and the component behaves identically to pre-ADR-0016.
- `App.tsx` threading of the three new props to `TicketsScreen` lives in `App.tsx` and is therefore untested at the component level (per the ADR-0015 carve-out — `App.tsx` carries ~10 `useEffect` hooks and a fetch-on-mount and is excluded from the snapshot pattern by `app.snapshot.test.ts`). The contract is pinned instead by:
  - `screens/RunnerMark.test.tsx` — presentational (glyphs, aria, strip order).
  - `screens/RunnerMark.interaction.test.tsx` — write path (setImpression output, odds stamping, clear, collapse).
  - `screens/RaceScreen.test.tsx` — row restructure (wrapper, sibling-not-nested, has-mark/is-anchor flags, drill-opener className intact).
  - `screens/ticketsInline.test.tsx` — echo strip present-with-marks, absent-without, absent-in-empty-state, read-only (no buttons).
- Playwright visual baselines for `legacy-race` and `tickets` WILL drift (new UI on those surfaces). `refine-panel`, `inline-why`, and `mytickets` should NOT drift (untouched). Refresh the two drift cases at 390px after merge.
