// ============================================================================
// ticketStructure — the ONE pure interpreter for a ticket's structural view.
//
// Both ticket-body renderers consume this: TicketLines (the detail / share /
// feed card body) and FillGuide (the JRA-style fill card). One interpretation,
// two presentations. (ticket-structure-unify Phase 1, 2026-07-27.)
//
// Precedence (folded in from TicketLines' former ad-hoc logic): an explicit
// `structurePayload` wins; absent that, a box is best-effort DERIVED from flat
// `lines` (legacy / structure-less tickets); otherwise the ticket renders as
// chips. The wheel's k-length position columns are reconstructed here too (was
// inline in FillGuide) so axis-position handling lives in one place.
//
// Pure: no React, no i18n. Labels stay in the components.
// ============================================================================
import type {
  Ticket,
  BoxPayload,
  FormationPayload,
  WheelPayload,
} from "./types";
import type { BetType } from "./fairvalue";

/** Ordered bet types — combos are sequences (a box expands to permutations). */
export function isOrderedType(type: BetType): boolean {
  return type === "exacta" || type === "trifecta";
}

/** P(n, k) — ordered permutations. */
function permutations(n: number, k: number): number {
  let p = 1;
  for (let i = 0; i < k; i++) p *= n - i;
  return p;
}

/** C(n, k) — unordered combinations. */
function combinations(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  const j = Math.min(k, n - k);
  let c = 1;
  for (let i = 0; i < j; i++) c = (c * (n - i)) / (i + 1);
  return Math.round(c);
}

/**
 * Best-effort BOX derivation for a legacy/flat ticket. Returns the number set
 * IFF `ticket.lines` is EXACTLY a full box expansion of that set — all
 * k-permutations for exacta/trifecta, all k-combinations otherwise. Returns
 * null otherwise (including single-line win/place tickets).
 *
 * The check is mathematically tight, so a flat non-box can NEVER satisfy it:
 * P(n,k) UNIQUE ordered k-tuples drawn from an n-set IS the full permutation
 * set; C(n,k) UNIQUE k-subsets IS the full combination set. A hand-picked
 * 3-line trifecta (3 of P(n,3)) fails the count test and falls back to chips.
 * That is the false-positive guard.
 *
 * bracket_quinella is special-cased: its combos are BRACKET pairs, and a
 * same-bracket pair (ゾロ目, e.g. 3-3 — legal when a bracket fields ≥2 horses)
 * would trip the umaban "no repeat within a combo" guard. A bracket box is
 * the full set of CROSS-bracket pairs C(n,2); that count stays tight, so a
 * hand-picked partial bracket selection (fewer than C(n,2) cross pairs) still
 * falls back to chips. Same-bracket lines ride along but can't be checked for
 * completeness (horse-per-bracket counts aren't on the ticket), so they are
 * permitted, not required. (The manual builder only ever emits cross-bracket
 * pairs today; the same-bracket branch covers tickets arriving by other paths.)
 */
export function deriveBoxSet(ticket: Ticket): string[] | null {
  const lines = ticket.lines;
  if (lines.length === 0) return null;
  const k = lines[0].combo.length;
  if (k < 2) return null; // win/place singles aren't boxes

  if (ticket.type === "bracket_quinella") {
    // 枠連 is a 2-bracket quinella. Allow same-bracket ゾロ目; require the
    // cross-bracket pairs to be EXACTLY the C(n,2) expansion (false-positive
    // guard). See the doc comment above.
    if (k !== 2) return null;
    const set = new Set<string>();
    for (const ln of lines) {
      if (ln.combo.length !== 2) return null; // mixed combo lengths → not a clean box
      for (const u of ln.combo) set.add(u);
    }
    const n = set.size;
    if (n < 2) return null; // a single bracket (ゾロ目 only) isn't a multi-box
    const expectedCross = combinations(n, 2);
    const crossSeen = new Set<string>();
    for (const ln of lines) {
      const [a, b] = ln.combo;
      if (!set.has(a) || !set.has(b)) return null; // draws outside the bracket set
      if (a === b) continue; // same-bracket ゾロ目 — legal for 枠連, permitted
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      if (crossSeen.has(key)) return null; // duplicate cross pair → not the clean expansion
      crossSeen.add(key);
    }
    if (crossSeen.size !== expectedCross) return null; // partial → chips (false-positive guard)
    return [...set].sort((a, b) => Number(a) - Number(b));
  }

  const ordered = isOrderedType(ticket.type);
  const set = new Set<string>();
  for (const ln of lines) {
    if (ln.combo.length !== k) return null; // mixed combo lengths → not a clean box
    if (new Set(ln.combo).size !== ln.combo.length) return null; // repeat within a combo
    for (const u of ln.combo) set.add(u);
  }
  const n = set.size;
  const expected = ordered ? permutations(n, k) : combinations(n, k);
  // A single combination (e.g. a 2-horse quinella "box" = C(2,2)=1) isn't a
  // multi-way box — leave it on chips. n>=k always holds here because every
  // combo already has k distinct umas (the within-combo repeat check above).
  if (expected < 2) return null;
  if (lines.length !== expected) return null;
  const norm = (combo: string[]): string =>
    ordered ? combo.join(" ") : [...combo].sort().join(" ");
  const seen = new Set<string>();
  for (const ln of lines) {
    for (const u of ln.combo) {
      if (!set.has(u)) return null; // a combo draws outside the derived set
    }
    const key = norm(ln.combo);
    if (seen.has(key)) return null; // duplicate → not the full unique expansion
    seen.add(key);
  }
  if (seen.size !== expected) return null;
  return [...set].sort((a, b) => Number(a) - Number(b));
}

