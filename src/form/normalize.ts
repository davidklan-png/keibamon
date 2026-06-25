// NFKC name normalization — TS port of keibamon_core.marts.form.normalize_name.
//
// The publisher pre-computes `horse_name_key` from each row's horse_name using
// the Python `normalize_name`. The Worker must apply the same transform to the
// user-provided name in /api/horses/:name/form before binding to SQL, so a
// live name (e.g. "ダノンデサイル") matches its `horse_name_key`.
//
// Python: NFKC → drop ALL whitespace → strip → None if empty.
// JS: `String.prototype.normalize("NFKC")` exists and matches Python's
// `unicodedata.normalize("NFKC")`. The `\s+` regex differs slightly between
// the two (Python's is unicode-aware by default; JS needs the `u` flag), but
// after NFKC, full-width whitespace collapses to ASCII space which both
// engines match identically.

export function normalizeName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const nfkc = String(name).normalize("NFKC");
  const stripped = nfkc.replace(/\s+/gu, "").trim();
  return stripped || null;
}
