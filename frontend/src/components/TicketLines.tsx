// ============================================================================
// TicketLines — structure-aware ticket-body renderer (ticket-detail UX,
// 2026-07-12). ONE shared component used everywhere a ticket body renders:
// the My-Tickets detail card, the viewer share-detail pane, and the feed
// ShareCard. Renders by `ticket.structure`:
//
//   box       → the payload's number SET as tiles (NEVER the expanded perms)
//               + a BOX badge + a points line
//   formation → labeled position columns (1着/2着/3着; two cols for exacta)
//               + tiles per column + a points line
//   wheel     → axis (軸) horse(s) prominent + partners (相手) tile row
//               + a points line
//   single    → capped chips (~2 rows) + an "all N combos" expander
//
// Legacy/flat tickets (no `structure`) get best-effort BOX derivation: if the
// lines are EXACTLY a full box expansion, render as Box; otherwise capped chips.
// Detection is exact (see deriveBoxSet), so a flat non-box can never be
// mis-rendered as a Box.
//
// Visual identity: echoes a real ticket's ORGANIZATION (columns, points) but
// uses Keibamon's own palette/typography — no JRA marks, mark-card look, or
// official colors. Old share snapshots without `structure` take the single/
// legacy path untouched (render-side only — no migration, no snapshot rewrite).
// ============================================================================
import { Fragment, useState } from "react";
import { useI18n } from "../i18n";
import { yen } from "../lib/format";
import type { Ticket, BoxPayload, FormationPayload, WheelPayload } from "../lib/types";

export interface TicketLinesProps {
  ticket: Ticket;
  /** Per-combo stake (CommittedTicket.unit / Ticket.unit). */
  unitStake: number;
  /** Dense tiles for compact feed/share cards. Default false (detail size). */
  compact?: boolean;
  /**
   * Which points line to render under the body (box/formation/wheel AND chips):
   *
   *   "full"  — "N combos × unit = cost" (default). DetailView/FriendsScreen/
   *             ShareCard behaviour.
   *   "count" — count only ("N combos" / "N点"), no unit, no cost. For hosts
   *             that already show cost but NOT the combo count (the four list/
   *             preview surfaces). Cost without count is a worse pair than the
   *             chip wall it replaced, so restore the count — without
   *             duplicating the cost the host already prints.
   *   "none"  — no line. For hosts that already show BOTH cost and count
   *             (DetailView's pay panel, TicketWhy's <dl>, the manual builder's
   *             preview head).
   *
   * The count renders on the chips (legacy) path too — the count line is the
   * one way the combo total is expressed, replacing the old compact "+N" chip.
   */
  points?: "full" | "count" | "none";
}

