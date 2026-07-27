// ============================================================================
// ticketStructure tests — the ONE interpreter both renderers consume.
//
// What this pins:
//   - interpretTicket precedence: formation → wheel → box (explicit, else
//     derived) → chips.
//   - Wheel reconstruction: axis@position + opponents → k-length position
//     columns + axisPosition (had NO coverage when it lived inline in FillGuide).
//   - deriveBoxSet (moved here from TicketLines): full box → set; partial /
//     single → null; bracket cross-box + ゾロ目 handling + false-positive guard.
//
// Pure (no React) — like the derivation tests it absorbed.
// ============================================================================
import { describe, it, expect } from "vitest";
import { winProbs, type Runner, type ValueTag } from "./fairvalue";
import {
  buildBoxTicket,
  buildFormationTicket,
  buildWheelTicket,
} from "./recommender";
import type { Ticket } from "./types";
import { deriveBoxSet, interpretTicket, isOrderedType } from "./ticketStructure";

const RUNNERS: Runner[] = [
  { uma: "1", odds: 2.4, name: "A" },
  { uma: "2", odds: 3.5, name: "B" },
  { uma: "3", odds: 6.2, name: "C" },
  { uma: "4", odds: 9.0, name: "D" },
  { uma: "5", odds: 18.5, name: "E" },
];
const { p } = winProbs(RUNNERS);
const allUmas = RUNNERS.map((r) => r.uma);

/** Build a minimal flat (no-structure) Ticket from raw combos — for derivation + chips tests. */
function flatTicket(type: Ticket["type"], combos: string[][], unit = 100): Ticket {
  const core = [...new Set(combos.flat())];
  return {
    id: "flat-test",
    type,
    lines: combos.map((combo) => ({
      combo,
      prob: 0.1,
      fairOdds: 10,
      payout: 1000,
      tag: "fair" as ValueTag,
    })),
    hitProb: 0.1,
    cost: combos.length * unit,
    expectedReturn: combos.length * 100,
    avgPayout: 1000,
    bestCaseReturn: 1000,
    core,
    tag: "fair" as ValueTag,
    unit,
    variance: "high",
    rationaleKeys: [],
  };
}

/** All 6 permutations of {1,2,3} — a full trifecta box (P(3,3)=6). Used to prove
 * the degenerate-payload guard is load-bearing: these lines alone WOULD derive
 * a box, so only the guard keeps an ordered-structured ticket off the box path. */
const FULL_TRIFECTA_BOX: string[][] = [
  ["1", "2", "3"],
  ["1", "3", "2"],
  ["2", "1", "3"],
  ["2", "3", "1"],
  ["3", "1", "2"],
  ["3", "2", "1"],
];

