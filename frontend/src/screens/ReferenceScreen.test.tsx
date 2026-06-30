// ============================================================================
// ReferenceScreen tests (ADR-0015 — Reference reduced to glossary-only).
//
// What this pins:
//   - The Reference destination renders the bilingual glossary (search input +
//     the glossary title) and the back button.
//   - The old glossary|roundup tab nav is GONE (regression guard: a future
//     change that re-introduces `<nav aria-label="reference tabs">` fails here).
//   - No roundup content (.roundup-tab / .roundup-empty) renders on this surface
//     — the roundup now lives behind the Races → Research lane (RoundupPanel).
//
// Pure-presentational (no useEffect), so renderToStaticMarkup covers it.
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { ReferenceScreen } from "./ReferenceScreen";

describe("ReferenceScreen — glossary-only (ADR-0015)", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("renders the glossary search input + title", () => {
    const html = renderToStaticMarkup(
      <ReferenceScreen onBack={() => {}} />,
    );
    // Glossary search input + title render.
    expect(html).toContain("glossary-search");
    expect(html).toContain("Racing glossary");
  });

  it("does NOT render the old glossary|roundup tab nav", () => {
    const html = renderToStaticMarkup(
      <ReferenceScreen onBack={() => {}} />,
    );
    // The tab nav was <nav className="stepper" aria-label="reference tabs">.
    // Removed by ADR-0015.
    expect(html).not.toMatch(/aria-label="reference tabs"/);
  });

  it("does NOT render roundup content (now lives in RoundupPanel)", () => {
    const html = renderToStaticMarkup(
      <ReferenceScreen onBack={() => {}} />,
    );
    expect(html).not.toContain("roundup-tab");
    expect(html).not.toContain("roundup-empty");
  });
});
