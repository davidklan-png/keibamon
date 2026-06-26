// ============================================================================
// Shared editorial guardrails for generated narrative.
//
// The Weekend Roundup generator exposes a NarrativeProvider seam so a future
// AI/drafting pass can rewrite headline / why / themes strings. The deterministic
// default is copy-safe (asserted at build time by weeklyReport.test.ts), but a
// non-deterministic provider could emit an edge/advice phrase at RUNTIME — long
// after tests have run. This module is the single chokepoint:
//
//   - BANNED_PHRASES: the canonical 7-phrase list, sourced here so the build-time
//     test scan and the runtime sanitizer can never drift apart.
//   - sanitizeNarrative(): every string a provider returns is passed through this
//     before it lands in the report. It rewrites a banned phrase to a neutral,
//     analytical substitute so the output stays honest without breaking grammar.
//
// Framing reminder: Keibamon output is recreational research framing, never
// betting advice. No "guaranteed / sure thing / lock / best bet / positive EV /
// beat the market / automated wager" — ever, from any source.
// ============================================================================

/** Canonical banned-phrase list for generated report copy. */
export const BANNED_PHRASES = [
  /\bguaranteed\b/i,
  /\bsure thing\b/i,
  /\block\b/i, // standalone betting "lock"
  /\bbeat the market\b/i,
  /\bbest bet\b/i,
  /\bpositive ev\b/i,
  /\bautomated wager/i,
] as const;

// Neutral substitutes — analytical framing, none themselves banned. Ordered to
// match BANNED_PHRASES so the two arrays stay parallel; a phrase maps to its
// rewrite at the same index.
const SAFE_SUBSTITUTES = [
  "projected",
  "contender",
  "frontrunner",
  "outpace the market read",
  "top selection",
  "value-shaped",
  "structured ticket",
] as const;

/**
 * Rewrite any banned phrase in `text` to its neutral substitute. Idempotent:
 * running it twice yields the same output as running it once (substitutes
 * contain no banned phrases). Non-string / empty input passes through.
 *
 * Used as the runtime guardrail on all NarrativeProvider output.
 *
 * NOTE: BANNED_PHRASES are deliberately NON-global so `.test()` consumers (the
 * build-time scan in weeklyReport.test.ts) stay stateless. A `g` flag would
 * make `.test()` advance `lastIndex` across loop iterations and silently skip
 * matches. Here we derive a global-flagged copy per phrase so `.replace`
 * scrubs EVERY occurrence (not just the first) without leaking state into the
 * shared constant.
 */
export function sanitizeNarrative(text: string): string {
  if (!text) return text;
  let out = text;
  for (let i = 0; i < BANNED_PHRASES.length; i++) {
    const globalRe = new RegExp(
      BANNED_PHRASES[i].source,
      BANNED_PHRASES[i].flags + "g",
    );
    out = out.replace(globalRe, SAFE_SUBSTITUTES[i]);
  }
  return out;
}
