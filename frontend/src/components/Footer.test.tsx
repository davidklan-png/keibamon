// ============================================================================
// Footer compliance lock.
//
// The footer is the persistent home of the single app-wide disclaimer — this
// test pins that the canonical text actually renders. If someone strips the
// render, drops the i18n key, or swaps it for a softer line, this test fails
// before the change can ship.
//
// The clause-content scan (not betting advice / winning method / profit
// guarantee / takeout) lives in i18n/guardrails.test.ts; here we only assert
// that the footer surfaces the same key the age gate uses.
// ============================================================================
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Footer } from "./Footer";
import { setLang } from "../i18n";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";

describe("Footer", () => {
  it("renders the canonical disclaimer (en)", () => {
    setLang("en");
    const html = renderToStaticMarkup(<Footer />);
    // Same key the age gate uses — one source of truth for the wording.
    expect(html).toContain(en.auth.disclaimer);
  });

  it("renders the canonical disclaimer (ja)", () => {
    setLang("ja");
    const html = renderToStaticMarkup(<Footer />);
    expect(html).toContain(ja.auth.disclaimer);
  });

  it("does not surface any banned edge/advice phrases", () => {
    setLang("en");
    const html = renderToStaticMarkup(<Footer />);
    const BANNED = [
      /\bguaranteed\b/i,
      /\bsure thing\b/i,
      /\block\b/i,
      /\bbeat the market\b/i,
    ];
    for (const re of BANNED) expect(html).not.toMatch(re);
  });
});
