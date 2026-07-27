// ============================================================================
// RunnerRow — the shared runner-row presentation used by BOTH RaceScreen and
// the manual-builder matrix (Phase 3b). One component, two layouts:
//
//   layout="race"   — reproduces RaceScreen's .runner inner DOM BYTE-FOR-BYTE
//                     (uma + grouped name/odds). Extracting it must not change
//                     the rendered DOM — legacy-race pins it, and an unchanged
//                     baseline is the success condition.
//   layout="matrix" — the builder's 2-line cell: name on top (CSS ellipsis, full
//                     cell width so realistic names fit), umaban + odds + a
//                     read-only mark glyph on the meta line.
//
// Presentation ONLY: it renders umaban / name / odds / an optional read-only
// glyph. It writes nothing and toggles nothing — mark-setting stays on
// RaceScreen (RunnerMark / ADR-0016 inline-mark).
//
// bracketStripe is a HOOK for the bracket (waku/枠) colour stripe. gate IS
// carried on /api/live once entries finalise (netkeiba_entries._extract_wakuban
// → snapshot.py build_runner → LiveRunner.gate) — the earlier "gate absent on
// /api/live" note was wrong, built on a stale comment without checking the
// producer. The slot renders only when a stripe node is provided; null gate
// (pre-entries) → no stripe.
// ============================================================================
import type { ReactNode } from "react";
import { useI18n } from "../i18n";
import { fmt } from "../lib/format";
import type { IntuitionState } from "../lib/types";
import { RunnerMarkGlyph } from "./RunnerMarkGlyph";

export interface RunnerRowProps {
  umaban: string;
  name: string | null;
  odds: number;
  /** RaceScreen's "estimated odds" pending flag (the .pc indicator). race only. */
  oddsPending?: boolean;
  /** Read-only mark glyph (matrix only). race omits it — RaceScreen renders the
   *  full RunnerMark chip strip beside the row. null/absent → "—" placeholder. */
  mark?: IntuitionState | null;
  layout: "race" | "matrix";
  /** Hook for the bracket colour stripe (a React node). Rendered when provided;
   *  null/undefined → no stripe (e.g. a pre-entries race with no gate yet). */
  bracketStripe?: ReactNode;
}

export function RunnerRow(props: RunnerRowProps) {
  const { umaban, name, odds, oddsPending, mark, layout, bracketStripe } = props;
  const { t } = useI18n();

  if (layout === "race") {
    // Byte-faithful to RaceScreen's .runner inner. `bracketStripe` is undefined
    // for RaceScreen → renders nothing, so the DOM is identical to today.
    return (
      <>
        {bracketStripe}
        <span className="uma">{umaban}</span>
        <span>
          <span className="nm">{name || `#${umaban}`}</span>
          <span className="odds-line">
            <span className="odds-value">{fmt(odds, 1)}</span>
            {oddsPending && <span className="pc">{t("race.estOdds")}</span>}
          </span>
        </span>
      </>
    );
  }

  // matrix: the builder's 2-line runner cell.
  return (
    <span className="mt-matrix-runner">
      {bracketStripe}
      <span className="mt-matrix-runner-name">{name || `#${umaban}`}</span>
      <span className="mt-matrix-runner-meta">
        <span className="mt-manual-horse-num">{umaban}</span>
        <span className="mt-manual-horse-odds">{odds > 0 ? `${odds.toFixed(1)}×` : "—"}</span>
        <RunnerMarkGlyph mark={mark ?? null} />
      </span>
    </span>
  );
}
