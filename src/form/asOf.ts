// Port of backend/keibamon_api/main.py:_parse_as_of.
//
// Tolerant as_of → a UTC Date anchoring the PIT filter. Accepts:
//   - ISO timestamp (with or without offset; naive assumed JST, this being a
//     JRA app)
//   - date (YYYY-MM-DD / YYYYMMDD, taken as JST midnight)
//   - empty / null (→ now UTC)
//   - unparseable → now UTC
// Never throws.
//
// Companion helper `formatUtcIso` renders the canonical ISO-UTC string the
// publisher writes into `form_starts.available_at` AND the comparison value the
// Worker binds to `available_at < ?`. Using the exact same format on both ends
// makes the lexicographic TEXT comparison equal the chronological comparison
// (true as long as both strings share the YYYY-MM-DDTHH:MM:SS[Z|+00:00] shape;
// the publisher canonicalizes to "...Z").

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// Strict ISO match — mirrors what Python's datetime.fromisoformat accepts.
// Date-only, datetime-with-optional-seconds-and-fractionals, optional +HH:MM.
const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?\s*([+-]\d{2}:\d{2})?$/;

export function parseAsOf(raw: string | null | undefined): Date {
  if (!raw) return new Date();
  const text = raw.trim().replace(/Z$/, "+00:00");
  const m = text.match(ISO_RE);
  if (m) {
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    const h = m[4] !== undefined ? +m[4] : 0;
    const mi = m[5] !== undefined ? +m[5] : 0;
    const s = m[6] !== undefined ? +m[6] : 0;
    const fracMs = m[7] !== undefined ? Math.round(parseFloat("0." + m[7]) * 1000) : 0;
    const tz = m[8];
    let utcMs = Date.UTC(y, mo - 1, d, h, mi, s, fracMs);
    if (tz === undefined) {
      // Naive → assume JST. The Date.UTC above produced the "local JST wall clock
      // interpreted as UTC" instant; subtract +09:00 to get the real UTC instant.
      utcMs -= JST_OFFSET_MS;
    } else {
      // Offset present → shift from "wall clock + offset" to UTC. A +HH:MM tz
      // means the wall clock is ahead of UTC, so we subtract it.
      const sign = tz[0] === "+" ? -1 : 1;
      const hh = +tz.slice(1, 3);
      const mm = +tz.slice(4, 6);
      utcMs += sign * (hh * 60 + mm) * 60 * 1000;
    }
    return new Date(utcMs);
  }

  // Compact date form like 20260628.
  const digits = text.replace(/\D/g, "");
  if (digits.length >= 8) {
    const y = +digits.slice(0, 4);
    const mo = +digits.slice(4, 6);
    const d = +digits.slice(6, 8);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      // Naive midnight JST → UTC.
      return new Date(Date.UTC(y, mo - 1, d) - JST_OFFSET_MS);
    }
  }

  return new Date();
}

/** Canonical ISO-UTC string: "YYYY-MM-DDTHH:MM:SSZ". Both the publisher and the
 *  SQL bind use this so TEXT-compare = chronological compare. */
export function formatUtcIso(d: Date): string {
  // Isostring is "YYYY-MM-DDTHH:MM:SS.sssZ"; strip fractional seconds.
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
