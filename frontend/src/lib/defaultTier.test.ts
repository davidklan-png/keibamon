import { describe, it, expect } from "vitest";
import { recommend } from "./recommender";
import { winProbs, type Runner } from "./fairvalue";
import {
  DEFAULT_STYLE,
  PERSONALITY_PRESET,
  applyPersonality,
  moodKey,
  type PersonalityId,
} from "./types";

/**
 * ADR-0005 — the behavioral contract for the simplified default tier.
 * Encoded BEFORE the UI rework so simplification can't silently break the one
 * job: turn a feeling into a placeable ticket with no setup.
 */

const RUNNERS: Runner[] = [
  { uma: "1", odds: 2.4 },
  { uma: "2", odds: 3.5 },
  { uma: "3", odds: 6.2 },
  { uma: "4", odds: 9.0 },
  { uma: "5", odds: 18.5 },
  { uma: "6", odds: 51.0 },
  { uma: "7", odds: 8.5 },
  { uma: "8", odds: 13.0 },
];
const { p } = winProbs(RUNNERS);
const allUmas = RUNNERS.map((r) => r.uma);

const PERSONALITIES: PersonalityId[] = [
  "safe",
  "balanced",
  "longshot",
  "fan",
  "antiChalk",
];

describe("default tier: one tap, no preconditions", () => {
  it("DEFAULT_STYLE + empty intuition yields up to three placeable tickets", () => {
    const out = recommend({ allUmas, p, style: DEFAULT_STYLE, intuition: {} });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(3);
    for (const tk of out) {
      expect(tk.cost).toBeGreaterThan(0);
      expect(Number.isFinite(tk.avgPayout)).toBe(true);
      expect(tk.lines.length).toBeGreaterThan(0);
      // Every ticket must carry a plain mood label.
      expect(["safer", "balanced", "spicier"]).toContain(moodKey(tk));
    }
  });
});

describe("one control: personality derives flavor + complexity", () => {
  it("applyPersonality writes the preset for every personality", () => {
    for (const id of PERSONALITIES) {
      const s = applyPersonality(DEFAULT_STYLE, id);
      expect(s.personality).toBe(id);
      expect(s.flavor).toBe(PERSONALITY_PRESET[id].flavor);
      expect(s.complexity).toBe(PERSONALITY_PRESET[id].complexity);
    }
  });

  it("each personality produces a usable recommendation set", () => {
    for (const id of PERSONALITIES) {
      const style = applyPersonality(DEFAULT_STYLE, id);
      const out = recommend({ allUmas, p, style, intuition: {} });
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out.length).toBeLessThanOrEqual(3);
    }
  });
});
