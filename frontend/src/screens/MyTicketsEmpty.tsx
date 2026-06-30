// ============================================================================
// Session 2 UX refactor — honest signed-out empty state for the My Tickets tab.
//
// Replaces the full-screen <SignInScreen/> that AuthGate used to render for
// signed-out visitors on this route. That full-bleed screen hid the Session 1
// bottom tab bar; this component stays inside the normal `.app` shell so the
// bar (and its clearance padding) remains visible.
//
// It also tells the truth: instead of fabricating a server ticket feed, it
// teases the user's LOCALLY-made impression marks (read from the localStorage
// impression store, which works signed-out) to motivate sign-in. When there
// are zero local marks it shows a gentler variant with no numbers.
//
// Pure-presentational w.r.t. auth: it reads openSignIn() from useAuth() itself
// (same context the header account slot uses), and takes the impression map as
// a prop so it's testable in isolation without touching localStorage.
// ============================================================================
import { useMemo } from "react";
import { useI18n } from "../i18n";
import { useAuth } from "../auth/AuthProvider";
import { Footer } from "../components/Footer";
import type { ImpressionMap } from "../lib/impressions";

export interface MyTicketsEmptyProps {
  /** Full in-memory impression map (localStorage mirror). */
  impressions: ImpressionMap;
}

/**
 * Count distinct marked horses (N) and distinct races with ≥1 mark (M) from
 * the impression map. Keys are `${race_id}|${horse_key}`; the store holds at
 * most one mark per horse, so:
 *   - N = number of entries (one entry == one marked horse).
 *   - M = number of distinct race_id prefixes.
 */
export function summarizeMarks(map: ImpressionMap): { horses: number; races: number } {
  const keys = Object.keys(map);
  const races = new Set<string>();
  for (const k of keys) {
    const sep = k.indexOf("|");
    races.add(sep >= 0 ? k.slice(0, sep) : k);
  }
  return { horses: keys.length, races: races.size };
}

export function MyTicketsEmpty({ impressions }: MyTicketsEmptyProps) {
  const { t, tFmt } = useI18n();
  const { openSignIn } = useAuth();

  const { horses, races } = useMemo(
    () => summarizeMarks(impressions),
    [impressions],
  );
  const hasMarks = horses > 0;

  return (
    <main className="app">
      <div className="mt-empty">
        <div className="mt-empty-mark" aria-hidden="true">
          競
        </div>
        <h1 className="mt-empty-title">{t("mineEmpty.title")}</h1>
        <p className="mt-empty-body">{t("mineEmpty.body")}</p>
        <p className="mt-empty-teaser">
          {hasMarks
            ? tFmt("mineEmpty.teaser", { n: horses, m: races })
            : t("mineEmpty.teaserEmpty")}
        </p>
        <button
          className="auth-primary mt-empty-cta"
          onClick={openSignIn}
          type="button"
        >
          {t("mineEmpty.signIn")}
        </button>
      </div>
      {/* Single-disclaimer posture: every top-level screen carries the Footer
          so the disclaimer is present here too (a signed-out fan can land on
          this screen straight from the Tickets tab). Matches the signed-in
          branch and the browse/reference screens. */}
      <Footer />
    </main>
  );
}
