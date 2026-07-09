// Stage 4 — parseTicketBody validation + derived flat columns (pure-function
// unit tests; the worker-level insert/owner paths are covered in social.test.ts).
import { describe, it, expect } from "vitest";
import { parseTicketBody } from "../src/tickets";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "kb-abc",
    serial: "KB-ABC123",
    state: "open",
    payoutBase: 5000,
    createdAt: 1_700_000_000_000,
    unit: 200,
    race: { raceKey: "20260621|Hanshin|11|Takarazuka Kinen" },
    ticket: {
      type: "exacta",
      lines: [{ combo: ["1", "2"] }, { combo: ["3", "4"] }],
      cost: 400,
      structure: "box",
    },
    ...overrides,
  };
}

describe("parseTicketBody — validation", () => {
  it("accepts a well-formed body and derives the flat columns", () => {
    const r = parseTicketBody(body());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ticket).toMatchObject({
      ticketType: "exacta",
      lineCount: 2,
      cost: 400,
      unit: 200,
      structure: "box",
      venue: "Hanshin",
      raceNo: 11,
    });
  });

  it("rejects an unknown ticket_type (win/place are NOT committable)", () => {
    expect(parseTicketBody(body({ ticket: { type: "win", lines: [{ combo: ["1"] }] } }))).toMatchObject({
      ok: false,
      code: "bad_ticket_type",
    });
    expect(parseTicketBody(body({ ticket: { type: "roulette", lines: [{ combo: ["1"] }] } }))).toMatchObject({
      ok: false,
      code: "bad_ticket_type",
    });
  });

  it("rejects an empty or oversized lines array", () => {
    expect(parseTicketBody(body({ ticket: { type: "exacta", lines: [] } }))).toMatchObject({
      ok: false,
      code: "bad_lines",
    });
    const tooMany = Array.from({ length: 5001 }, (_, i) => ({ combo: [String((i % 18) + 1)] }));
    expect(parseTicketBody(body({ ticket: { type: "exacta", lines: tooMany } }))).toMatchObject({
      ok: false,
      code: "bad_lines",
    });
  });

  it("rejects a malformed combo (non-numeric / out-of-range umaban)", () => {
    expect(
      parseTicketBody(body({ ticket: { type: "exacta", lines: [{ combo: ["1", "abc"] }] } })),
    ).toMatchObject({ ok: false, code: "bad_line_combo" });
    expect(
      parseTicketBody(body({ ticket: { type: "exacta", lines: [{ combo: ["99"] }] } })),
    ).toMatchObject({ ok: false, code: "bad_line_combo" });
    expect(
      parseTicketBody(body({ ticket: { type: "exacta", lines: [{ combo: ["0"] }] } })),
    ).toMatchObject({ ok: false, code: "bad_line_combo" });
  });

  it("rejects an out-of-sane-range unit", () => {
    expect(parseTicketBody(body({ unit: 0 }))).toMatchObject({ ok: false, code: "bad_unit" });
    expect(parseTicketBody(body({ unit: -100 }))).toMatchObject({ ok: false, code: "bad_unit" });
    expect(parseTicketBody(body({ unit: 10_000_000 }))).toMatchObject({ ok: false, code: "bad_unit" });
  });

  it("rejects an unknown structure", () => {
    expect(
      parseTicketBody(body({ ticket: { type: "exacta", lines: [{ combo: ["1", "2"] }], structure: "parlay" } })),
    ).toMatchObject({ ok: false, code: "bad_structure" });
  });

  it("rejects a payload over the byte cap", () => {
    // ~3KB-per-line junk lines × 400 ⇒ well over 1MB.
    const junk = "x".repeat(3000);
    const lines = Array.from({ length: 400 }, () => ({ combo: ["1", "2"], junk }));
    const r = parseTicketBody(body({ ticket: { type: "exacta", lines } }));
    expect(r).toMatchObject({ ok: false, code: "payload_too_large" });
  });

  it("rejects a missing ticket block", () => {
    const { ticket, ...noTicket } = body();
    expect(parseTicketBody(noTicket)).toMatchObject({ ok: false, code: "bad_ticket" });
  });
});

describe("parseTicketBody — derivation", () => {
  it("derives cost = unit × line_count when ticket.cost is absent", () => {
    // Three distinct trifecta lines (each combo is one line, NOT one horse).
    const r = parseTicketBody(
      body({
        unit: 300,
        ticket: {
          type: "trifecta",
          lines: [{ combo: ["1", "2", "3"] }, { combo: ["1", "2", "4"] }, { combo: ["1", "3", "4"] }],
        },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ticket.cost).toBe(900); // 300 × 3 lines
    expect(r.ticket.lineCount).toBe(3);
    expect(r.ticket.structure).toBeNull();
  });

  it("parses venue/race_no from raceKey and nulls them when malformed", () => {
    const good = parseTicketBody(body());
    if (!good.ok) return;
    expect(good.ticket.venue).toBe("Hanshin");
    expect(good.ticket.raceNo).toBe(11);

    const weird = parseTicketBody(body({ race: { raceKey: "20260628TokyoR5" } }));
    if (!weird.ok) return;
    expect(weird.ticket.venue).toBeNull();
    expect(weird.ticket.raceNo).toBeNull();
  });

  it("upper field checks still reject the legacy garbage shapes", () => {
    expect(parseTicketBody(body({ id: "" }))).toMatchObject({ ok: false, code: "bad_id" });
    expect(parseTicketBody(body({ state: "bogus" }))).toMatchObject({ ok: false, code: "bad_state" });
    expect(parseTicketBody(body({ payoutBase: "x" }))).toMatchObject({ ok: false, code: "bad_payout_base" });
    expect(parseTicketBody(body({ race: { raceKey: "" } }))).toMatchObject({ ok: false, code: "bad_race_key" });
  });
});
