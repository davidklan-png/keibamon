// asOf parser parity tests — pin the Python _parse_as_of behavior.
import { describe, it, expect } from "vitest";
import { parseAsOf, formatUtcIso } from "./asOf";

describe("parseAsOf", () => {
  it("empty / null / undefined → now UTC (within a few seconds)", () => {
    const t0 = Date.now();
    const a = parseAsOf("").getTime();
    const b = parseAsOf(null).getTime();
    const c = parseAsOf(undefined).getTime();
    const t1 = Date.now();
    expect(a).toBeGreaterThanOrEqual(t0);
    expect(a).toBeLessThanOrEqual(t1);
    expect(b).toBeGreaterThanOrEqual(t0);
    expect(c).toBeGreaterThanOrEqual(t0);
  });

  it("ISO with Z → same instant UTC", () => {
    const d = parseAsOf("2026-06-28T15:40:00Z");
    expect(d.toISOString()).toBe("2026-06-28T15:40:00.000Z");
  });

  it("ISO naive → assumed JST (subtract +09:00)", () => {
    // Python: naive datetime → replace tzinfo=JST → astimezone(UTC).
    // 2026-06-28T15:40:00 (naive, taken as JST) → 06:40:00 UTC.
    const d = parseAsOf("2026-06-28T15:40:00");
    expect(d.toISOString()).toBe("2026-06-28T06:40:00.000Z");
  });

  it("ISO with +09:00 → correct UTC", () => {
    const d = parseAsOf("2026-06-28T15:40:00+09:00");
    expect(d.toISOString()).toBe("2026-06-28T06:40:00.000Z");
  });

  it("ISO with +00:00 → same instant", () => {
    const d = parseAsOf("2026-06-28T15:40:00+00:00");
    expect(d.toISOString()).toBe("2026-06-28T15:40:00.000Z");
  });

  it("date-only YYYY-MM-DD → JST midnight UTC", () => {
    // Python: naive → JST → 2026-06-27T15:00:00Z.
    const d = parseAsOf("2026-06-28");
    expect(d.toISOString()).toBe("2026-06-27T15:00:00.000Z");
  });

  it("compact YYYYMMDD → JST midnight UTC", () => {
    const d = parseAsOf("20260628");
    expect(d.toISOString()).toBe("2026-06-27T15:00:00.000Z");
  });

  it("unparseable → now UTC (no throw)", () => {
    const t0 = Date.now();
    const d = parseAsOf("not-a-date").getTime();
    expect(d).toBeGreaterThanOrEqual(t0);
  });

  it("partial compact (only 6 digits) → now UTC", () => {
    const t0 = Date.now();
    const d = parseAsOf("202606").getTime();
    expect(d).toBeGreaterThanOrEqual(t0);
  });

  it("ISO with seconds + fractional → preserved (truncated to ms)", () => {
    const d = parseAsOf("2026-06-28T15:40:00.123456Z");
    expect(d.toISOString()).toBe("2026-06-28T15:40:00.123Z");
  });

  it("whitespace is trimmed", () => {
    const d = parseAsOf("  2026-06-28T15:40:00Z  ");
    expect(d.toISOString()).toBe("2026-06-28T15:40:00.000Z");
  });
});

describe("formatUtcIso", () => {
  it("renders canonical YYYY-MM-DDTHH:MM:SSZ", () => {
    expect(formatUtcIso(new Date("2026-06-28T15:40:00.000Z"))).toBe(
      "2026-06-28T15:40:00Z",
    );
  });

  it("round-trips: parse → format", () => {
    const raw = "2026-06-28T15:40:00Z";
    expect(formatUtcIso(parseAsOf(raw))).toBe(raw);
  });

  it("naive-JST parse formats to the UTC equivalent", () => {
    // 2026-06-28T15:40 (JST) → 06:40 UTC.
    expect(formatUtcIso(parseAsOf("2026-06-28T15:40:00"))).toBe(
      "2026-06-28T06:40:00Z",
    );
  });
});
