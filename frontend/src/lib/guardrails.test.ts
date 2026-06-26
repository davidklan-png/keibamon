import { describe, it, expect } from "vitest";
import { BANNED_PHRASES, sanitizeNarrative } from "./guardrails";

// ---------------------------------------------------------------------------
// Unit tests for the runtime narrative sanitizer (lib/guardrails.ts).
//
// The build-time scan (weeklyReport.test.ts) only sees static/sample strings.
// The NarrativeProvider seam means an LLM provider could emit a banned phrase
// at runtime; sanitizeNarrative is the chokepoint every provider return value
// passes through inside generateReport. These tests pin the sanitizer itself.
// ---------------------------------------------------------------------------

describe("guardrails.sanitizeNarrative", () => {
  it("rewrites every banned phrase to a non-banned substitute", () => {
    const cases: Array<[string, RegExp]> = [
      ["this is a guaranteed winner", /\bguaranteed\b/i],
      ["a real sure thing", /\bsure thing\b/i],
      ["it's a lock", /\block\b/i],
      ["will beat the market", /\bbeat the market\b/i],
      ["my best bet today", /\bbest bet\b/i],
      ["positive EV spot", /\bpositive ev\b/i],
      ["run an automated wager", /\bautomated wager/i],
    ];
    for (const [input, bannedRe] of cases) {
      expect(input).toMatch(bannedRe); // sanity: the input really is banned
      const out = sanitizeNarrative(input);
      for (const re of BANNED_PHRASES) {
        expect(out).not.toMatch(re);
      }
    }
  });

  it("is idempotent (running twice == once)", () => {
    const input = "the guaranteed best bet lock — positive EV, beat the market";
    const once = sanitizeNarrative(input);
    const twice = sanitizeNarrative(once);
    expect(twice).toBe(once);
  });

  it("leaves clean analytical copy untouched", () => {
    const clean = "A balanced shape with a clear favorite and real depth behind.";
    expect(sanitizeNarrative(clean)).toBe(clean);
  });

  it("scrubs EVERY occurrence, not just the first (repeats in one string)", () => {
    // A non-global regex + .replace() would leave the second occurrence alive.
    // The sanitizer derives a global copy so both are rewritten.
    const out = sanitizeNarrative(
      "a lock and another lock — best bet plus best bet, guaranteed and guaranteed",
    );
    for (const re of BANNED_PHRASES) {
      expect(out).not.toMatch(re);
    }
    // Both occurrences of each phrase were rewritten, not just one.
    const lockCount = (out.match(/\bfrontrunner\b/g) ?? []).length;
    expect(lockCount).toBe(2);
    const bestCount = (out.match(/\btop selection\b/g) ?? []).length;
    expect(bestCount).toBe(2);
  });

  it("passes empty / non-truthy strings through unchanged", () => {
    expect(sanitizeNarrative("")).toBe("");
  });
});
