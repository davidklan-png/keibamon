// ADR-0007 Phase 4 — visual regression via HTML-string snapshots.
//
// What this catches: DOM structure + i18n string regressions on the auth
// surface (the new Phase 1 screens). Any unintended change to the rendered
// HTML — missing button, swapped string, broken className — fails the test.
//
// What this does NOT catch (acknowledged gap, see docs/runbooks/phase4-hardening.md):
//   - CSS / pixel layout drift. Snapshots are markup-only; styles aren't exercised.
//   - The 8 screens the original plan enumerated (race / style / tickets / explain
//     + 4 My-Tickets screens). App.tsx renders those as inline functions inside a
//     2.7k-line component with ~10 useEffect hooks + fetch-on-mount — pulling
//     them out for snapshot tests would be a refactor outside Phase 4 scope.
//     Phase 5 backlog: CSS-pixel regression via Playwright covers both gaps.
//
// Pattern: same `renderToStaticMarkup` + vitest `toMatchFileSnapshot` used by
// src/i18n/i18n.test.tsx and src/auth/AuthGate.test.tsx. No jsdom needed — the
// auth screens are pure-presentational and use only React + useI18n + useAuth.
//
// When an intentional change lands (e.g. new copy, redesigned auth card), run
//   npm test -- src/app.snapshot.test.tsx -- -u
// and commit the new baselines alongside the change.

import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang, getLang, type Lang } from "./i18n";

// AuthProvider imports @clerk/clerk-react at the top. In dev/prod with the env
// set, CLERK_ENABLED short-circuits past those hooks. But vitest inherits the
// repo .env's VITE_CLERK_PUBLISHABLE_KEY, so CLERK_ENABLED is true here and
// ClerkAuthInner calls useUser() — which throws "useUser can only be used
// within <ClerkProvider />" under renderToStaticMarkup.
//
// Mock the hooks to the signed-out shape they return without a ClerkProvider
// ancestor. AuthProvider then sees user=undefined → isSignedIn=false → NOOP-like
// context value → SignInScreen renders, which is exactly the snapshot we want
// (the unauthenticated shell).
vi.mock("@clerk/clerk-react", () => ({
  useUser: () => ({ user: undefined }),
  useAuth: () => ({ getToken: async () => null }),
  useClerk: () => ({ openSignIn: () => {} }),
}));

// Import AFTER vi.mock so the stub resolves. Vitest hoists vi.mock above
// imports automatically, but local placement documents intent.
import { AuthProvider } from "./auth/AuthProvider";
import { SignInScreen } from "./auth/SignInScreen";
import { AgeGate } from "./auth/AgeGate";

function withProvider(el: React.ReactElement): React.ReactElement {
  return <AuthProvider>{el}</AuthProvider>;
}

describe("app HTML snapshots", () => {
  beforeEach(() => {
    // Reset to a deterministic language between tests so the baselines don't
    // depend on test ordering.
    setLang("ja");
  });

  it("renders ja as the initial language", () => {
    // Sanity guard: if this fails, the snapshots below are against the wrong lang.
    expect(getLang()).toBe("ja" as Lang);
  });

  describe("SignInScreen", () => {
    it("matches the JA baseline", async () => {
      setLang("ja");
      const html = renderToStaticMarkup(withProvider(<SignInScreen />));
      await expect(html).toMatchFileSnapshot("__snapshots__/SignInScreen.ja.html");
    });

    it("matches the EN baseline", async () => {
      setLang("en");
      const html = renderToStaticMarkup(withProvider(<SignInScreen />));
      await expect(html).toMatchFileSnapshot("__snapshots__/SignInScreen.en.html");
    });

    // Race-first UX polish — pin the three intentional changes so a regression
    // (mascot dropped, subtitle re-merged with the button, a banned word) fails
    // here regardless of the snapshot file.
    it("renders the mascot image and a subtitle distinct from the button", () => {
      setLang("en");
      const html = renderToStaticMarkup(withProvider(<SignInScreen />));
      // Mascot image carries the brand.
      expect(html).toContain('src="/keibamon.png"');
      // Subtitle is a value line, NOT the CTA button label.
      expect(html).toContain("Recreational ticket ideas");
      // The button still carries the CTA copy.
      expect(html).toContain("Continue with email or social");
    });

    it("contains no banned honesty words", () => {
      setLang("en");
      const html = renderToStaticMarkup(withProvider(<SignInScreen />));
      const banned = [/\bguaranteed\b/i, /\bsure thing\b/i, /\block\b/i, /\bbeat the market\b/i];
      for (const re of banned) expect(html).not.toMatch(re);
    });
  });

  describe("AgeGate", () => {
    it("matches the JA baseline", async () => {
      setLang("ja");
      const html = renderToStaticMarkup(withProvider(<AgeGate />));
      await expect(html).toMatchFileSnapshot("__snapshots__/AgeGate.ja.html");
    });

    it("matches the EN baseline", async () => {
      setLang("en");
      const html = renderToStaticMarkup(withProvider(<AgeGate />));
      await expect(html).toMatchFileSnapshot("__snapshots__/AgeGate.en.html");
    });
  });
});
