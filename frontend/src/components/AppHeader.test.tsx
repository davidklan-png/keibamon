// ============================================================================
// AppHeader unit tests (Social UX Fixes, Phase A).
//
// The Playwright visual suite covers AppHeader's pixels on every screen in the
// auth-bypass mode (isSignedIn:true, clerkMounted:false → "Sign in" slot). These
// tests pin the CONDITIONAL logic that mode can't reach: the bell mounts ONLY
// when signed in, and the account slot switches between "Sign in" and Clerk's
// <UserButton />. Also pins one bell instance + one lang-toggle per render.
// ============================================================================
import { describe, it, expect, beforeEach, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";

// Mutable auth state shared with the mocked useAuth — vi.hoisted so the mock
// factory (which vitest hoists above imports) can close over it.
const { authState } = vi.hoisted(() => ({
  authState: {
    isSignedIn: false,
    clerkMounted: false,
    openSignIn: () => {},
  },
}));

vi.mock("@clerk/clerk-react", () => ({
  // Stand in for the hosted UserButton so no <ClerkProvider> ancestor is needed.
  UserButton: () => React.createElement("span", { "data-testid": "userbtn" }),
}));
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => authState,
}));
// Stand in for NotificationBell so we can count instances without its poller.
vi.mock("./NotificationBell", () => ({
  NotificationBell: () => React.createElement("span", { "data-testid": "bell" }),
}));

// Import AFTER vi.mock so the stubs resolve.
import { AppHeader } from "./AppHeader";

const PROPS = {
  getToken: () => Promise.resolve(null),
  onDeepLink: () => {},
} as const;

describe("AppHeader", () => {
  beforeEach(() => {
    setLang("en");
    authState.isSignedIn = false;
    authState.clerkMounted = false;
  });

  it("renders the brand, a per-view title, and exactly one lang-toggle", () => {
    const html = renderToStaticMarkup(<AppHeader view="friends" {...PROPS} />);
    expect(html).toContain('class="app-header"');
    expect(html).toContain("Friends"); // tabs.friends, resolved by the real i18n (en)
    // Exactly one EN/JP toggle button (the account slot reuses `lang-toggle`
    // only as `account-signin`, so a bare `lang-toggle"` is the toggle itself).
    expect(html.match(/class="lang-toggle"/g)?.length).toBe(1);
  });

  it("does NOT mount the bell when signed out; shows the Sign-in slot", () => {
    const html = renderToStaticMarkup(<AppHeader view="browse" {...PROPS} />);
    expect(html).not.toContain('data-testid="bell"');
    expect(html).toContain("Sign in");
  });

  it("mounts the bell when signed in", () => {
    authState.isSignedIn = true;
    const html = renderToStaticMarkup(<AppHeader view="browse" {...PROPS} />);
    expect(html).toContain('data-testid="bell"');
  });

  it("renders the hosted UserButton (not Sign-in) when signed in + Clerk mounted", () => {
    authState.isSignedIn = true;
    authState.clerkMounted = true;
    const html = renderToStaticMarkup(<AppHeader view="browse" {...PROPS} />);
    expect(html).toContain('data-testid="userbtn"');
    expect(html).not.toContain("Sign in");
  });

  it("still shows Sign-in when signed in but Clerk is NOT mounted (bypass)", () => {
    authState.isSignedIn = true;
    authState.clerkMounted = false;
    const html = renderToStaticMarkup(<AppHeader view="browse" {...PROPS} />);
    expect(html).toContain("Sign in");
    expect(html).not.toContain('data-testid="userbtn"');
  });
});
