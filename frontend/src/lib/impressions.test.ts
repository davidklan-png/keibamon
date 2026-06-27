// @vitest-environment jsdom
//
// ============================================================================
// Impression store (ADR-0011 D3, Phase 1) — pure-layer tests.
//
// What this pins:
//   - Composite key is `${race_id}|${horse_key}` where horse_key is NFKC'd.
//   - setImpression / clearImpression are non-mutating (new map returned).
//   - Toggle-off (mark === null) deletes the entry — same as old delete copy[uma].
//   - impressionsByRace is namespace-isolated (other races don't leak in).
//   - clearRace removes only the targeted race's marks.
//   - Odds context is stamped AT MARK TIME (not changed on later writes).
//   - Key stability across umaban renumber: a horse keyed by NAME survives a
//     umaban shift (the foundational win of the new store over the uma-keyed
//     Record).
//
// localStorage I/O is exercised via an in-memory stub (matches the pattern
// in auth/ticketQueue.test.ts). The production module reads through
// `globalThis.localStorage`, which `vi.stubGlobal("localStorage", stub)`
// installs.
// ============================================================================
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  KBM_IMPRESSIONS_KEY,
  impressionKey,
  getImpression,
  setImpression,
  clearImpression,
  impressionsByRace,
  clearRace,
  loadImpressions,
  saveImpressions,
  wipeImpressions,
  type ImpressionMap,
} from "./impressions";

const RACE_A = "20260628|Hakodate|11|Hakodate Kinen";
const RACE_B = "20260628|Fukushima|9|Radio NIKKEI Sho";

/** In-memory localStorage stub (compatible subset; same shape as ticketQueue.test). */
function installFakeLocalStorage() {
  const store = new Map<string, string>();
  const stub = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", stub);
  return stub;
}

