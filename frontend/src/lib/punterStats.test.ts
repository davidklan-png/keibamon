import { describe, it, expect } from "vitest";
import { computePunterStats } from "./punterStats";
import type { CommittedTicket, CommittedState } from "./types";

// ---- fixture builder ------------------------------------------------------
// Minimal CommittedTicket factory. Only the fields the stats module reads are
// honoured; the rest are filled with stable placeholders. `state` defaults to
// "open" so each test must opt in to resolved states explicitly (defensive).

function mkTicket(opts: {
  id: string;
  state?: CommittedState;
  cost?: number;
  returned?: number;
  createdAt?: number;
  nameEn?: string;
  nameJa?: string;
  dateEn?: string;
  dateJa?: string;
  raceKey?: string;
}): CommittedTicket {
  const cost = opts.cost ?? 1000;
  return {
    id: opts.id,
    serial: "KB-" + opts.id.toUpperCase(),
    ticket: {
      id: "rec-" + opts.id,
      type: "quinella",
      lines: [
        { combo: ["3", "5"], prob: 0.1, fairOdds: 10, payout: 1000, tag: "blend" },
      ],
      hitProb: 0.1,
      cost,
      expectedReturn: cost * 0.9,
      avgPayout: 5000,
      bestCaseReturn: 1000,
      core: ["3", "5"],
      tag: "blend",
      unit: 100,
      variance: "low",
      rationaleKeys: [],
    },
    unit: 100,
    mood: "balanced",
    state: opts.state ?? "open",
    payoutBase: 5000,
    returned: opts.returned,
    race: {
      raceKey: opts.raceKey ?? "20260705|05|11|feature",
      grade: "G1",
      nameEn: opts.nameEn ?? "Takarazuka Kinen",
      nameJa: opts.nameJa ?? "宝塚記念",
      venueEn: "Hanshin",
      venueJa: "阪神",
      raceNo: 11,
      dateEn: opts.dateEn ?? "Jul 5, 2026",
      dateJa: opts.dateJa ?? "2026年7月5日",
      post: "15:40",
      runners: [],
    },
    owner: "you",
    claps: 0,
    createdAt: opts.createdAt ?? 1_000_000,
  };
}

