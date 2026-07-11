// ============================================================================
// ReferenceScreen — top-level Reference destination (ADR-0015).
//
// Glossary-only. The weekend roundup moved OUT of this tab and INTO the Races
// "Research" segment (see RoundupPanel) so the two-lane funnel converges on a
// single destination; Reference is now the bilingual glossary surface.
//
// Framing: research only, never betting advice. The not-advice reminder is
// always visible in the footer.
// ============================================================================
import { useI18n } from "../i18n";
import { GlossaryView } from "./GlossaryView";
import { Footer } from "../components/Footer";
import { NotificationBell } from "../components/NotificationBell";
import type { NotificationView } from "../auth/socialClient";

export interface ReferenceScreenProps {
  onBack: () => void;
  getToken: () => Promise<string | null>;
  onDeepLink: (n: NotificationView) => void;
}

export function ReferenceScreen(props: ReferenceScreenProps) {
  const { onBack, getToken, onDeepLink } = props;
  const { t, lang, setLang } = useI18n();

  return (
    <main className="app">
      <header className="head">
        <img
          className="avatar"
          src="/keibamon.png"
          width={44}
          height={44}
          alt="Keibamon"
        />
        <div>
          <p className="eyebrow">keibamon · 競馬モン</p>
          <h1>
            {t("reference.title")} <span className="ja">リファレンス</span>
          </h1>
        </div>
        <button
          className="lang-toggle"
          onClick={() => setLang(lang === "ja" ? "en" : "ja")}
          aria-label="toggle language"
        >
          {t("app.langToggle")}
        </button>
        <NotificationBell getToken={getToken} onDeepLink={onDeepLink} />
        <button
          className="lang-toggle"
          onClick={onBack}
          aria-label={t("reference.back")}
        >
          {t("reference.back")}
        </button>
      </header>

      <p className="reference-subtitle">{t("reference.subtitle")}</p>

      <GlossaryView />

      <Footer />
    </main>
  );
}