beforeEach(() => {
  installFakeLocalStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("impressionKey — composite key build", () => {
  it("builds `${race_id}|${horse_key}` for a normal name", () => {
    expect(impressionKey(RACE_A, "Danon Decile")).toBe(
      `${RACE_A}|DanonDecile`,
    );
  });

  it("returns null when race_id is empty / null / undefined", () => {
    expect(impressionKey("", "Horse")).toBeNull();
    expect(impressionKey(null, "Horse")).toBeNull();
    expect(impressionKey(undefined, "Horse")).toBeNull();
  });

  it("returns null when the name normalizes to empty", () => {
    // Whitespace-only name → normalizeName returns null → key is null.
    expect(impressionKey(RACE_A, "   ")).toBeNull();
    expect(impressionKey(RACE_A, "")).toBeNull();
    expect(impressionKey(RACE_A, null)).toBeNull();
  });

  it("NFKC-normalizes the horse name into the key (parity with Worker)", () => {
    // Full-width whitespace folds + strips — the same transform
    // /api/horses/:name/form applies server-side.
    expect(impressionKey(RACE_A, "ダノン\u3000デサイル")).toBe(
      `${RACE_A}|ダノンデサイル`,
    );
  });
});

describe("getImpression", () => {
  it("returns null when the impression is absent", () => {
    expect(getImpression({}, RACE_A, "Horse A")).toBeNull();
  });

  it("returns null for an unstoreable key (empty race_id)", () => {
    const map: ImpressionMap = {
      [`${RACE_A}|HorseA`]: {
        mark: "like",
        umaban: 1,
        odds_when_marked: 3.2,
        odds_snapshot_at: "2026-06-27T06:49:22Z",
        formed_at: 1000,
      },
    };
    expect(getImpression(map, "", "Horse A")).toBeNull();
  });

  it("returns the stored impression when present", () => {
    const key = impressionKey(RACE_A, "Horse A")!;
    const imp = {
      mark: "like" as const,
      umaban: 1,
      odds_when_marked: 3.2,
      odds_snapshot_at: "2026-06-27T06:49:22Z",
      formed_at: 1000,
    };
    expect(getImpression({ [key]: imp }, RACE_A, "Horse A")).toEqual(imp);
  });
});

describe("setImpression", () => {
  it("writes a new impression and returns a new map (non-mutating)", () => {
    const prev: ImpressionMap = {};
    const next = setImpression(prev, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
      odds_when_marked: 3.2,
      odds_snapshot_at: "2026-06-27T06:49:22Z",
    });
    // Original map is untouched.
    expect(prev).toEqual({});
    // New map has the entry under the composite key.
    expect(next[impressionKey(RACE_A, "Horse A")!]).toMatchObject({
      mark: "like",
      umaban: 1,
      odds_when_marked: 3.2,
    });
    // formed_at is stamped (deterministic when now is injected).
    const stamped = setImpression(
      {},
      RACE_A,
      "Horse A",
      { mark: "like", umaban: 1 },
      12345,
    );
    expect(
      stamped[impressionKey(RACE_A, "Horse A")!].formed_at,
    ).toBe(12345);
  });

  it("overwrites a prior mark for the same horse (mutually-exclusive taxonomy)", () => {
    const prev = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
      odds_when_marked: 3.2,
      odds_snapshot_at: "t0",
    });
    const next = setImpression(prev, RACE_A, "Horse A", {
      mark: "avoid",
      umaban: 1,
      odds_when_marked: 3.5,
      odds_snapshot_at: "t1",
    });
    const entry = next[impressionKey(RACE_A, "Horse A")!];
    expect(entry.mark).toBe("avoid");
    expect(entry.odds_when_marked).toBe(3.5);
    // Only one entry for the (race, horse) pair — no duplicates.
    expect(Object.keys(next).length).toBe(1);
  });

  it("toggling off (mark === null) deletes the entry — same as old delete copy[uma]", () => {
    const prev = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
    });
    const next = setImpression(prev, RACE_A, "Horse A", {
      mark: null,
      umaban: 1,
    });
    // Entry is gone.
    expect(next[impressionKey(RACE_A, "Horse A")!]).toBeUndefined();
    // The map is still a fresh object (referential inequality).
    expect(next).not.toBe(prev);
  });

  it("toggle-off is a no-op (returns prev referentially) when no entry exists", () => {
    const prev: ImpressionMap = {};
    const next = setImpression(prev, RACE_A, "Horse A", {
      mark: null,
      umaban: 1,
    });
    expect(next).toBe(prev);
  });

  it("returns prev referentially when the key is unstoreable", () => {
    // Empty race_id → key is null → no-op.
    const prev: ImpressionMap = {};
    const next = setImpression(prev, "", "Horse A", {
      mark: "like",
      umaban: 1,
    });
    expect(next).toBe(prev);
  });

  it("stamps odds context AT MARK TIME (a later odds drift does NOT mutate the entry)", () => {
    // Phase 2's drift UI reads odds_when_marked vs the live snapshot; this
    // assertion pins the anchor.
    const t0 = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
      odds_when_marked: 3.2,
      odds_snapshot_at: "2026-06-27T06:49:22Z",
    });
    // A second write to the SAME horse with DIFFERENT odds overwrites (it's
    // a new mark, not an update of just the odds field). This is correct:
    // the user toggled off + on again, and the new mark carries the new
    // odds context.
    const t1 = setImpression(t0, RACE_A, "Horse A", {
      mark: "distrust",
      umaban: 1,
      odds_when_marked: 5.1,
      odds_snapshot_at: "2026-06-27T07:30:00Z",
    });
    expect(t1[impressionKey(RACE_A, "Horse A")!]).toMatchObject({
      mark: "distrust",
      odds_when_marked: 5.1,
      odds_snapshot_at: "2026-06-27T07:30:00Z",
    });
  });

  it("keeps marks for two horses in the same race distinct", () => {
    let map: ImpressionMap = {};
    map = setImpression(map, RACE_A, "Horse A", { mark: "like", umaban: 1 });
    map = setImpression(map, RACE_A, "Horse B", { mark: "avoid", umaban: 2 });
    expect(Object.keys(map).length).toBe(2);
    expect(getImpression(map, RACE_A, "Horse A")!.mark).toBe("like");
    expect(getImpression(map, RACE_A, "Horse B")!.mark).toBe("avoid");
  });
});

describe("clearImpression", () => {
  it("removes a single impression", () => {
    let map: ImpressionMap = {};
    map = setImpression(map, RACE_A, "Horse A", { mark: "like", umaban: 1 });
    map = setImpression(map, RACE_A, "Horse B", { mark: "avoid", umaban: 2 });
    const next = clearImpression(map, RACE_A, "Horse A");
    expect(next[impressionKey(RACE_A, "Horse A")!]).toBeUndefined();
    expect(next[impressionKey(RACE_A, "Horse B")!]).toBeDefined();
  });

  it("is a no-op (referential equality) when the entry doesn't exist", () => {
    const prev: ImpressionMap = {};
    expect(clearImpression(prev, RACE_A, "Horse A")).toBe(prev);
  });
});

