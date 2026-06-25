// Card-builder parity tests (4a).
//
// For each fixture in src/form/test/fixtures/, this loads `<case>.input.json`,
// runs the TS card builder, and deep-compares against `<case>.golden.json`
// (Python output of build_horse_card / build_jockey_card committed by
// tools/form/generate_parity_fixtures.py). Any drift fails CI.
//
// To regenerate fixtures when form.py changes:
//   PYTHONPATH=src ./venv64/bin/python tools/form/generate_parity_fixtures.py

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { buildHorseCard, buildJockeyCard, type FormStartRow } from "./cardBuilder";

const FIXTURE_DIR = join(__dirname, "test", "fixtures");

interface CaseFiles {
  name: string;
  input: FormStartRow[];
  golden: Record<string, unknown>;
  kind: "horse" | "jockey";
  horseName: string | null;
  jockeyId: string | null;
  asOf: string | null;
}

function loadCases(): CaseFiles[] {
  const files = readdirSync(FIXTURE_DIR);
  const cases = files.filter((f) => f.endsWith(".golden.json"));
  return cases.map((gf) => {
    const name = basename(gf, ".golden.json");
    const inputPath = join(FIXTURE_DIR, `${name}.input.json`);
    const goldenPath = join(FIXTURE_DIR, gf);
    const input = JSON.parse(readFileSync(inputPath, "utf-8")) as FormStartRow[];
    const golden = JSON.parse(readFileSync(goldenPath, "utf-8"));
    const kind: "horse" | "jockey" = name.startsWith("jockey_") ? "jockey" : "horse";
    const horseName = kind === "horse" ? (golden.horse_name as string | null) : null;
    const jockeyId = kind === "jockey" ? (golden.jockey_id as string | null) : null;
    const asOf = (golden.as_of as string | null) ?? null;
    return { name, input, golden, kind, horseName, jockeyId, asOf };
  });
}

describe("card builder parity vs Python goldens", () => {
  for (const c of loadCases()) {
    it(`${c.name}: TS card deep-equals Python golden`, () => {
      const tsCard =
        c.kind === "horse"
          ? buildHorseCard(c.input, c.horseName, c.asOf)
          : buildJockeyCard(c.input, c.jockeyId, c.asOf);
      // Deep equality (key-by-key + value-by-value). JSON.stringify is
      // order-insensitive for object keys but order-sensitive for arrays, so
      // recent_finishes / by_* ordering must also match.
      expect(JSON.parse(JSON.stringify(tsCard))).toEqual(c.golden);
    });
  }
});

describe("card builder no_history fallback", () => {
  it("horse: empty rows + name → no_history", () => {
    const card = buildHorseCard([], "Nobody", "2026-06-28T06:30:00Z");
    expect(card).toEqual({
      status: "no_history",
      horse_name: "Nobody",
      as_of: "2026-06-28T06:30:00Z",
    });
  });

  it("horse: empty rows + null name → no_history with null name", () => {
    const card = buildHorseCard([], null, null);
    expect(card).toEqual({ status: "no_history", horse_name: null, as_of: null });
  });

  it("jockey: empty rows + id → no_history", () => {
    const card = buildJockeyCard([], "j02", "2026-06-28T06:30:00Z");
    expect(card).toEqual({
      status: "no_history",
      jockey_id: "j02",
      as_of: "2026-06-28T06:30:00Z",
    });
  });
});
