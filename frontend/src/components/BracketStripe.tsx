// BracketStripe — a thin coloured left-edge stripe identifying a runner's
// bracket (waku/枠). The colour comes from the --waku-N custom properties, the
// single source shared with the manual builder's 枠連 selection cells and
// FillGuide's 1-8 grid, so the stripe can never drift from the bracket UI a user
// matches it against. That palette reuses JRA's waku convention through
// Keibamon's tokens (see styles.css :root) — the colour IS the bracket's
// identity at the track, the way silks are, so it reads as information rather
// than imitated identity.
//
// Returns null when gate is absent (a pre-entries race before the barrier draw
// is published) — the stripe is the data, not chrome, so a race with no draw
// simply has no stripe.
import type { ReactNode } from "react";

export function BracketStripe({ gate }: { gate: number | null | undefined }): ReactNode {
  if (typeof gate !== "number" || !Number.isFinite(gate) || gate < 1 || gate > 8) return null;
  return <span className={`bracket-stripe bracket-${gate}`} aria-hidden="true" />;
}
