// ============================================================================
// Shared formatting helpers (ADR-0007 Phase 5 extraction).
// Tiny pure helpers used across multiple screens — extracted so each screen
// file is self-contained without duplicating them.
// ============================================================================
export function yen(n: number): string {
  return "¥" + Math.round(n).toLocaleString();
}

export function fmt(n: number | undefined, d = 1): string {
  if (n == null || !isFinite(n)) return "-";
  return Number(n).toFixed(d);
}