describe("impressionsByRace — namespace isolation", () => {
  it("returns only impressions whose key starts with `${raceId}|`", () => {
    let map: ImpressionMap = {};
    map = setImpression(map, RACE_A, "Horse A", { mark: "like", umaban: 1 });
    map = setImpression(map, RACE_A, "Horse B", { mark: "avoid", umaban: 2 });
    map = setImpression(map, RACE_B, "Horse Z", { mark: "like", umaban: 9 });
    const aView = impressionsByRace(map, RACE_A);
    expect(Object.keys(aView).sort()).toEqual(["HorseA", "HorseB"]);
    const bView = impressionsByRace(map, RACE_B);
    expect(Object.keys(bView)).toEqual(["HorseZ"]);
  });

  it("returns {} when the raceId is empty", () => {
    const map = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
    });
    expect(impressionsByRace(map, "")).toEqual({});
  });

  it("does NOT match a raceId that's a prefix of another (delimiter safety)", () => {
    // Guard against a substring prefix accidentally matching. The delimiter
    // `|` after raceId is what prevents this — the test pins it.
    const r1 = "20260628|Hakodate|1";
    const r2 = "20260628|Hakodate|11"; // r1 is a prefix of r2
    let map: ImpressionMap = {};
    map = setImpression(map, r2, "Horse A", { mark: "like", umaban: 1 });
    // impressionsByRace(r1) must NOT pick up r2's entry.
    expect(impressionsByRace(map, r1)).toEqual({});
    expect(Object.keys(impressionsByRace(map, r2))).toEqual(["HorseA"]);
  });
});

describe("clearRace", () => {
  it("removes only the targeted race's marks; preserves other races", () => {
    let map: ImpressionMap = {};
    map = setImpression(map, RACE_A, "Horse A", { mark: "like", umaban: 1 });
    map = setImpression(map, RACE_A, "Horse B", { mark: "avoid", umaban: 2 });
    map = setImpression(map, RACE_B, "Horse Z", { mark: "like", umaban: 9 });
    const next = clearRace(map, RACE_A);
    expect(Object.keys(next).length).toBe(1);
    expect(getImpression(next, RACE_B, "Horse Z")!.mark).toBe("like");
    expect(impressionsByRace(next, RACE_A)).toEqual({});
  });

  it("returns prev referentially when the race had no marks (no spurious re-render)", () => {
    const map = setImpression({}, RACE_B, "Horse Z", {
      mark: "like",
      umaban: 9,
    });
    expect(clearRace(map, RACE_A)).toBe(map);
  });

  it("returns prev referentially when raceId is empty", () => {
    const map = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
    });
    expect(clearRace(map, "")).toBe(map);
  });
});

describe("key stability across umaban renumber", () => {
  // The foundational win of the new store over the old uma-keyed Record:
  // a horse's mark survives a umaban shift. Real scenario: a scratch in a
  // neighboring horse bumps everyone after it down by one. Under the old
  // Record<uma, IntuitionState>, the mark would be lost (it was keyed by
  // the OLD umaban). Under the new store, the mark is keyed by NAME — the
  // renumber only updates the umaban field inside the value.
  it("a mark made against umaban=5 still resolves after a scratch bumps it to umaban=4", () => {
    const horseName = "Crystal Knight";
    let map: ImpressionMap = {};
    map = setImpression(map, RACE_A, horseName, {
      mark: "like",
      umaban: 5,
      odds_when_marked: 12.0,
      odds_snapshot_at: "2026-06-27T06:49:22Z",
    });
    // Scratch bumps Crystal Knight from #5 to #4. The user (or app) writes
    // a new impression record with the SAME name but the NEW umaban. Same
    // key → overwrites, umaban field updates.
    map = setImpression(map, RACE_A, horseName, {
      mark: "like",
      umaban: 4,
      odds_when_marked: 12.0,
      odds_snapshot_at: "2026-06-27T06:49:22Z",
    });
    const entry = getImpression(map, RACE_A, horseName);
    expect(entry).not.toBeNull();
    expect(entry!.umaban).toBe(4);
    expect(entry!.mark).toBe("like");
  });
});

// ---------------------------------------------------------------------------
// localStorage shell — exercised against the in-memory stub installed in
// beforeEach. The stub is shape-compatible with the browser Storage the
// production module reads through (globalThis.localStorage).
// ---------------------------------------------------------------------------

describe("localStorage shell", () => {
  it("loadImpressions returns {} when storage is empty", () => {
    expect(loadImpressions()).toEqual({});
  });

  it("saveImpressions then loadImpressions round-trips the map", () => {
    const map = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
    });
    saveImpressions(map);
    const loaded = loadImpressions();
    expect(loaded).toEqual(map);
  });

  it("loadImpressions returns {} on a corrupt blob (does not throw)", () => {
    localStorage.setItem(KBM_IMPRESSIONS_KEY, "{not json");
    expect(loadImpressions()).toEqual({});
  });

  it("saveImpressions swallows quota errors (does not throw)", () => {
    const map = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
    });
    // Replace the stub's setItem with one that throws — the production
    // code's try/catch must swallow the error.
    vi.stubGlobal("localStorage", {
      ...localStorage,
      setItem: () => {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      },
    });
    expect(() => saveImpressions(map)).not.toThrow();
  });

  it("wipeImpressions removes the store key", () => {
    const map = setImpression({}, RACE_A, "Horse A", {
      mark: "like",
      umaban: 1,
    });
    saveImpressions(map);
    wipeImpressions();
    expect(localStorage.getItem(KBM_IMPRESSIONS_KEY)).toBeNull();
  });
});