/** Ordered bet types — combos are sequences (a box expands to permutations). */
function isOrderedType(type: Ticket["type"]): boolean {
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

export function TicketLines({
  ticket,
  unitStake,
  compact = false,
  points = "full",
}: TicketLinesProps) {
  const { t, tFmt } = useI18n();
  const [expanded, setExpanded] = useState(false);

  const structure = ticket.structure;
  const boxPayload = structure === "box" ? (ticket.structurePayload as BoxPayload | null) : null;
  const formationPayload =
    structure === "formation" ? (ticket.structurePayload as FormationPayload | null) : null;
  const wheelPayload =
    structure === "wheel" ? (ticket.structurePayload as WheelPayload | null) : null;

  // Box set: explicit payload is authoritative; else derive from flat lines for
  // legacy/absent-structure tickets. Formation/wheel never derive a box.
  const explicitSet = boxPayload?.set;
  const boxSet =
    explicitSet && explicitSet.length > 0
      ? explicitSet
      : structure === "formation" || structure === "wheel"
        ? null
        : deriveBoxSet(ticket);

  const isFormation = !!(formationPayload && formationPayload.positions.length > 0);
  const isWheel = !!wheelPayload;
  const isBox = !isFormation && !isWheel && !!boxSet && boxSet.length > 0;
  // bracket_quinella box: tiles carry BRACKET numbers (1-8), indistinguishable
  // from horse-number tiles without a bet-type-aware treatment. Flagged here so
  // the box path can label the head + restyle the tiles (Keibamon palette only
  // — no JRA bracket colours, per the locked visual-identity constraint).
  const isBracket = ticket.type === "bracket_quinella";

  const nCombos = ticket.lines.length;
  const sep = isOrderedType(ticket.type) ? " › " : " – ";
  const tileCls = compact ? "tl-tile tl-tile-sm" : "tl-tile";
  const rootCls = compact ? "tl tl-compact" : "tl";

  function PointsLine() {
    if (points === "none") return null;
    if (points === "count") {
      // Count only — no unit, no cost (the host already shows cost). This is
      // the one place the combo total is expressed on the dense list/preview
      // cards; it also renders on the chips path so a legacy ticket states its
      // total the same way a box/formation/wheel does.
      return <div className="tl-points">{tFmt("ticketLines.count", { n: nCombos })}</div>;
    }
    return (
      <div className="tl-points">
        {tFmt("ticketLines.points", {
          n: nCombos,
          unit: yen(unitStake),
          cost: yen(ticket.cost),
        })}
      </div>
    );
  }

  // ---- Box ----------------------------------------------------------------
  if (isBox && boxSet) {
    const bracketTileCls = isBracket ? `${tileCls} tl-tile-bracket` : tileCls;
    return (
      <div className={rootCls}>
        <div className="tl-head">
          <span className="tl-badge tl-badge-box">{t("fillGuide.box")}</span>
          {isBracket && (
            <span className="tl-bracket-tag">{t("ticketLines.brackets")}</span>
          )}
        </div>
        <div className="tl-tiles" role="list">
          {boxSet.map((u) => (
            <span key={u} className={bracketTileCls} role="listitem">
              {u}
            </span>
          ))}
        </div>
        <PointsLine />
      </div>
    );
  }

  // ---- Formation ----------------------------------------------------------
  if (isFormation && formationPayload) {
    const positions = formationPayload.positions;
    const k = positions.length;
    const posLabels = [t("fillGuide.pos1"), t("fillGuide.pos2"), t("fillGuide.pos3")];
    return (
      <div className={rootCls}>
        <div className="tl-head">
          <span className="tl-badge tl-badge-form">{t("fillGuide.formation")}</span>
        </div>
        <div className="tl-cols">
          {positions.map((posSet, i) => (
            <Fragment key={i}>
              <div className="tl-col">
                <div className="tl-col-label">{posLabels[i] ?? `${i + 1}`}</div>
                <div className="tl-col-tiles">
                  {posSet.map((u) => (
                    <span key={u} className={tileCls}>
                      {u}
                    </span>
                  ))}
                </div>
              </div>
              {i < k - 1 && (
                <span className="tl-arrow" aria-hidden="true">
                  →
                </span>
              )}
            </Fragment>
          ))}
        </div>
        <PointsLine />
      </div>
    );
  }

  // ---- Wheel --------------------------------------------------------------
  if (isWheel && wheelPayload) {
    const { axis, opponents, position } = wheelPayload;
    const posLabels = [t("fillGuide.pos1"), t("fillGuide.pos2"), t("fillGuide.pos3")];
    const axisLabel = posLabels[position - 1] ?? `#${position}`;
    return (
      <div className={rootCls}>
        <div className="tl-head">
          <span className="tl-badge tl-badge-wheel">{t("fillGuide.wheel")}</span>
          {axis.length > 1 && <span className="tl-multi">{t("ticketLines.multi")}</span>}
        </div>
        <div className="tl-cols">
          <div className="tl-col">
            <div className="tl-col-label">
              {axisLabel} <span className="tl-axis-tag">{t("fillGuide.axis")}</span>
            </div>
            <div className="tl-col-tiles">
              {axis.map((u) => (
                <span key={u} className={`${tileCls} tl-tile-axis`}>
                  {u}
                </span>
              ))}
            </div>
          </div>
          <span className="tl-arrow" aria-hidden="true">
            →
          </span>
          <div className="tl-col">
            <div className="tl-col-label">{t("ticketLines.partners")}</div>
            <div className="tl-col-tiles">
              {opponents.map((u) => (
                <span key={u} className={tileCls}>
                  {u}
                </span>
              ))}
            </div>
          </div>
        </div>
        <PointsLine />
      </div>
    );
  }

  // ---- Single / legacy ----------------------------------------------------
  const CAP = compact ? 6 : 8; // ~2 rows of chips
  const shown = expanded ? ticket.lines : ticket.lines.slice(0, CAP);
  const hidden = nCombos - shown.length;
  return (
    <div className={rootCls}>
      <div className="tl-chips">
        {shown.map((ln, i) => (
          <span key={i} className="tl-chip">
            {ln.combo.join(sep)}
          </span>
        ))}
        {/* Non-compact offers an expander to reveal every chip. Compact no
            longer carries a "+N" truncation chip: the count line below states
            the combo total (the one way the count is expressed), so a dense
            card reads "6 chips · 18 combos" instead of "+12". */}
        {!expanded && hidden > 0 && !compact && (
          <button type="button" className="tl-more" onClick={() => setExpanded(true)}>
            {tFmt("ticketLines.allCombos", { n: nCombos })}
          </button>
        )}
      </div>
      <PointsLine />
    </div>
  );
}
