// ============================================================================
// Lane entry tests (ADR-0011 Phase 2 — two-path entry).
//
// What this pins:
//   - loadFunnel/saveFunnel round-trip the "quick" | "research" lane through
//     localStorage (key kbm.funnel.v1).
//   - loadFunnel degrades cleanly on missing/invalid/unavailable storage
//     (returns null → first-launch intro card path).
//   - The lane + drift i18n keys exist in both EN and JA (so the header CTA
//     pills and the drift chip never render a raw dotted key).
//
// The funnel lib mirrors the impressions.ts I/O pattern (lazy ls() + try/catch),
// so SSR / storage-disabled environments degrade silently to in-memory state.
// ============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import {
  loadFunnel,
  saveFunnel,
  KBM_FUNNEL_KEY,
  type FunnelLane,
} from "../lib/funnel";

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => {
      store.clear();
    },
  };
}

describe("funnel lane store", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = makeStorage();
    vi.stubGlobal("localStorage", storage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when no lane is stored yet (first-launch path)", () => {
    expect(loadFunnel()).toBeNull();
  });

  it("round-trips 'quick' and 'research' through localStorage", () => {
    const lanes: FunnelLane[] = ["quick", "research"];
    for (const lane of lanes) {
      saveFunnel(lane);
      expect(storage.getItem(KBM_FUNNEL_KEY)).toBe(lane);
      expect(loadFunnel()).toBe(lane);
    }
  });

  it("returns null when the stored value is not a valid lane", () => {
    storage.setItem(KBM_FUNNEL_KEY, "bogus");
    expect(loadFunnel()).toBeNull();
  });

  it("returns null when localStorage is unavailable (SSR / disabled)", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadFunnel()).toBeNull();
    // saveFunnel must not throw — it degrades silently.
    expect(() => saveFunnel("quick")).not.toThrow();
  });

  it("survives a localStorage that throws on read (corrupt/quota)", () => {
    const throwing: Storage = {
      ...makeStorage(),
      getItem: () => {
        throw new Error("denied");
      },
    };
    vi.stubGlobal("localStorage", throwing);
    expect(loadFunnel()).toBeNull();
  });
});

describe("lane + drift i18n keys exist in both languages", () => {
  // The header CTA pills + the drift chip look these up via t("lane.quick")
  // etc. If a key is missing, t() returns "" (never a raw key) — but the pill
  // would render blank. Pin presence so the lane entry + drift UI are always
  // populated.
  const keys = [
    "lane.quick",
    "lane.research",
    "lane.quickHint",
    "lane.researchHint",
    "lane.introTitle",
    "lane.switchedTo",
    "drift.likedAt",
    "drift.nowAt",
    "drift.shorter",
    "drift.longer",
  ];

  function lookup(obj: unknown, path: string[]): unknown {
    let cur: unknown = obj;
    for (const p of path) {
      if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[p];
      } else {
        return undefined;
      }
    }
    return cur;
  }

  it("every key resolves to a non-empty string in EN and JA", () => {
    for (const key of keys) {
      const parts = key.split(".");
      const enVal = lookup(en, parts);
      const jaVal = lookup(ja, parts);
      expect(typeof enVal, `EN ${key}`).toBe("string");
      expect(typeof jaVal, `JA ${key}`).toBe("string");
      expect((enVal as string).length, `EN ${key} non-empty`).toBeGreaterThan(0);
      expect((jaVal as string).length, `JA ${key} non-empty`).toBeGreaterThan(0);
    }
  });
});
