import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ADR-0007 Phase 1 — AuthGate is pure-presentational and Clerk-free. To keep
// the test Clerk-free too, stub SignInScreen with a marker element. AuthGate
// itself imports only React + SignInScreen, so this is sufficient isolation.
vi.mock("./SignInScreen", () => ({
  SignInScreen: () =>
    React.createElement("div", { "data-testid": "sign-in-screen" }),
}));

// Import AFTER vi.mock so the stub resolves. Vitest hoists vi.mock calls
// above imports automatically, but local placement documents intent.
import { AuthGate } from "./AuthGate";

describe("AuthGate", () => {
  it("renders children when isSignedIn=true", () => {
    const out = renderToStaticMarkup(
      <AuthGate isSignedIn={true}>
        <div data-testid="children">child content</div>
      </AuthGate>,
    );
    expect(out).toContain("child content");
    expect(out).not.toContain("sign-in-screen");
  });

  it("renders the sign-in screen when isSignedIn=false", () => {
    const out = renderToStaticMarkup(
      <AuthGate isSignedIn={false}>
        <div data-testid="children">child content</div>
      </AuthGate>,
    );
    expect(out).toContain("sign-in-screen");
    expect(out).not.toContain("child content");
  });
});
