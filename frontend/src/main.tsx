import React from "react";
import { createRoot } from "react-dom/client";
import { ClerkProvider } from "@clerk/clerk-react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import "./styles.css";

// ADR-0007 Phase 1 — Clerk publishable key. Build must NOT crash if it is
// unset (so PR review builds without secrets work). In dev we warn; in prod
// the auth gate simply renders the sign-in screen with no provider, which is
// visible breakage but not a hard fault.
const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
if (!CLERK_KEY && import.meta.env.DEV) {
  // eslint-disable-next-line no-console
  console.warn(
    "[keibamon] VITE_CLERK_PUBLISHABLE_KEY is unset — auth gate will render without a Clerk session. Set it in frontend/.env (see frontend/.env.example).",
  );
}

const tree = CLERK_KEY ? (
  <React.StrictMode>
    <ClerkProvider publishableKey={CLERK_KEY}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ClerkProvider>
  </React.StrictMode>
) : (
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>
);

createRoot(document.getElementById("root") as HTMLElement).render(tree);