describe("interpretTicket", () => {
  // ---- Formation ---------------------------------------------------------
  it("formation: carries the per-position contender sets", () => {
    const set = ["1", "2", "3"];
    const ticket = buildFormationTicket("trifecta", [set, set, set], p, allUmas, 100, "x");
    const view = interpretTicket(ticket!);
    expect(view.mode).toBe("formation");
    if (view.mode !== "formation") return;
    expect(view.positions).toEqual([
      ["1", "2", "3"],
      ["1", "2", "3"],
      ["1", "2", "3"],
    ]);
  });

  it("formation: exacta carries two position columns", () => {
    const set = ["1", "2", "3", "4"];
    const ticket = buildFormationTicket("exacta", [set, set], p, allUmas, 100, "x");
    const view = interpretTicket(ticket!);
    expect(view.mode).toBe("formation");
    if (view.mode !== "formation") return;
    expect(view.positions).toHaveLength(2);
  });

  // ---- Wheel (the reconstruction that had no coverage inline in FillGuide) --
  it("wheel (trifecta, axis@1st): reconstructs 3 columns — axis in slot 1, opponents elsewhere", () => {
    const ticket = buildWheelTicket(
      "trifecta",
      ["1"],
      ["2", "3", "4"],
      1,
      p,
      allUmas,
      100,
      "x",
    );
    const view = interpretTicket(ticket!);
    expect(view.mode).toBe("wheel");
    if (view.mode !== "wheel") return;
    expect(view.axisPosition).toBe(1);
    expect(view.axis).toEqual(["1"]);
    expect(view.opponents).toEqual(["2", "3", "4"]);
    // Slot 1 = axis; slots 2 + 3 = opponents (the same set, the cartesian
    // expansion is the kernel's job — interpretation just reconstructs columns).
    expect(view.positions).toEqual([
      ["1"],
      ["2", "3", "4"],
      ["2", "3", "4"],
    ]);
  });

  it("wheel (trifecta, axis@2nd): axis lands in slot 2, opponents in 1 + 3", () => {
    const ticket = buildWheelTicket(
      "trifecta",
      ["5"],
      ["1", "2"],
      2,
      p,
      allUmas,
      100,
      "x",
    );
    const view = interpretTicket(ticket!);
    expect(view.mode).toBe("wheel");
    if (view.mode !== "wheel") return;
    expect(view.axisPosition).toBe(2);
    expect(view.positions).toEqual([
      ["1", "2"],
      ["5"],
      ["1", "2"],
    ]);
  });

  it("wheel (exacta, axis@1st): reconstructs 2 columns", () => {
    const ticket = buildWheelTicket("exacta", ["1"], ["2", "3"], 1, p, allUmas, 100, "x");
    const view = interpretTicket(ticket!);
    expect(view.mode).toBe("wheel");
    if (view.mode !== "wheel") return;
    expect(view.axisPosition).toBe(1);
    expect(view.positions).toEqual([["1"], ["2", "3"]]);
  });

  it("wheel: a multi-horse axis carries every axis horse", () => {
    const ticket = buildWheelTicket(
      "trifecta",
      ["1", "2"],
      ["3", "4"],
      1,
      p,
      allUmas,
      100,
      "x",
    );
    const view = interpretTicket(ticket!);
    expect(view.mode).toBe("wheel");
    if (view.mode !== "wheel") return;
    expect(view.axis).toEqual(["1", "2"]);
    expect(view.positions[0]).toEqual(["1", "2"]);
  });

  // ---- Box (explicit) ----------------------------------------------------
  it("box: explicit payload set is carried verbatim, isBracket false for a horse box", () => {
    const ticket = buildBoxTicket("quinella", ["1", "2", "3", "4"], p, allUmas, 100, "x");
    const view = interpretTicket(ticket!);
    expect(view.mode).toBe("box");
    if (view.mode !== "box") return;
    expect(view.set).toEqual(["1", "2", "3", "4"]);
    expect(view.isBracket).toBe(false);
  });

  // ---- Box (derived from a legacy/flat ticket) ---------------------------
  it("box: a legacy flat ticket that IS a full box derives the set", () => {
    const ticket = flatTicket("trifecta", [
      ["1", "2", "3"],
      ["1", "3", "2"],
      ["2", "1", "3"],
      ["2", "3", "1"],
      ["3", "1", "2"],
      ["3", "2", "1"],
    ]);
    const view = interpretTicket(ticket);
    expect(view.mode).toBe("box");
    if (view.mode !== "box") return;
    expect(view.set).toEqual(["1", "2", "3"]);
  });

  it("box: a derived bracket box flags isBracket", () => {
    const ticket = flatTicket("bracket_quinella", [
      ["3", "7"],
      ["3", "8"],
      ["7", "8"],
    ]);
    const view = interpretTicket(ticket);
    expect(view.mode).toBe("box");
    if (view.mode !== "box") return;
    expect(view.set).toEqual(["3", "7", "8"]);
    expect(view.isBracket).toBe(true);
  });

  // ---- Chips (legacy / single / non-box) ---------------------------------
  it("chips: a flat non-box ticket falls through to chips", () => {
    const ticket = flatTicket("trifecta", [
      ["1", "2", "3"],
      ["2", "1", "3"],
      ["3", "2", "1"],
    ]);
    expect(interpretTicket(ticket).mode).toBe("chips");
  });

  it("chips: a single-combination ticket falls through to chips", () => {
    // A 2-horse quinella = C(2,2)=1 combo — not a multi-way box, so chips.
    expect(interpretTicket(flatTicket("quinella", [["1", "2"]])).mode).toBe("chips");
  });

  // ---- Precedence --------------------------------------------------------
  it("precedence: a wheel ticket is never mis-read as a box (formation/wheel checked first)", () => {
    // A wheel whose axis + opponents happen to cover the full field would look
    // box-like to a naive check; the branch order keeps it a wheel.
    const ticket = buildWheelTicket(
      "trifecta",
      ["1"],
      ["2", "3"],
      1,
      p,
      allUmas,
      100,
      "x",
    );
    expect(interpretTicket(ticket!).mode).toBe("wheel");
  });

  // ---- Degenerate ordered-structure payload → chips (never-mis-render guard)
  // A persisted/shared ticket can carry structure:"formation"|"wheel" with a
  // payload the renderer can't use (empty positions, or a null wheel payload).
  // Such a ticket is ambiguous → chips, NOT a box derivation of the flat lines.
  it("guard: structure='formation' with empty positions → chips, never box-derived", () => {
    // Lines ARE a full trifecta box — without the guard, deriveBoxSet returns
    // ["1","2","3"] and this mis-renders as a BOX. The guard must force chips.
    const ticket: Ticket = {
      ...flatTicket("trifecta", FULL_TRIFECTA_BOX),
      structure: "formation",
      structurePayload: { positions: [] },
    };
    expect(interpretTicket(ticket).mode).toBe("chips");
  });

  it("guard: structure='wheel' with a null payload → chips, never box-derived", () => {
    const ticket: Ticket = {
      ...flatTicket("trifecta", FULL_TRIFECTA_BOX),
      structure: "wheel",
      structurePayload: null,
    };
    expect(interpretTicket(ticket).mode).toBe("chips");
  });
});

