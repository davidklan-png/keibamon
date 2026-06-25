// Python parity for `round(x, n)`.
//
// Python's built-in `round` on floats uses round-half-EVEN (banker's), and
// operates on the float's binary representation (so e.g. `round(2.675, 2) ==
// 2.67` because the float is actually 2.67499...). JS `Math.round` is
// round-half-UP and operates on the same float bits.
//
// For typical racing ratios (wins/starts, top3/starts) the divergence only
// surfaces when the exact value sits at the .5 boundary in decimal — which can
// happen for power-of-2 denominators (8, 16, 32). To stay byte-for-byte aligned
// with the Python builder, we:
//   1. scale to integer space (n * 10^digits)
//   2. detect exact-half via float-tolerance (1e-9)
//   3. on exact-half: round to EVEN; otherwise: round half-up (matches Python
//      for non-half cases, since Math.round and Python agree everywhere except
//      at exact halves where Python goes even and JS rounds away from zero)

function roundHalfEven(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const f = Math.pow(10, digits);
  const scaled = x * f;
  const floor = Math.floor(scaled);
  const frac = scaled - floor;
  const tol = 1e-9;
  if (Math.abs(frac - 0.5) < tol) {
    // Exact half → round to even.
    const evenOne = floor % 2 === 0 ? floor : floor + 1;
    return evenOne / f;
  }
  // Standard rounding (matches Python for non-half cases).
  return Math.round(scaled) / f;
}

export function pyRound3(x: number): number {
  return roundHalfEven(x, 3);
}

export function pyRound2(x: number): number {
  return roundHalfEven(x, 2);
}
