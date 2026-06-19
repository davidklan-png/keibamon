import { describe, it, expect } from "vitest";
import { en } from "./en";
import { ja } from "./ja";

/**
 * ADR-0005 Phase 4 — honesty guardrails as behavior. The simplified surface must
 * not start making edge/advice claims, and the takeout reminder must still exist
 * so it stays one tap from any ticket.
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
    const all = values(en).join("  ");
    for (const re of BANNED) expect(all).not.toMatch(re);
  });

  it("takeout reminder copy still exists in both languages", () => {
    expect(en.tickets.houseEdgeNote.length).toBeGreaterThan(0);
    expect(en.explain.takeoutReminder.length).toBeGreaterThan(0);
    expect(ja.tickets.houseEdgeNote.length).toBeGreaterThan(0);
    expect(ja.explain.takeoutReminder.length).toBeGreaterThan(0);
  });

  it("not-betting-advice footer is present in both languages", () => {
    expect(en.footer.notAdvice).toMatch(/not betting advice/i);
    expect(ja.footer.notAdvice.length).toBeGreaterThan(0);
  });
});