describe("deriveBoxSet", () => {
  it("full ordered box → set; partial → null; single → null", () => {
    expect(
      deriveBoxSet(
        flatTicket("trifecta", [
          ["1", "2", "3"],
          ["1", "3", "2"],
          ["2", "1", "3"],
          ["2", "3", "1"],
          ["3", "1", "2"],
          ["3", "2", "1"],
        ]),
      ),
    ).toEqual(["1", "2", "3"]);
    expect(
      deriveBoxSet(
        flatTicket("trifecta", [
          ["1", "2", "3"],
          ["2", "1", "3"],
        ]),
      ),
    ).toBeNull();
    // A single combination (2-horse quinella = C(2,2)=1) is not a multi-way box.
    expect(deriveBoxSet(flatTicket("quinella", [["1", "2"]]))).toBeNull();
  });

  it("bracket full cross-box → set; with ゾロ目 → set; partial → null", () => {
    // 3 brackets {3,7,8}: C(3,2)=3 cross pairs → the bracket set.
    expect(
      deriveBoxSet(
        flatTicket("bracket_quinella", [
          ["3", "7"],
          ["3", "8"],
          ["7", "8"],
        ]),
      ),
    ).toEqual(["3", "7", "8"]);
    // Same full cross-box PLUS a legal 3-3 ゾロ目 line — still the bracket set
    // (same-bracket pairs are permitted, not required).
    expect(
      deriveBoxSet(
        flatTicket("bracket_quinella", [
          ["3", "7"],
          ["3", "8"],
          ["7", "8"],
          ["3", "3"],
        ]),
      ),
    ).toEqual(["3", "7", "8"]);
    // Only 2 of 3 cross pairs → null (false-positive guard).
    expect(
      deriveBoxSet(
        flatTicket("bracket_quinella", [
          ["3", "7"],
          ["3", "8"],
        ]),
      ),
    ).toBeNull();
  });
});

describe("isOrderedType", () => {
  it("exacta + trifecta are ordered; quinella/wide/trio/bracket_quinella are not", () => {
    expect(isOrderedType("exacta")).toBe(true);
    expect(isOrderedType("trifecta")).toBe(true);
    expect(isOrderedType("quinella")).toBe(false);
    expect(isOrderedType("wide")).toBe(false);
    expect(isOrderedType("trio")).toBe(false);
    expect(isOrderedType("bracket_quinella")).toBe(false);
  });
});
