import React from "react";
import { SignInScreen } from "./SignInScreen";

// ADR-0007 Phase 1 — pure presentational auth gate.
//
// Deliberately Clerk-free: takes a precomputed `isSignedIn` flag instead of
// reading any Clerk hook, so it can be exercised with `renderToStaticMarkup`
// (the i18n.test.tsx style) without dragging Clerk's runtime into the test.
// The signed-out branch renders <SignInScreen/> which reads useAuth() itself.
//
// The age check is intentionally NOT here — AgeGate is a sibling inside the
// gated children, so the sign-in screen can be re-shown without entangling
// the gate with age state.

export interface AuthGateProps {
  isSignedIn: boolean;
  children: React.ReactNode;
}

export function AuthGate({ isSignedIn, children }: AuthGateProps): React.ReactElement {
  return isSignedIn ? <>{children}</> : <SignInScreen />;
}
