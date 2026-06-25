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
        <div className="auth-mark-wrap" aria-hidden="true">
          <img className="auth-mascot" src="/keibamon.png" width={56} height={56} alt="" />
          <div className="auth-mark">
            <span className="ja">ケイバモン</span>
          </div>
        </div>
        <h1 id="auth-title">{t("auth.signInTitle")}</h1>
        <p className="auth-cta">{t("auth.signInSubtitle")}</p>
        <button className="auth-primary" onClick={openSignIn} type="button">
          {t("auth.signInCta")}
        </button>
        <p className="auth-legal">{t("auth.signInLegal")}</p>
      </div>
    </main>
  );
}
