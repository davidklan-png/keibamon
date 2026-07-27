// ============================================================================
// RunnerMarkGlyph — the READ-ONLY 印 (mark) indicator shown in the manual
// builder's matrix row (Phase 3b). Renders the JA 予想印 glyph for a runner's
// intuition mark, or "—" when unmarked — the same glyph characters RunnerMark
// uses for its chip strip (MARK_GLYPH), so the builder's row reads identically
// to RaceScreen's marks.
//
// Display-only by construction: it is a <span> with NO click handler and the
// builder receives no mark-WRITE callback, so it cannot touch the impression
// store. The builder shows your marks as a memory aid while picking; setting
// marks stays on RaceScreen (RunnerMark / ADR-0016 inline-mark). The read-only
// guarantee is pinned by a vitest assertion, not just a baseline.
// ============================================================================
import type { IntuitionState } from "../lib/types";
import { MARK_GLYPH } from "../screens/RunnerMark";

export interface RunnerMarkGlyphProps {
  mark: IntuitionState | null;
}

export function RunnerMarkGlyph({ mark }: RunnerMarkGlyphProps) {
  return (
    <span className="runner-mark-glyph" role="img" aria-label={mark ?? "unmarked"}>
      {mark ? MARK_GLYPH[mark] : "—"}
    </span>
  );
}
