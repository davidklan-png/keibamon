// ============================================================================
// Session 3a — inline Refine panel + inline TicketWhy tests.
//
// The 4-step builder (race → style → tickets → explain) was collapsed to two
// steps (race → tickets). Style became an inline "Refine ▾" panel on the
// Tickets screen; the per-ticket "Why" reasoning became an inline <details>
// rendered by TicketWhy. The standalone StyleScreen / ExplainScreen steps are
// gone. These tests pin the new inline surfaces (which had no dedicated
// coverage before — the old steps were only exercised live).
//
// Pattern mirrors RaceScreen.test.tsx: renderToStaticMarkup + setLang. Neither
// RefinePanel, TicketWhy, nor the static parts of TicketsScreen use a useEffect
// or a live fetch, so static markup exercises them fully.
// ============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import { RefinePanel } from "./RefinePanel";
import { TicketWhy } from "./TicketWhy";
import { TicketsScreen } from "./TicketsScreen";
import { DEFAULT_STYLE, type StyleState, type Ticket } from "../lib/types";
import type { Runner } from "../lib/fairvalue";
import { setImpression, type ImpressionMap } from "../lib/impressions";
import { MARK_GLYPH } from "./RunnerMark";

const STYLE: StyleState = { ...DEFAULT_STYLE };

const TICKET: Ticket = {
  id: "t1",
  type: "quinella",
  lines: [
    { combo: ["1", "2"], prob: 0.18, fairOdds: 5.5, payout: 540, tag: "blend" },
    { combo: ["1", "3"], prob: 0.1, fairOdds: 9.0, payout: 900, tag: "value" },
  ],
  hitProb: 0.28,
  cost: 200,
  expectedReturn: 130,
  avgPayout: 720,
  bestCaseReturn: 900,
  core: ["1", "2", "3"],
  tag: "blend",
  unit: 100,
  variance: "low",
  rationaleKeys: [],
};

describe("RefinePanel (inline, was the Style step)", () => {
  beforeEach(() => setLang("en"));

  it("renders as a collapsible <details class='refine'> with a summary", () => {
    const html = renderToStaticMarkup(
      <RefinePanel style={STYLE} onChange={() => {}} />,
    );
    expect(html).toMatch(/<details[^>]*class="refine"/);
    expect(html).toContain("<summary>Refine</summary>");
  });

  it("keeps ALL the old Style controls: personality grid, budget/unit, advanced", () => {
    const html = renderToStaticMarkup(
      <RefinePanel style={STYLE} onChange={() => {}} />,
    );
    // Personality grid (5 personalities) — pin a couple of names.
    expect(html).toContain("persona-grid");
    expect(html).toContain("Safe-ish");
    expect(html).toContain("Anti-Chalk");
    // Budget + unit inputs.
    expect(html).toContain("Budget");
    expect(html).toContain("Unit stake");
    // Advanced disclosure with complexity/flavor.
    expect(html).toMatch(/<details[^>]*class="advanced"/);
    expect(html).toContain("Complexity");
    expect(html).toContain("Runner flavor");
  });

  it("marks the active personality with the .on class", () => {
    const html = renderToStaticMarkup(
      <RefinePanel
        style={{ ...STYLE, personality: "longshot" }}
        onChange={() => {}}
      />,
    );
    // The longshot persona button carries `on`; render order is fixed.
    expect(html).toMatch(/persona on[^>]*>\s*<div class="pname">Longshot Hunter/);
  });
});

describe("TicketWhy (inline reasoning, was the Explain step)", () => {
  beforeEach(() => setLang("en"));

  it("renders the lead sentence + the coverage/upside/fragility/cost details", () => {
    const html = renderToStaticMarkup(<TicketWhy ticket={TICKET} style={STYLE} />);
    expect(html).toContain("explain-lead");
    // The details <dl> with all four terms.
    expect(html).toMatch(/<dl[^>]*class="explain"/);
    expect(html).toContain("Coverage");
    expect(html).toContain("Upside");
    expect(html).toContain("Fragility");
    expect(html).toContain("Cost");
    // The combos render.
    expect(html).toContain("combo-chip");
  });

  it("renders the math / house-edge disclosure", () => {
    const html = renderToStaticMarkup(<TicketWhy ticket={TICKET} style={STYLE} />);
    expect(html).toMatch(/<details[^>]*class="math-disclosure"/);
    expect(html).toContain("Math and house edge");
    // The model line names the gamma constant.
    expect(html).toContain("0.856");
  });

  it("does NOT render the per-horse form/context drill (that lives on Race)", () => {
    const html = renderToStaticMarkup(<TicketWhy ticket={TICKET} style={STYLE} />);
    // The old ExplainScreen carried a form-disclosure + FormPanel. The inline
    // reasoning deliberately omits it (no duplicate marks surface).
    expect(html).not.toContain("form-disclosure");
  });
});

describe("TicketsScreen mounts the inline Refine + per-ticket Why", () => {
  beforeEach(() => setLang("en"));

  it("renders the Refine panel and one Why disclosure per ticket", () => {
    const html = renderToStaticMarkup(
      <TicketsScreen
        tickets={[TICKET, { ...TICKET, id: "t2" }]}
        onRemix={() => {}}
        onReset={() => {}}
        style={STYLE}
        onStyleChange={() => {}}
      />,
    );
    // Refine panel present once, at the top.
    expect(html).toMatch(/<details[^>]*class="refine"/);
    // One inline Why disclosure per ticket (2 tickets → 2 disclosures).
    const whyCount = (html.match(/ticket-why-disclosure/g) || []).length;
    expect(whyCount).toBe(2);
    // No "Why this ticket" navigation button remains (it's now the summary).
    expect(html).toContain("Why this ticket");
  });

  it("keeps the Refine panel reachable in the empty state", () => {
    const html = renderToStaticMarkup(
      <TicketsScreen
        tickets={[]}
        onRemix={() => {}}
        onReset={() => {}}
        style={STYLE}
        onStyleChange={() => {}}
      />,
    );
    expect(html).toMatch(/<details[^>]*class="refine"/);
    expect(html).toContain("Reset to standard");
  });
});

