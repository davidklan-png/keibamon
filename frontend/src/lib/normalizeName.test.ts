// Parity + edge-case tests for normalizeName.
//
// The function MUST produce byte-identical output to the Worker-side copy in
// `src/form/normalize.ts` (ADR-0011 D3). Since the frontend can't import the
// Worker module cleanly across the build boundary, parity is asserted at the
// string level against fixtures that exercise the same transforms the Worker
// hits. If you change one copy, change the other + add a fixture here that
// would catch the drift.
import { describe, it, expect } from "vitest";
import { normalizeName } from "./normalizeName";

describe("normalizeName — NFKC + whitespace strip", () => {
  it("returns null for null / undefined / empty input", () => {
    expect(normalizeName(null)).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
    expect(normalizeName("")).toBeNull();
    expect(normalizeName("   ")).toBeNull();
  });

  it("strips internal + edge whitespace (ASCII)", () => {
    // Internal whitespace is dropped (not collapsed) — matches Python.
    expect(normalizeName("Danon Decile")).toBe("DanonDecile");
    expect(normalizeName("  Starlight Vow ")).toBe("StarlightVow");
    expect(normalizeName("a b c")).toBe("abc");
  });

  it("collapses full-width whitespace under NFKC then strips it", () => {
    // U+3000 (full-width space) folds to ASCII space under NFKC, then \s+ drops it.
    expect(normalizeName("ダノン\u3000デサイル")).toBe("ダノンデサイル");
    // Mixed half-width + full-width in one string.
    expect(normalizeName("Danon\u3000 Decile")).toBe("DanonDecile");
  });

  it("folds full-width Latin digits + letters to half-width", () => {
    // Full-width Ｇ folds to G, Ｉ folds to I, etc. — same as gradeClass.
    expect(normalizeName("Ｄａｎｏｎ")).toBe("Danon");
  });

  it("preserves CJK content with no whitespace to strip", () => {
    expect(normalizeName("テスト馬")).toBe("テスト馬");
    expect(normalizeName("アラタ")).toBe("アラタ");
  });

  it("preserves mixed katakana + Latin content", () => {
    // Real JRA names mix scripts; NFKC must not alter either.
    expect(normalizeName("エピファネイア")).toBe("エピファネイア");
    expect(normalizeName("Cafe Buster")).toBe("CafeBuster");
  });

  it("returns null for an all-whitespace string after stripping", () => {
    // \t\n\r are all \s; NFKC leaves them; the replace drops them; trim leaves "".
    expect(normalizeName("\t\n\r ")).toBeNull();
  });

  it("coerces non-string input to string (defensive — same as Worker side)", () => {
    // The Worker's version has the same String(name) coercion so a number
    // slipping through doesn't throw.
    expect(normalizeName(123 as unknown as string)).toBe("123");
  });
});

// ---------------------------------------------------------------------------
// Cross-module drift gate. The fixtures below MUST produce the same output as
// the Worker-side src/form/normalize.ts. If you change either copy, run both
// test suites and confirm these fixtures still agree.
//
// Adding a new fixture here AND in any future Worker-side test file (the
// Worker doesn't currently have one — its parity is implicit via the
// publisher's pre-computed horse_name_key) keeps the drift visible.
// ---------------------------------------------------------------------------
describe("normalizeName — drift gate (Worker/frontend parity)", () => {
  const FIXTURES: Array<[input: string | null | undefined, expected: string | null]> = [
    // Real captured JRA names from the 2026 fixtures.
    ["アラタ", "アラタ"],
    ["ダノンデサイル", "ダノンデサイル"],
    // Latin names with internal spaces — the most common drift case.
    ["Danon Decile", "DanonDecile"],
    ["Starlight Vow", "StarlightVow"],
    // Full-width whitespace — the trap that bit a 2026-06 shutuba capture.
    ["テスト\u3000馬", "テスト馬"],
    // Edge: null must return null (not the string "null").
    [null, null],
    [undefined, null],
  ];

  for (const [input, expected] of FIXTURES) {
    it(`${JSON.stringify(input)} → ${JSON.stringify(expected)}`, () => {
      expect(normalizeName(input)).toBe(expected);
    });
  }
});
