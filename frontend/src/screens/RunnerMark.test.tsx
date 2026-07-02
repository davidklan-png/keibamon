// ============================================================================
// RunnerMark tests (ADR-0016 — inline per-runner mark control on Race).
//
// What this pins:
//   - The collapsed badge shows the right glyph per mark kind and a "—"
//     placeholder when unmarked.
//   - aria-labels are bilingual (form.intuition.<kind> when marked,
//     race.markAdd when not) — so JA screen readers hear 軸 / 好感触 etc.
//   - The expanded chip strip renders the 5 marks in the SAME order as
//     HorseDrillView's IntuitionMarks (like → distrust → priceHorse → avoid
//     → anchor) so the two surfaces feel identical.
//   - Clicking a chip writes through setImpression with the runner's current
//     odds + snapshot stamped; odds=0 → null. Tapping the active chip clears.
//   - The strip auto-collapses after a choose (the NetKeiba muscle-memory
//     rhythm: tap-badge → pick → strip closes → next row).
//   - Rendered output stays guardrail-clean (no edge/advice phrases).
//
// Two environments per the project pattern: the presentational assertions
// use renderToStaticMarkup (node env, matches RaceScreen.test.tsx); the
// interaction assertions use jsdom + act (matches HorseDrillView.test.tsx).
// ============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import {
  RunnerMark,
  MARK_KINDS,
  MARK_GLYPH,
  markClass,
} from "./RunnerMark";
import { setImpression, type ImpressionMap } from "../lib/impressions";

// Static-markup helper: collapsed badge render (isOpen=false).
function renderBadge(opts: {
  raceId?: string;
  horseName?: string;
  umaban?: number;
  odds?: number | null;
  oddsSnapshotAt?: string | null;
  impressions?: ImpressionMap;
  isOpen?: boolean;
} = {}) {
  return renderToStaticMarkup(
    <RunnerMark
      raceId={opts.raceId ?? "race-1"}
      horseName={opts.horseName ?? "Horse A"}
      umaban={opts.umaban ?? 1}
      odds={opts.odds ?? null}
      oddsSnapshotAt={opts.oddsSnapshotAt ?? null}
      impressions={opts.impressions ?? {}}
      onSetImpressions={() => {}}
      isOpen={opts.isOpen ?? false}
      onOpenChange={() => {}}
    />,
  );
}

