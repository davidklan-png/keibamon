// ============================================================================
// RaceContextBar tests (ADR-0017).
//
// The bar is presentational: venue · R# · surface/distance · status chip ·
// optional going + a trailing ellipsised race name. Props only, no fetch, no
// store — renderToStaticMarkup exercises it fully (mirrors BottomTabBar /
// RefinePanel test pattern).
//
// What this pins:
//   - Each identity segment renders when its data is present.
//   - surface/distance each omit cleanly when null (no stray "·").
//   - Status chip carries the right class + localized label per raceStatus.
//   - Manual mode (race=null, raceLabel set) renders the sample-card chip.
//   - No race and no label → component returns null.
//   - Bilingual: surface + status labels resolve in both EN and JA.
// ============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import { RaceContextBar } from "./RaceContextBar";
import type { LiveRace } from "../api";

function makeRace(over: Partial<LiveRace> = {}): LiveRace {
  return {
    race_no: 11,
    name: "Hakodate Kinen",
    venue: "Hakodate",
    surface: "turf",
    distance_m: 2000,
    status: "open",
    ...over,
  } as LiveRace;
}

describe("RaceContextBar — full-fields render", () => {
  beforeEach(() => setLang("en"));

  it("renders venue · R# · surface/distance · chip · name", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace()}
        raceLabel="Hakodate Kinen"
        raceStatus="open"
      />,
    );
    // Wrapper present with status accent class.
    expect(html).toMatch(/class="race-context-bar status-open"/);
    // Identity segments.
    expect(html).toContain("Hakodate");
    expect(html).toContain("R11");
    // Surface + distance formatted as "turf 2000m".
    expect(html).toContain("turf 2000m");
    // Status chip text + class.
    expect(html).toMatch(/rcb-chip status-open/);
    expect(html).toContain(en.race.statusOpen);
    // Race name appears (trailing span).
    expect(html).toContain("Hakodate Kinen");
    // aria-label lands on the wrapper.
    expect(html).toContain('aria-label="Race context"');
    expect(html).toContain('role="status"');
  });

  it("renders the going segment when going is non-empty", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace()}
        raceLabel="Hakodate Kinen"
        raceStatus="open"
        going="good"
      />,
    );
    expect(html).toContain("good");
    expect(html).toMatch(/rcb-going/);
  });

  it("omits the going segment when going is null/empty/whitespace", () => {
    const cases: (string | null | undefined)[] = [null, undefined, "", "   "];
    for (const g of cases) {
      const html = renderToStaticMarkup(
        <RaceContextBar
          race={makeRace()}
          raceLabel="Hakodate Kinen"
          raceStatus="open"
          going={g}
        />,
      );
      expect(html).not.toMatch(/rcb-going/);
    }
  });
});

describe("RaceContextBar — surface/distance omission", () => {
  beforeEach(() => setLang("en"));

  it("omits the surface/distance segment entirely when both are null", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ surface: null, distance_m: null })}
        raceLabel="Hakodate Kinen"
        raceStatus="open"
      />,
    );
    // Neither the word "turf" nor any "2000m" leaks through.
    expect(html).not.toContain("turf");
    expect(html).not.toMatch(/\b2000m\b/);
    // The rest of the identity still renders.
    expect(html).toContain("Hakodate");
    expect(html).toContain("R11");
  });

  it("renders distance-only when surface is null", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ surface: null })}
        raceLabel="Hakodate Kinen"
        raceStatus="open"
      />,
    );
    expect(html).toContain("2000m");
    expect(html).not.toMatch(/turf\s+2000m/);
  });

  it("renders surface-only when distance_m is null", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ distance_m: null })}
        raceLabel="Hakodate Kinen"
        raceStatus="open"
      />,
    );
    expect(html).toContain("turf");
    // No bare "2000m" trailing.
    expect(html).not.toContain("2000m");
  });

  it("localizes surface 'turf' → '芝' under JA, 'dirt' → 'ダート'", () => {
    setLang("ja");
    const turfHtml = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ surface: "turf" })}
        raceLabel="函館記念"
        raceStatus="open"
      />,
    );
    expect(turfHtml).toContain("芝2000m");
    expect(turfHtml).not.toContain("turf");

    const dirtHtml = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ surface: "dirt" })}
        raceLabel="サンプル"
        raceStatus="open"
      />,
    );
    expect(dirtHtml).toContain("ダート");
    expect(dirtHtml).not.toContain("dirt");
  });

  it("passes through unrecognized surface values unchanged", () => {
    // Defensive: a publisher drift to e.g. "fast dirt" should not blank the
    // segment, just render the raw string.
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ surface: "all-weather" as unknown as string })}
        raceLabel="X"
        raceStatus="open"
      />,
    );
    expect(html).toContain("all-weather");
  });
});

