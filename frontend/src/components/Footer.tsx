// ============================================================================
// Footer — extracted from App.tsx (ADR-0007 Phase 5).
// Back-to-top link + the single canonical app-wide disclaimer. The wording
// lives in auth.disclaimer (one source of truth) and is rendered in exactly
// two visible places: here (persistent footer) and the 20+ age gate. The
// clause scan lives in i18n/guardrails.test.ts; the footer-presence
// compliance gate lives in components/Footer.test.tsx.
// Shared by the classic builder (App) and MyTicketsHome.
// ============================================================================
import { useI18n } from "../i18n";

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="foot">
      <a href="/">{t("footer.back")}</a>
      <p className="foot-disclaimer">{t("auth.disclaimer")}</p>
      <p className="foot-version">Keibamon v{__APP_VERSION__} · 競馬モン</p>
    </footer>
  );
}
