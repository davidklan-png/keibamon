# Full-field coverage — problem catalogue

**Branch:** `feat/full-field-coverage` (PR #27) · **Date:** 2026-07-28
**Prompt:** `docs/prompts/full-field-coverage.md`

The point of the batch. Each 18-runner / large-selection capture was driven
locally and measured; this is the eyeballed conclusion per surface. Findings are
DOM-measured (counts, rects, computed styles, scroll geometry), not image-AI —
the harness couldn't present the PNGs visually, so per the architect's guidance
image inspection was reserved for genuinely visual properties and the limit is
stated plainly where it applies.

**Threshold check:** 1 real-but-mild finding, 1 minor, 1 non-defect note. Well
under the 5-problem stop threshold → no scoping escalation.

---

## Captures

### `legacy-race-runners-18` — race screen `.runners` (headline)
- **18 rows render; all eight waku colours appear together** (`bracket-1`…
  `bracket-8`) — the first capture where they do. The anchor mark (umaban 1)
  resolves; `is-anchor` tint + mark chip render. `.runners` is 820px tall and
  grows with content, so the element capture holds the full list.
- **⚠ Minor — long-name ellipsis.** The `.nm` name cell is `width ~104px;
  text-overflow: ellipsis; white-space: nowrap; overflow: hidden`. A
  **9-character** JA name (`アオバコンチェルト`, umaban 1) truncates ~4px
  (`scrollWidth 108 > clientWidth 104`); 8-character names fit flush. The mark
  badge is **not** the cause (it doesn't reduce `nmW`) — pure name length.
  Ellipsis is expected UX and the cut is sub-character. This confirms the
  race-screen row name budget (104px) is tighter than the builder's 148px
  (which holds every legal 9-char name).

### `legacy-race-18-bottom` — bottom of racecard + fixed tab bar
- **⚠ Real-but-mild — tab-bar clearance gap.** The runner list has no
  `scroll-padding-bottom` for the fixed bottom tab bar. `scrollIntoView` of the
  last runner places its bottom at viewport-y **890**, under the tab bar
  (top **787**) — a ~100px overlap. At **max page scroll** the last row rests at
  viewport-y ~491 (clear of the bar). So this is a scroll-padding polish gap
  (the last row can be obscured *on scroll-into-view / mid-scroll*), **not a
  permanent obstruction** — there is a scroll position where the last row is
  fully clear. The 8-runner fixture never exposed this (its shorter list is
  rarely scrolled to the bottom). This is the architect's predicted "bottom tab
  bar clearance has never met a full racecard" concern — confirmed, but milder
  than a hard collision.

### `studio-fill-box-18` — FillGuide 18-cell box grid
- **Clean.** 18-cell grid renders (`gridSize = max(maxUmaban=18, …)`), 3 cells
  highlighted `[1,3,6]`. No overflow flag. *(Grid aesthetics — spacing/colour —
  not visually confirmed; structurally sound.)* This grid had been rendered by
  no prior test.

### `studio-list-large` — studio list, 6-horse selection
- **Not a defect — modal scrolls internally.** At a 6-horse selection,
  `.kbm-modal-card` (`overflow-y: auto`) is 1109px of content in an 818px card →
  it scrolls to reach the wheel view. Graceful (no clipping); the wheel view is
  reachable by scroll. `SetFamilyView` (4 rows) and `FormationView` (2 rows)
  have **fixed** row counts — selection size grows the joined-set *text*, not the
  row count — and the formation pos-set `"1 3 6 8 10 12"` fits its cell without
  truncation. This is **not** the `9061e2b` clip class (that was content cut off,
  unreachable); here the card itself is the scroll container.

### `ticket-detail-box-large` — 8-horse box trifecta (P(8,3)=336)
- **Clean.** The 8-tile box set fits on **one row** (`scrollWidth 324 ==
  clientWidth 324`, no wrap/overflow). The pay panel carries `336 × ¥100`
  (en) / `336点 × ¥100` (ja) — the large combo count is pinned via the pay
  panel. The TicketLines `.tl-points` line is **off on the detail card by
  design** (the pay panel carries cost + count), so the at-scale points-line
  *text* itself isn't pinned here — but the combo count it would state is.

---

## Skipped

### `research-mode` / roundup
`RoundupPanel` renders upcoming-**race** rows in the empty state — each row is a
grade chip + race name + a runner-**count number** (`race.runnersCount`,
`RoundupPanel.tsx` ~line 221) — and delegates to `RoundupView` (generated prose)
when an edition is published. There is **no per-runner visual list** at either
state. An 18-runner baseline would differ only in a number / prose length → the
architect's explicit skip criterion ("if they do not [scale], say so and skip it
rather than adding a baseline that differs only in a number"). Confirmed by
reading the component, not inferred.

---

## Verdict

The 8-runner fixture was hiding less than the gap suggested. The only finding
worth a follow-up is the race-screen **tab-bar scroll-padding** gap (mild; a
one-line CSS fix when prioritized). The 18-cell FillGuide grid, the large tile
set, and the studio at a large selection all render clean. JA name wrap — the
item flagged "least likely to bite" — is fine at 8 characters and truncates a
sub-character only at 9.
