import { useState } from "react";
import { useI18n } from "../i18n";
import { useAuth } from "./AuthProvider";
import { postMe } from "./socialClient";

// ADR-0007 Phase 1 — one-time 20+ self-attestation.
//
// On confirm: write `age_verified:1` to the social D1 via /api/social/me, and
// mirror it to Clerk publicMetadata (best-effort) so a reload skips this
// screen. No document KYC — this is self-attestation per ADR-0007 Decision 9.
//
// Decline (leaving the checkbox unchecked and closing the page) just leaves
// the user signed in but not verified; the parent decides whether to allow
// browsing. Phase 1 keeps My Tickets visible behind the gate either way.

export function AgeGate() {
  const { t } = useI18n();
  const { getToken, setAgeVerified } = useAuth();
  const [checked, setChecked] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onContinue() {
    if (!checked || submitting) return;
    setSubmitting(true);
    // Best-effort — the social Worker may be down. setAgeVerified updates the
    // local context state regardless so the user proceeds immediately.
    const token = await getToken();
    await Promise.all([
      postMe(token, { age_verified: 1 }),
      setAgeVerified(true),
    ]);
    setSubmitting(false);
  }

  return (
    <main className="auth-screen">
      <div className="auth-card age-gate" aria-labelledby="age-title">
        <h1 id="age-title">{t("auth.ageTitle")}</h1>
        <label className="age-check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
          />
          <span>{t("auth.ageConfirm")}</span>
        </label>
        <button
          className="auth-primary"
          onClick={onContinue}
          disabled={!checked || submitting}
          type="button"
        >
          {t("auth.ageContinue")}
        </button>
        <p className="auth-legal">{t("auth.ageDeclineNote")}</p>
      </div>
    </main>
  );
}
