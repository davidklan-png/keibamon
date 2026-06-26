import { describe, it, expect } from "vitest";
import {
  GLOSSARY_SECTIONS,
  ALL_GLOSSARY_TERMS,
  type GlossarySection,
} from "./glossary";

// Editorial guardrails — the glossary is reference material, not a tip sheet.
// Mirrors the i18n honesty guardrails (guardrails.test.ts) plus "best bet".
const BANNED = [
  /\bguaranteed\b/i,
  /\bsure thing\b/i,
  /\block\b/i, // betting "lock" — clock/blockade are fine (word boundary)
  /\bbeat the market\b/i,
  /\bbest bet\b/i,
  /\bpositive ev\b/i,
];

function sectionText(s: GlossarySection): string {
  return [
    s.titleEn,
    s.titleJa,
    ...s.terms.flatMap((t) => [t.en, t.ja, t.explanation]),
  ].join(" ");
}

describe("glossary data", () => {
  it("has six non-empty sections with stable ids", () => {
    const ids = GLOSSARY_SECTIONS.map((s) => s.id);
    expect(ids).toEqual([
      "types",
      "tracks",
      "mechanics",
      "horses",
      "betting",
      "stats",
    ]);
    for (const s of GLOSSARY_SECTIONS) {
      expect(s.titleEn.length).toBeGreaterThan(0);
      expect(s.titleJa.length).toBeGreaterThan(0);
      expect(s.terms.length).toBeGreaterThan(0);
    }
  });

  it("every term has non-empty en / ja / explanation", () => {
    for (const t of ALL_GLOSSARY_TERMS) {
      expect(t.en.trim().length).toBeGreaterThan(0);
      expect(t.ja.trim().length).toBeGreaterThan(0);
      expect(t.explanation.trim().length).toBeGreaterThan(0);
    }
  });

  it("carries the documented term count (>= 80 reference terms)", () => {
    // The markdown source has 87 terms; allow growth, fail on shrinkage.
    expect(ALL_GLOSSARY_TERMS.length).toBeGreaterThanOrEqual(80);
  });

  it("uses no betting-advice / edge-claim language", () => {
    const all = GLOSSARY_SECTIONS.map(sectionText).join("  ");
    for (const re of BANNED) expect(all).not.toMatch(re);
  });

  it("explanations reference core analytical vocabulary (sanity)", () => {
    // The glossary SHOULD teach the analytical framing the report uses, so
    // assert a few load-bearing concepts are present somewhere.
    const all = ALL_GLOSSARY_TERMS.map((t) => t.explanation).join("  ");
    expect(all).toMatch(/devigg/); // devigged probability — core to market baseline
    expect(all).toMatch(/point-in-time|available_at/); // PIT framing
    expect(all).toMatch(/takeout/); // house-edge framing
  });
});
