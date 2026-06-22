// ============================================================================
// Footer — extracted from App.tsx (ADR-0007 Phase 5).
// Persistent not-betting-advice footer — non-negotiable per app_plan guardrails.
// Shared by the classic builder (App) and MyTicketsHome.
// ============================================================================
import { useI18n } from "../i18n";

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="foot">
      {t("footer.notAdvice")}
      <a href="/">{t("footer.back")}</a>
    </footer>
  );
}