/**
 * One structural view of a ticket, consumed by every renderer. Discriminated
 * by `mode`:
 *   - box       → the selected number SET (tiles in TicketLines, grid in
 *                 FillGuide) + a bracket flag so renderers needn't re-check
 *                 `ticket.type`.
 *   - formation → per-position contender sets (`positions[i]` = horses that
 *                 can finish (i+1)th).
 *   - wheel     → the k-length reconstructed position columns (axis pinned to
 *                 its slot, opponents elsewhere) PLUS the raw `axis` /
 *                 `opponents` the axis-anchored renderers want, and the
 *                 1-based `axisPosition` for labelling.
 *   - chips     → flat combo chips (legacy / single-line / non-box).
 */
export type TicketStructureView =
  | { mode: "box"; set: string[]; isBracket: boolean }
  | { mode: "formation"; positions: string[][] }
  | {
      mode: "wheel";
      positions: string[][];
      axisPosition: number;
      axis: string[];
      opponents: string[];
    }
  | { mode: "chips" };

/**
 * Interpret a ticket into a single structural view. Explicit payload wins;
 * else derive a box from flat lines (legacy / structure-less); else chips.
 *
 * The branch order matters: formation and wheel are checked before box so a
 * ticket that carries one of those structures can never be mis-read as a box,
 * and so the box branch's `deriveBoxSet` fallback only runs for genuine
 * box-structured or structure-less tickets.
 */
export function interpretTicket(ticket: Ticket): TicketStructureView {
  const structure = ticket.structure;
  const formationPayload =
    structure === "formation"
      ? (ticket.structurePayload as FormationPayload | null)
      : null;
  const wheelPayload =
    structure === "wheel" ? (ticket.structurePayload as WheelPayload | null) : null;
  const boxPayload =
    structure === "box" ? (ticket.structurePayload as BoxPayload | null) : null;

  // ---- Formation: per-position contender sets. ---------------------------
  if (formationPayload && formationPayload.positions.length > 0) {
    return { mode: "formation", positions: formationPayload.positions };
  }

  // ---- Wheel: reconstruct k-length columns + carry axis/opponents. -------
  if (wheelPayload) {
    const k = ticket.type === "trifecta" ? 3 : 2;
    const positions = Array.from({ length: k }, (_, i) =>
      i + 1 === wheelPayload.position ? wheelPayload.axis : wheelPayload.opponents,
    );
    return {
      mode: "wheel",
      positions,
      axisPosition: wheelPayload.position,
      axis: wheelPayload.axis,
      opponents: wheelPayload.opponents,
    };
  }

  // ---- Box: explicit payload wins, else derive from flat lines. ----------
  const explicitSet = boxPayload?.set;
  const boxSet =
    explicitSet && explicitSet.length > 0 ? explicitSet : deriveBoxSet(ticket);
  if (boxSet && boxSet.length > 0) {
    return {
      mode: "box",
      set: boxSet,
      isBracket: ticket.type === "bracket_quinella",
    };
  }

  // ---- Chips: legacy / single-line / non-box. ----------------------------
  return { mode: "chips" };
}
