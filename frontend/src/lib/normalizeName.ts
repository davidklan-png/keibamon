// NFKC name normalization — frontend-local copy of src/form/normalize.ts.
//
// PARITY CONTRACT (ADR-0011 D3): this function MUST produce byte-identical
// output to the Worker-side `normalizeName` in `src/form/normalize.ts`. The
// two copies exist because the Worker (wrangler/tsconfig) and frontend
// (vite/tsconfig) have separate build roots; cross-tree imports are fragile
// across them. The function is 5 lines, pure, and locked by Unicode semantics
// — duplication cost is negligible vs the bundling cost of a shared module.
//
// Why it matters: the impression store (lib/impressions.ts) keys marks by
// horse_key, and the Worker's /api/horses/:name/form route applies the same
// transform server-side before binding to SQL. If the two implementations
// ever diverge, a marked horse would no longer resolve to its form data —
// the impression-vs-drift feature in Phase 2 depends on this join.
//
// Python: NFKC → drop ALL whitespace → strip → None if empty.
// JS: `String.prototype.normalize("NFKC")` matches Python's
// `unicodedata.normalize("NFKC")`. The `\s+` regex differs slightly between
// the two (Python's is unicode-aware by default; JS needs the `u` flag), but
// after NFKC, full-width whitespace collapses to ASCII space which both
// engines match identically.
//
// Fixture-tested in normalizeName.test.ts against the same tricky inputs the
// Worker side hits (full-width whitespace, mixed katakana/Latin, etc.).

export function normalizeName(name: string | null | undefined): string | null {
  if (name === null || name === undefined) return null;
  const nfkc = String(name).normalize("NFKC");
  const stripped = nfkc.replace(/\s+/gu, "").trim();
  return stripped || null;
}
