import { useI18n } from "../i18n";
import { useAuth } from "./AuthProvider";

// ADR-0007 Phase 1 — light-themed sign-in screen.
//
// No Clerk component is rendered directly here. We call openSignIn() (from the
// auth context, which wraps Clerk) on click — Clerk then mounts its own hosted
// modal. That keeps this component pure-presentational: renderToStaticMarkup
// produces the styled shell without spinning up Clerk's iframe runtime, and
// the button onClick is inert under SSR.

export function SignInScreen() {
  const { t } = useI18n();
  const { openSignIn } = useAuth();
  return (
    <main className="auth-screen">
      <div className="auth-card" aria-labelledby="auth-title">
        <div className="auth-mark" aria-hidden="true">
          <span className="ja">ケイバモン</span>
        </div>
        <h1 id="auth-title">{t("auth.signInTitle")}</h1>
        <p className="auth-cta">{t("auth.signInCta")}</p>
        <button className="auth-primary" onClick={openSignIn} type="button">
          {t("auth.signInCta")}
        </button>
        <p className="auth-legal">{t("auth.signInLegal")}</p>
      </div>
    </main>
  );
}
