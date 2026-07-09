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

  it("rejects a fractional unit instead of silently flooring it", () => {
    // 200.5 must NOT be floored to 200 (that would let a client understate the
    // derived cost and pass a matching forged ticket.cost).
    expect(parseTicketBody(body({ unit: 200.5 }))).toMatchObject({ ok: false, code: "bad_unit" });
    expect(parseTicketBody(body({ unit: 99.99 }))).toMatchObject({ ok: false, code: "bad_unit" });
    // An integer-valued float is still an integer number of yen → accepted.
    const ok = parseTicketBody(body({ unit: 200.0 }));
    expect(ok.ok).toBe(true);
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

  it("measures the byte cap in UTF-8, not UTF-16 code units", () => {
    // "あ" is ONE UTF-16 code unit but THREE UTF-8 bytes. 350k of them ⇒
    // JS .length ≈ 350k (under the 1M cap) but UTF-8 ≈ 1.05MB (over it). A
    // .length-based check would wrongly admit this payload.
    const multibyte = "あ".repeat(350_000);
    const payload = JSON.stringify(body({ note: multibyte }));
    expect(payload.length).toBeLessThan(1_000_000); // UTF-16 length under the cap
    const r = parseTicketBody(body({ note: multibyte }));
    expect(r).toMatchObject({ ok: false, code: "payload_too_large" });
  });

  it("rejects a forged / mismatched ticket.cost (cost is server-derived)", () => {
    // unit 200 × 1 line = 200; a client claiming 999 must be rejected.
    expect(
      parseTicketBody(body({ ticket: { type: "exacta", lines: [{ combo: ["1", "2"] }], cost: 999 } })),
    ).toMatchObject({ ok: false, code: "bad_cost" });
    // non-integral cost is rejected too.
    expect(
      parseTicketBody(body({ ticket: { type: "exacta", lines: [{ combo: ["1", "2"] }], cost: 200.5 } })),
    ).toMatchObject({ ok: false, code: "bad_cost" });
    // negative cost is rejected.
    expect(
      parseTicketBody(body({ ticket: { type: "exacta", lines: [{ combo: ["1", "2"] }], cost: -1 } })),
    ).toMatchObject({ ok: false, code: "bad_cost" });
    // A supplied cost with NO unit is rejected: the equality can't be checked
    // and cost must be derivable (persisting NULL would not meet "supplied cost
    // must equal server-derived unit × line_count").
    expect(
      parseTicketBody(body({ unit: undefined, ticket: { type: "exacta", lines: [{ combo: ["1", "2"] }], cost: 200 } })),
    ).toMatchObject({ ok: false, code: "bad_cost" });
    // ...and the same when unit is explicitly null.
    expect(
      parseTicketBody(body({ unit: null, ticket: { type: "exacta", lines: [{ combo: ["1", "2"] }], cost: 200 } })),
    ).toMatchObject({ ok: false, code: "bad_cost" });
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