describe("computePunterStats", () => {
  it("returns empty stats for an empty resolved list", () => {
    const s = computePunterStats([], "en");
    expect(s.resolvedCount).toBe(0);
    expect(s.wonCount).toBe(0);
    expect(s.missCount).toBe(0);
    expect(s.refundedCount).toBe(0);
    expect(s.wagered).toBe(0);
    expect(s.returned).toBe(0);
    expect(s.net).toBe(0);
    expect(s.roi).toBeNull();
    expect(s.biggestWin).toBeNull();
  });

  it("ignores open tickets (they are not part of history)", () => {
    const open = mkTicket({ id: "a", state: "open", cost: 1000 });
    const s = computePunterStats([open], "en");
    // Same shape as the empty-list case.
    expect(s.resolvedCount).toBe(0);
    expect(s.wagered).toBe(0);
    expect(s.biggestWin).toBeNull();
  });

  it("a single miss → wagered=cost, returned=0, net=-cost, roi=-1", () => {
    const miss = mkTicket({ id: "m1", state: "miss", cost: 1200 });
    const s = computePunterStats([miss], "en");
    expect(s.missCount).toBe(1);
    expect(s.wonCount).toBe(0);
    expect(s.wagered).toBe(1200);
    expect(s.returned).toBe(0);
    expect(s.net).toBe(-1200);
    expect(s.roi).toBe(-1);
    expect(s.biggestWin).toBeNull();
  });

  it("a single won → net = returned - cost, roi = net/cost", () => {
    const won = mkTicket({
      id: "w1",
      state: "won",
      cost: 1000,
      returned: 4200,
    });
    const s = computePunterStats([won], "en");
    expect(s.wonCount).toBe(1);
    expect(s.wagered).toBe(1000);
    expect(s.returned).toBe(4200);
    expect(s.net).toBe(3200);
    expect(s.roi).toBeCloseTo(3.2, 6);
    expect(s.biggestWin).not.toBeNull();
    expect(s.biggestWin?.amount).toBe(4200);
  });

  it("mixed won / miss / refunded → counts split, all contribute to wagered", () => {
    const tk = [
      mkTicket({ id: "w", state: "won", cost: 1000, returned: 3000 }),
      mkTicket({ id: "m", state: "miss", cost: 800 }),
      mkTicket({ id: "r", state: "refunded", cost: 500 }),
    ];
    const s = computePunterStats(tk, "en");
    expect(s.resolvedCount).toBe(3);
    expect(s.wonCount).toBe(1);
    expect(s.missCount).toBe(1);
    expect(s.refundedCount).toBe(1);
    // wagered = 1000 + 800 + 500
    expect(s.wagered).toBe(2300);
    // returned = won(3000) + miss(0) + refund(stake back = 500)
    expect(s.returned).toBe(3500);
    expect(s.net).toBe(1200);
  });

  it("refunded tickets are net-zero (stake returned), not losses", () => {
    const refund = mkTicket({ id: "r1", state: "refunded", cost: 1500 });
    const s = computePunterStats([refund], "en");
    expect(s.refundedCount).toBe(1);
    expect(s.wagered).toBe(1500);
    expect(s.returned).toBe(1500);
    expect(s.net).toBe(0);
    // roi = 0 / 1500 = 0 (break-even), NOT null (wagered > 0).
    expect(s.roi).toBe(0);
    expect(s.biggestWin).toBeNull();
  });

  it("refund-only history → biggestWin=null, won=0", () => {
    const refunds = [
      mkTicket({ id: "r1", state: "refunded", cost: 500 }),
      mkTicket({ id: "r2", state: "refunded", cost: 700 }),
    ];
    const s = computePunterStats(refunds, "en");
    expect(s.wonCount).toBe(0);
    expect(s.biggestWin).toBeNull();
    expect(s.wagered).toBe(1200);
    expect(s.returned).toBe(1200);
  });

  it("biggest win tie (two tickets, same returned) → keep the most recent by createdAt", () => {
    const older = mkTicket({
      id: "older",
      state: "won",
      cost: 1000,
      returned: 5000,
      createdAt: 1_000,
      nameEn: "Older race",
    });
    const newer = mkTicket({
      id: "newer",
      state: "won",
      cost: 1000,
      returned: 5000, // same amount → tie
      createdAt: 2_000,
      nameEn: "Newer race",
    });
    // Pass them in scrambled order to confirm we don't just keep the first.
    const s = computePunterStats([older, newer], "en");
    expect(s.biggestWin?.raceName).toBe("Newer race");

    const sReversed = computePunterStats([newer, older], "en");
    expect(sReversed.biggestWin?.raceName).toBe("Newer race");
  });

  it("biggest win picks the higher amount when amounts differ", () => {
    const small = mkTicket({
      id: "small",
      state: "won",
      cost: 1000,
      returned: 3000,
      createdAt: 9_999, // newer but smaller
    });
    const big = mkTicket({
      id: "big",
      state: "won",
      cost: 1000,
      returned: 10000,
      createdAt: 1, // older but bigger
    });
    const s = computePunterStats([small, big], "en");
    expect(s.biggestWin?.amount).toBe(10000);
  });

  it("locale=en → biggestWin uses nameEn + dateEn", () => {
    const won = mkTicket({
      id: "w",
      state: "won",
      cost: 1000,
      returned: 2000,
      nameEn: "Takamatsunomiya Kinen",
      nameJa: "高松宮記念",
      dateEn: "Mar 30, 2026",
      dateJa: "2026年3月30日",
      raceKey: "20260330|08|11|tku",
    });
    const s = computePunterStats([won], "en");
    expect(s.biggestWin).toEqual({
      amount: 2000,
      raceName: "Takamatsunomiya Kinen",
      raceKey: "20260330|08|11|tku",
      date: "Mar 30, 2026",
    });
  });

  it("locale=ja → biggestWin uses nameJa + dateJa", () => {
    const won = mkTicket({
      id: "w",
      state: "won",
      cost: 1000,
      returned: 2000,
      nameEn: "Takamatsunomiya Kinen",
      nameJa: "高松宮記念",
      dateEn: "Mar 30, 2026",
      dateJa: "2026年3月30日",
      raceKey: "20260330|08|11|tku",
    });
    const s = computePunterStats([won], "ja");
    expect(s.biggestWin).toEqual({
      amount: 2000,
      raceName: "高松宮記念",
      raceKey: "20260330|08|11|tku",
      date: "2026年3月30日",
    });
  });

  it("multi-line ticket cost is the precomputed ticket.cost (lines × unit)", () => {
    // A 3-line box at unit=200 → cost=600. We pass that precomputed cost on the
    // ticket and assert it is what flows into `wagered` — the stats module does
    // NOT recompute from lines.
    const multi = mkTicket({
      id: "box3",
      state: "miss",
      cost: 600, // 3 lines × 200
    });
    // Override unit/lines to reflect a real 3-line box; cost stays authoritative.
    multi.ticket.unit = 200;
    multi.ticket.lines = [
      { combo: ["1", "2"], prob: 0.1, fairOdds: 10, payout: 1000, tag: "blend" },
      { combo: ["1", "3"], prob: 0.1, fairOdds: 10, payout: 1000, tag: "blend" },
      { combo: ["2", "3"], prob: 0.1, fairOdds: 10, payout: 1000, tag: "blend" },
    ];
    const s = computePunterStats([multi], "en");
    expect(s.wagered).toBe(600);
    expect(s.net).toBe(-600);
  });

  it("zero wagered (defensive — shouldn't happen) → roi=null, no NaN", () => {
    // A resolved ticket with cost=0 is malformed but the function must not
    // divide by zero. It should return roi=null.
    const zero = mkTicket({ id: "z", state: "miss", cost: 0 });
    const s = computePunterStats([zero], "en");
    expect(s.wagered).toBe(0);
    expect(s.roi).toBeNull();
    expect(s.net).toBe(0);
  });
});
