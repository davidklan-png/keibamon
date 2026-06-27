import { describe, it, expect } from "vitest";
import { en } from "./en";
import { ja } from "./ja";

/**
 * Honesty guardrails as behavior. Two jobs:
 *   1. The full EN copy tree stays free of edge/advice phrases
 *      (guaranteed / sure thing / "lock" / beat the market).
 *   2. The single app-wide disclaimer (auth.disclaimer, acknowledged once at
 *      the 20+ age gate) exists in both EN and JA and carries every required
 *      clause. Scanned here so the wording can't drift by accident.
 */

function values(obj: unknown): string[] {
  if (typeof obj === "string") return [obj];
  if (obj && typeof obj === "object")
    return Object.values(obj as Record<string, unknown>).flatMap(values);
  return [];
}

const BANNED = [
  /\bguaranteed\b/i,
  /\bsure thing\b/i,
  /\block\b/i, // betting "lock"
  /\bbeat the market\b/i,
];

describe("honesty guardrails", () => {
  it("English copy makes no edge/advice claims", () => {
    const all = values(en).join(" ");
    for (const re of BANNED) expect(all).not.toMatch(re);
  });

  it("auth.disclaimer carries every required clause in both languages", () => {
    // The single app-wide disclaimer, acknowledged once at the 20+ gate. Each
    // language must carry every clause so the wording can't drift by accident.
    const enRequired = [
      /not betting advice/i,
      /winning method/i,
      /profit guarantee/i,
      /takeout/i,
    ];
    const jaRequired = [
      /投資助言/, // "betting advice" equivalent (lit. investment advice)
      /必勝法/, // "winning method"
      /利益の保証/, // "profit guarantee"
      /控除率/, // "takeout"
    ];
    expect(en.auth.disclaimer.length).toBeGreaterThan(0);
    expect(ja.auth.disclaimer.length).toBeGreaterThan(0);
    for (const re of enRequired) expect(en.auth.disclaimer).toMatch(re);
    for (const re of jaRequired) expect(ja.auth.disclaimer).toMatch(re);
  });
});
