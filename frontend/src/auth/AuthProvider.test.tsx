// Crash-guard for <UserButton /> (App.tsx header).
//
// <UserButton /> is a Clerk component that throws when rendered without a
// <ClerkProvider> ancestor. AuthProvider has TWO fallback branches that fake
// a session WITHOUT mounting ClerkProvider:
//   1. NOOP — VITE_CLERK_PUBLISHABLE_KEY unset (PR-preview / no-secret builds).
//   2. PLAYWRIGHT_BYPASS — VITE_PLAYWRIGHT_BYPASS_AUTH=1 (visual-regression
//      builds; IS signed-in with a fake user but no ClerkProvider).
// Both must surface `clerkMounted: false` so App.tsx's
// `{isSignedIn && clerkMounted && <UserButton/>}` gate keeps the component
// unmounted. The Playwright case is the dangerous one (isSignedIn=true), so
// it gets its own assertion that BOTH flags hold at once.
//
// Pattern: vi.stubEnv + vi.resetModules + dynamic import. The branch flags
// `CLERK_ENABLED` / `PLAYWRIGHT_BYPASS` are captured at module load, so each
// test must reload AuthProvider against freshly-stubbed env. Static top-level
// imports would lock in whichever env vitest booted with.

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

beforeEach(() => {
  // Reset module registry so each stubEnv re-drives AuthProvider's
  // module-level CLERK_ENABLED / PLAYWRIGHT_BYPASS constants.
  vi.resetModules();
});

// Render a probe that reads the context via the freshly-imported useAuth.
// The probe MUST use the same module instance as the AuthProvider it's
// wrapped in — they share a React context, so a mismatch would silently
// fall back to the NOOP default and the test would pass for the wrong
// reason. Returning the markup keeps the assertion at the call site.
async function renderProbe(stubs: { clerkKey: string; bypass: string }) {
  vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", stubs.clerkKey);
  vi.stubEnv("VITE_PLAYWRIGHT_BYPASS_AUTH", stubs.bypass);
  const { AuthProvider, useAuth } = await import("./AuthProvider");
  function Probe() {
    const { clerkMounted, isSignedIn } = useAuth();
    return (
      <div
        data-clerk-mounted={String(clerkMounted)}
        data-signed-in={String(isSignedIn)}
      />
    );
  }
  return renderToStaticMarkup(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
}

describe("AuthProvider fallback branches — UserButton crash-guard", () => {
  it("NOOP branch (CLERK disabled): clerkMounted=false, signed out", async () => {
    const html = await renderProbe({ clerkKey: "", bypass: "" });
    expect(html).toContain('data-clerk-mounted="false"');
    expect(html).toContain('data-signed-in="false"');
  });

  it("PLAYWRIGHT bypass: isSignedIn=true AND clerkMounted=false (the guard)", async () => {
    // Key is set here to prove the bypass wins over the Clerk branch —
    // without PLAYWRIGHT_BYPASS this combination would route to ClerkAuthInner.
    const html = await renderProbe({ clerkKey: "pk_test_stub", bypass: "1" });
    // The bypass branch fakes a signed-in session WITHOUT mounting
    // ClerkProvider. <UserButton /> would throw here if App.tsx's gate
    // ever dropped the clerkMounted half — this is the exact combo that
    // gate exists to defend against.
    expect(html).toContain('data-signed-in="true"');
    expect(html).toContain('data-clerk-mounted="false"');
  });
});
