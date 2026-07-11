// HandleSetup unit tests (Social UX Fixes, Phase B).
//
// SSR (renderToStaticMarkup) covers the render contract: the seed prefills the
// field, the rules + title render, the CTA is gated by validity, and a charset
// error appears ONLY on violation. The debounce/save round-trip is covered by
// the backend availability/validation tests + the pure validateHandle tests in
// socialClient.test.ts — this test pins the rendered UI.
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { HandleSetup } from "./HandleSetup";

describe("HandleSetup", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("prefills the field with a valid seed and enables the CTA", () => {
    const html = renderToStaticMarkup(
      <HandleSetup getToken={() => Promise.resolve("tok")} seed="alyssa" onSuccess={() => {}} />,
    );
    // Brand + title + rules render.
    expect(html).toContain("handle-setup");
    expect(html).toContain("Pick your handle");
    expect(html).toContain("handle-setup-rules");
    // The seed is prefilled (value attribute) and prefixed with @.
    expect(html).toContain('value="alyssa"');
    expect(html).toContain("@");
    // Continue CTA present and NOT disabled (valid seed).
    expect(html).toContain("Continue");
    expect(html).not.toContain("disabled");
    // No charset error shown for a valid handle.
    expect(html).not.toContain("Only a–z");
  });

  it("disables the CTA when there is no seed (empty field = too short)", () => {
    const html = renderToStaticMarkup(
      <HandleSetup getToken={() => Promise.resolve("tok")} seed={null} onSuccess={() => {}} />,
    );
    expect(html).toContain("disabled");
    // The short/empty state does NOT surface a loud charset error (errors only
    // on actual charset violation, per spec).
    expect(html).not.toContain("Only a–z");
  });

  it("shows the charset error ONLY when the draft violates the charset", () => {
    const html = renderToStaticMarkup(
      <HandleSetup getToken={() => Promise.resolve("tok")} seed="aly!" onSuccess={() => {}} />,
    );
    expect(html).toContain("Only a–z");
    expect(html).toContain("disabled"); // invalid → CTA disabled
  });
});
