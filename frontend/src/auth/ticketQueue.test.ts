// ADR-0007 Phase 2 — offline commit queue tests.
//
// No jsdom dependency (kept the dev-deps slim, same as Phase 1). We stub
// globalThis.localStorage with an in-memory Map per test; the production
// module uses the global, which exists in browsers.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { loadPending, pushPending, clearPending, pendingKey } from "./ticketQueue";
import type { CommittedTicket } from "../lib/types";

function mk(id: string, createdAt = 0): CommittedTicket {
  return {
    id,
    serial: "KB-" + id,
    ticket: {
      id: "t-" + id,
      type: "quinella",
      lines: [{ combo: ["1", "2"], prob: 0.1, fairOdds: 10, payout: 1000, tag: "blend" }],
      hitProb: 0.1,
      cost: 100,
      expectedReturn: 90,
      avgPayout: 1000,
      bestCaseReturn: 1000,
      core: ["1", "2"],
      tag: "blend",
      unit: 100,
      variance: "low",
      rationaleKeys: [],
    },
    unit: 100,
    mood: "safer",
    state: "open",
    payoutBase: 1000,
    race: {
      raceKey: "k|" + id,
      grade: "",
      nameEn: "n",
      nameJa: "n",
      venueEn: "v",
      venueJa: "v",
      raceNo: 1,
      dateEn: "",
      dateJa: "",
      post: "",
      runners: [],
    },
    owner: "you",
    claps: 0,
    createdAt,
  };
}

/** In-memory localStorage stub. Compatible with the subset the module uses. */
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

describe("ticketQueue", () => {
  beforeEach(() => {
    installFakeLocalStorage();
  });

  it("starts empty for a new user", () => {
    expect(loadPending("user_a")).toEqual([]);
  });

  it("returns [] when signed out (null userId)", () => {
    pushPending(null, mk("kb-1"));
    expect(loadPending(null)).toEqual([]);
  });

  it("append + read + clear round-trips a pending ticket", () => {
    pushPending("user_a", mk("kb-1"));
    pushPending("user_a", mk("kb-2"));
    expect(loadPending("user_a").map((t) => t.id)).toEqual(["kb-1", "kb-2"]);
    clearPending("user_a");
    expect(loadPending("user_a")).toEqual([]);
  });

  it("de-dupes by id when the same commit is queued twice", () => {
    pushPending("user_a", mk("kb-1"));
    pushPending("user_a", mk("kb-1"));
    const items = loadPending("user_a");
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("kb-1");
  });

  it("namespaces per user (A's queue does not leak into B)", () => {
    pushPending("user_a", mk("kb-a"));
    pushPending("user_b", mk("kb-b"));
    expect(loadPending("user_a").map((t) => t.id)).toEqual(["kb-a"]);
    expect(loadPending("user_b").map((t) => t.id)).toEqual(["kb-b"]);
    clearPending("user_a");
    expect(loadPending("user_a")).toEqual([]);
    expect(loadPending("user_b").map((t) => t.id)).toEqual(["kb-b"]);
  });

  it("evicts the oldest entry past the 50-row cap (FIFO)", () => {
    for (let i = 0; i < 60; i++) pushPending("user_a", mk(`kb-${i}`, i));
    const items = loadPending("user_a");
    expect(items).toHaveLength(50);
    // Oldest 10 (kb-0 … kb-9) are gone; kb-10 is now the head.
    expect(items[0].id).toBe("kb-10");
    expect(items[items.length - 1].id).toBe("kb-59");
  });

  it("survives a malformed localStorage entry (resets to empty)", () => {
    localStorage.setItem(pendingKey("user_a"), "{not json");
    expect(loadPending("user_a")).toEqual([]);
    // And a subsequent push works.
    pushPending("user_a", mk("kb-1"));
    expect(loadPending("user_a").map((t) => t.id)).toEqual(["kb-1"]);
  });

  it("survives a non-array `items` field (resets to empty)", () => {
    localStorage.setItem(pendingKey("user_a"), JSON.stringify({ v: 1, items: "nope" }));
    expect(loadPending("user_a")).toEqual([]);
  });
});
