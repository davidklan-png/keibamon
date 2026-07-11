// ============================================================================
// ReferenceScreen — top-level Reference destination (ADR-0015).
//
// Glossary-only. The weekend roundup moved OUT of this tab and INTO the Races
// "Research" segment (see RoundupPanel) so the two-lane funnel converges on a
// single destination; Reference is the bilingual glossary surface.
//
// Social UX Fixes (Phase A): the screen no longer renders its own <header>
// (brand, title, bell, lang-toggle, back button). The shared <AppHeader /> in
// the App shell supplies the brand + title + bell + EN/JP toggle on every
// screen; the always-present <BottomTabBar /> (Races tab) replaces the old
// "Back to race builder" button. This component is now just the glossary body.
//
// Framing: research only, never betting advice. The not-advice reminder is
// always visible in the footer.
// ============================================================================
import { useI18n } from "../i18n";
import { GlossaryView } from "./GlossaryView";
import { Footer } from "../components/Footer";

export function ReferenceScreen() {
  const { t } = useI18n();

  return (
    <main className="app">
      <p className="reference-subtitle">{t("reference.subtitle")}</p>

      <GlossaryView />

      <Footer />
    </main>
  );
}