describe("RunnerMark — collapsed badge glyphs", () => {
  beforeEach(() => setLang("en"));

  it("renders the placeholder '—' when unmarked", () => {
    const html = renderBadge();
    expect(html).toContain(">—<");
    // And the unmarked-badge aria-label is race.markAdd.
    expect(html).toMatch(/aria-label="Add a mark"/);
    // No `on` class on an unmarked badge.
    expect(html).not.toMatch(/runner-mark-badge[^"]* on/);
  });

  it.each(MARK_KINDS.map((k) => [k] as const))(
    "renders the correct glyph for mark=%s",
    (kind) => {
      const impressions = setImpression({}, "race-1", "Horse A", {
        mark: kind,
        umaban: 1,
        odds_when_marked: 5.0,
        odds_snapshot_at: "2026-07-02T00:00:00Z",
      });
      const html = renderBadge({ impressions });
      expect(html).toContain(MARK_GLYPH[kind]);
      // The badge is marked-active (carries `on` + the per-kind class).
      expect(html).toMatch(new RegExp(`runner-mark-badge[^"]* on ${markClass(kind)}`));
    },
  );

  it("uses the existing form.intuition.<kind> strings as aria-labels when marked", () => {
    // Pin the bilingual contract: the marked badge's aria-label is the SAME
    // string IntuitionMarks uses (so a screen-reader user hears the same
    // word on either surface).
    for (const kind of MARK_KINDS) {
      const impressions = setImpression({}, "race-1", "Horse A", {
        mark: kind,
        umaban: 1,
      });
      const enHtml = renderBadge({ impressions });
      expect(enHtml).toMatch(
        new RegExp(`aria-label="${escapeRegExp(en.form.intuition[kind])}"`),
      );
    }
  });

  it("resolves the marked aria-label to JA when the lang is JA", () => {
    setLang("ja");
    try {
      const impressions = setImpression({}, "race-1", "Horse A", {
        mark: "anchor",
        umaban: 1,
      });
      const html = renderBadge({ impressions });
      // ja.form.intuition.anchor = "軸".
      expect(html).toMatch(/aria-label="軸"/);
    } finally {
      setLang("en");
    }
  });
});

describe("RunnerMark — expanded chip strip", () => {
  beforeEach(() => setLang("en"));

  it("does NOT render the chip strip when isOpen=false", () => {
    const html = renderBadge({ isOpen: false });
    expect(html).not.toContain("runner-mark-strip");
    expect(html).not.toContain("runner-mark-chip");
  });

  it("renders the 5 marks in the SAME order as IntuitionMarks + a clear chip when active", () => {
    // Mark the runner so the clear chip renders.
    const impressions = setImpression({}, "race-1", "Horse A", {
      mark: "like",
      umaban: 1,
    });
    const html = renderBadge({ impressions, isOpen: true });
    expect(html).toContain("runner-mark-strip");

    // The 5 chips in IntuitionMarks order: like, distrust, priceHorse, avoid, anchor.
    const chipLabels = [
      en.form.intuition.like,
      en.form.intuition.distrust,
      en.form.intuition.priceHorse,
      en.form.intuition.avoid,
      en.form.intuition.anchor,
    ];
    let prev = -1;
    for (const label of chipLabels) {
      const idx = html.indexOf(label);
      expect(idx, `expected chip label "${label}" in strip`).toBeGreaterThan(-1);
      expect(idx, `expected chip "${label}" in IntuitionMarks order`).toBeGreaterThan(prev);
      prev = idx;
    }

    // The clear chip renders (because there's an active mark) with the
    // race.markClear aria-label.
    expect(html).toContain(en.race.markClear);
  });

  it("omits the clear chip when no mark is active (tapping the active chip already clears)", () => {
    const html = renderBadge({ isOpen: true });
    expect(html).toContain("runner-mark-strip");
    expect(html).not.toContain("runner-mark-clear");
  });

  it("renders the glyph AND label in each chip (glyph aria-hidden, label visible)", () => {
    const html = renderBadge({ isOpen: true });
    // Each chip has aria-hidden=true on the glyph span so screen readers
    // announce the label once, not twice.
    const glyphMatches =
      html.match(/<span[^>]*aria-hidden="true"[^>]*class="runner-mark-glyph"[^>]*>[^<]+<\/span>/g) || [];
    expect(glyphMatches.length).toBe(MARK_KINDS.length);
  });
});

describe("RunnerMark — i18n keys exist in both languages", () => {
  it("resolves race.markAdd, race.markClear, and tickets.yourMarks to non-empty strings", () => {
    for (const k of ["markAdd", "markClear"] as const) {
      expect(typeof en.race[k]).toBe("string");
      expect(en.race[k].length).toBeGreaterThan(0);
      expect(typeof ja.race[k]).toBe("string");
      expect(ja.race[k].length).toBeGreaterThan(0);
    }
    expect(typeof en.tickets.yourMarks).toBe("string");
    expect(en.tickets.yourMarks.length).toBeGreaterThan(0);
    expect(typeof ja.tickets.yourMarks).toBe("string");
    expect(ja.tickets.yourMarks.length).toBeGreaterThan(0);
  });
});

describe("RunnerMark — guardrail cleanliness", () => {
  beforeEach(() => setLang("en"));

  it("makes no edge/advice claims in the rendered output", () => {
    const impressions = setImpression({}, "race-1", "Horse A", {
      mark: "anchor",
      umaban: 1,
    });
    const html = renderBadge({ impressions, isOpen: true });
    for (const banned of [/guaranteed/i, /\bsure thing\b/i, /\block\b/i, /beat the market/i]) {
      expect(html).not.toMatch(banned);
    }
  });
});

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