describe("refine.summary i18n key exists in both languages", () => {
  it("resolves to a non-empty string in EN and JA", () => {
    expect(typeof en.refine.summary).toBe("string");
    expect(en.refine.summary.length).toBeGreaterThan(0);
    expect(typeof ja.refine.summary).toBe("string");
    expect(ja.refine.summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// ADR-0016: Tickets read-only marks echo. When the race has ≥1 mark, the
// strip renders ABOVE the ticket list (glyph + horse chip per mark). Absent
// without marks, absent in the empty state, absent on the legacy prop shape
// (no runners/raceId/impressions). Read-only — no editing affordance.
// ---------------------------------------------------------------------------
const RUNNERS: Runner[] = [
  { uma: "1", name: "Horse A", odds: 3.2 },
  { uma: "2", name: "Horse B", odds: 5.1 },
  { uma: "3", name: "Horse C", odds: 9.0 },
] as Runner[];

describe("TicketsScreen — ADR-0016 marks echo strip", () => {
  beforeEach(() => setLang("en"));

  it("renders the strip above the ticket list when ≥1 mark exists", () => {
    const impressions: ImpressionMap = {
      ...setImpression({}, "race-1", "Horse A", { mark: "anchor", umaban: 1 }),
      ...setImpression({}, "race-1", "Horse B", { mark: "like", umaban: 2 }),
    };
    const html = renderToStaticMarkup(
      <TicketsScreen
        tickets={[TICKET]}
        onRemix={() => {}}
        onReset={() => {}}
        style={STYLE}
        onStyleChange={() => {}}
        runners={RUNNERS}
        raceId="race-1"
        impressions={impressions}
      />,
    );
    // Header section renders.
    expect(html).toContain(en.tickets.yourMarks);
    expect(html).toContain("tickets-marks-list");
    // One chip per marked runner (2 marks → 2 chips).
    const chips = html.match(/<li[^>]*tickets-mark-chip/g) || [];
    expect(chips.length).toBe(2);
    // Each chip carries the glyph for its mark.
    expect(html).toContain(MARK_GLYPH.anchor);
    expect(html).toContain(MARK_GLYPH.like);
    // Each chip surfaces the uma + name.
    expect(html).toContain(">1<");
    expect(html).toContain("Horse A");
    expect(html).toContain("Horse B");
  });

  it("omits the strip when no marks exist", () => {
    const html = renderToStaticMarkup(
      <TicketsScreen
        tickets={[TICKET]}
        onRemix={() => {}}
        onReset={() => {}}
        style={STYLE}
        onStyleChange={() => {}}
        runners={RUNNERS}
        raceId="race-1"
        impressions={{}}
      />,
    );
    expect(html).not.toContain("tickets-marks-list");
    expect(html).not.toContain(en.tickets.yourMarks);
  });

  it("omits the strip when the legacy prop shape is used (no runners/raceId/impressions)", () => {
    // Backward compat: existing callers that don't pass the ADR-0016 props
    // must render unchanged (no strip section).
    const html = renderToStaticMarkup(
      <TicketsScreen
        tickets={[TICKET]}
        onRemix={() => {}}
        onReset={() => {}}
        style={STYLE}
        onStyleChange={() => {}}
      />,
    );
    expect(html).not.toContain("tickets-marks-list");
  });

  it("omits the strip in the empty-candidates state (no ticket list yet)", () => {
    // The marks echo lives ABOVE the ticket list. With 0 tickets the empty
    // state renders instead — the strip should NOT show there either, even
    // if the caller passed impressions. (It would feel like a stale remnant
    // on the dead-end screen.)
    const impressions: ImpressionMap = setImpression({}, "race-1", "Horse A", {
      mark: "anchor",
      umaban: 1,
    });
    const html = renderToStaticMarkup(
      <TicketsScreen
        tickets={[]}
        onRemix={() => {}}
        onReset={() => {}}
        style={STYLE}
        onStyleChange={() => {}}
        runners={RUNNERS}
        raceId="race-1"
        impressions={impressions}
      />,
    );
    expect(html).not.toContain("tickets-marks-list");
  });

  it("renders no editing affordance (read-only — editing stays on Race)", () => {
    const impressions: ImpressionMap = setImpression({}, "race-1", "Horse A", {
      mark: "anchor",
      umaban: 1,
    });
    const html = renderToStaticMarkup(
      <TicketsScreen
        tickets={[TICKET]}
        onRemix={() => {}}
        onReset={() => {}}
        style={STYLE}
        onStyleChange={() => {}}
        runners={RUNNERS}
        raceId="race-1"
        impressions={impressions}
      />,
    );
    // The strip is a list of <li>, not buttons. No click target anywhere in
    // the marks section.
    expect(html).not.toMatch(/<button[^>]*tickets-mark/);
    // No toast prop was passed → the "Updated with your marks" line is absent
    // (it lives in a separate <p class="marks-toast"> outside this strip).
    expect(html).not.toContain("marks-toast");
  });
});