describe("RaceContextBar — status chip variants", () => {
  beforeEach(() => setLang("en"));

  it("renders registered chip (class + label) and the registered accent", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ status: "registered" })}
        raceLabel="Hakodate Kinen (pre-market)"
        raceStatus="registered"
      />,
    );
    expect(html).toMatch(/class="race-context-bar status-registered"/);
    expect(html).toMatch(/rcb-chip status-registered/);
    expect(html).toContain(en.race.statusRegistered);
  });

  it("renders result chip (class + label) and the gold accent", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace({ status: "result" })}
        raceLabel="Sample Race"
        raceStatus="result"
      />,
    );
    expect(html).toMatch(/class="race-context-bar status-result"/);
    expect(html).toMatch(/rcb-chip status-result/);
    expect(html).toContain(en.race.statusResult);
  });

  it("renders open chip + open accent", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace()}
        raceLabel="Hakodate Kinen"
        raceStatus="open"
      />,
    );
    expect(html).toMatch(/class="race-context-bar status-open"/);
    expect(html).toContain(en.race.statusOpen);
  });

  it("renders the manual/sample-card chip when raceStatus='manual'", () => {
    // Manual path: App's seedManual() — selectedRace is null, raceLabel is the
    // placeholder. Bar must still render with a recognizable chip so the user
    // knows they're on the sample card.
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={null}
        raceLabel={en.race.placeholderRace}
        raceStatus="manual"
      />,
    );
    expect(html).toMatch(/class="race-context-bar status-manual"/);
    expect(html).toMatch(/rcb-chip status-manual/);
    // Sample-card label surfaced (reuses the existing race.manual key).
    expect(html).toContain(en.race.manual);
    // No venue/R# on the manual path — those segments are absent.
    expect(html).not.toMatch(/rcb-venue/);
    expect(html).not.toMatch(/rcb-raceno/);
    // The placeholder race label still renders in the trailing name slot.
    expect(html).toContain(en.race.placeholderRace);
  });

  it("falls back to the manual chip label for unknown raceStatus values", () => {
    // Defensive: a future status value shouldn't blank the chip — it falls
    // through to the sample-card label so the bar always reads SOMETHING.
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={null}
        raceLabel="X"
        raceStatus="future-unknown-status"
      />,
    );
    expect(html).toContain(en.race.manual);
    expect(html).toMatch(/status-manual/);
  });
});

describe("RaceContextBar — bilingual (EN/JA)", () => {
  it("resolves race.contextBar, race.surfaceTurf, race.surfaceDirt, status keys in EN", () => {
    expect(typeof en.race.contextBar).toBe("string");
    expect(en.race.contextBar.length).toBeGreaterThan(0);
    expect(typeof en.race.surfaceTurf).toBe("string");
    expect(en.race.surfaceDirt.length).toBeGreaterThan(0);
    // The canonical status vocabulary is already pinned elsewhere; this is a
    // parity guard for the two new keys + the existing ones the bar reuses.
    for (const k of ["statusOpen", "statusRegistered", "statusResult", "manual"] as const) {
      expect(typeof en.race[k]).toBe("string");
      expect(en.race[k].length).toBeGreaterThan(0);
    }
  });

  it("resolves the same keys in JA (parity guardrail)", () => {
    expect(typeof ja.race.contextBar).toBe("string");
    expect(ja.race.contextBar.length).toBeGreaterThan(0);
    expect(typeof ja.race.surfaceTurf).toBe("string");
    expect(ja.race.surfaceDirt.length).toBeGreaterThan(0);
    for (const k of ["statusOpen", "statusRegistered", "statusResult", "manual"] as const) {
      expect(typeof ja.race[k]).toBe("string");
      expect(ja.race[k].length).toBeGreaterThan(0);
    }
  });

  it("renders fully under JA — 芝2000m + 発売中 chip + JA aria", () => {
    setLang("ja");
    const html = renderToStaticMarkup(
      <RaceContextBar
        race={makeRace()}
        raceLabel="函館記念"
        raceStatus="open"
      />,
    );
    expect(html).toContain("芝2000m");
    expect(html).toContain(ja.race.statusOpen); // 発売中
    expect(html).toContain(ja.race.contextBar); // レース文脈
    // Race name lands.
    expect(html).toContain("函館記念");
  });
});

describe("RaceContextBar — null safety", () => {
  beforeEach(() => setLang("en"));

  it("returns null when no race and no raceLabel", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar race={null} raceLabel="" raceStatus="manual" />,
    );
    // renderToStaticMarkup of a component returning null emits the empty string.
    expect(html).toBe("");
  });

  it("renders when race is null but raceLabel is set (manual path)", () => {
    const html = renderToStaticMarkup(
      <RaceContextBar race={null} raceLabel="(sample race)" raceStatus="manual" />,
    );
    expect(html).toContain("(sample race)");
    expect(html).toMatch(/race-context-bar/);
  });

  it("renders when race is present but raceLabel is empty (defensive)", () => {
    // App always sets raceLabel alongside selectedRace; still, the bar must
    // not blow up if the label prop is empty — the identity strip carries.
    const html = renderToStaticMarkup(
      <RaceContextBar race={makeRace()} raceLabel="" raceStatus="open" />,
    );
    expect(html).toContain("Hakodate");
    expect(html).toContain("R11");
    expect(html).toMatch(/rcb-chip status-open/);
    // The trailing name span is omitted entirely on empty label.
    expect(html).not.toMatch(/rcb-name/);
  });
});
