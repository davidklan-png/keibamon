import { describe, it, expect } from "vitest";
import { storageKeyFor } from "./storageKey";

// ADR-0007 Phase 1 — Phase 0 keyed the committed-ticket log only by language.
// Phase 1 namespaces it per Clerk user; the signed-out path keeps the legacy
// key so the pre-auth sample regresses nothing.

describe("storageKeyFor", () => {
  it("returns a per-user namespaced key when signed in", () => {
    expect(storageKeyFor("ja", "user_abc")).toBe("kbm.v4.user_abc.ja");
    expect(storageKeyFor("en", "user_abc")).toBe("kbm.v4.user_abc.en");
  });

  it("falls back to the legacy Phase 0 key when signed out", () => {
    expect(storageKeyFor("ja", null)).toBe("kbm.v4.ja");
    expect(storageKeyFor("en", null)).toBe("kbm.v4.en");
  });

  it("handles unusual but valid Clerk ids without special-casing", () => {
    expect(storageKeyFor("ja", "user_123456")).toBe("kbm.v4.user_123456.ja");
  });
});
