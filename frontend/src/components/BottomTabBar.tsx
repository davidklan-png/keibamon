// ============================================================================
// BottomTabBar — persistent thumb-zone navigation (Session 1 UX refactor).
//
// Three top-level destinations mapped onto App's `view` enum:
//   - browse    → Races   (the live-card builder)
//   - mine      → Tickets  (My Tickets home)
//   - reference → Reference (glossary + weekend roundup)
//
// Rendered on all three destination screens (browse, mine, reference) so the
// bar is always present. Pure/presentational: it takes the current `view` and
// an `onNavigate` callback — App owns the actual view transition (and any
// auth/age gating that destination needs). The active tab reflects `view`.
//
// Fixed-bottom + safe-area-inset aware (see .bottom-tabbar in styles.css);
// `.app` carries matching bottom padding so content isn't hidden behind it.
// ============================================================================
import { useI18n } from "../i18n";

export type TabView = "browse" | "mine" | "friends" | "reference";

const TABS: { id: TabView; labelKey: string }[] = [
  { id: "browse", labelKey: "tabs.races" },
  { id: "mine", labelKey: "tabs.tickets" },
  { id: "friends", labelKey: "tabs.friends" },
  { id: "reference", labelKey: "tabs.reference" },
];

export function BottomTabBar({
  view,
  onNavigate,
  friendsBadge = 0,
}: {
  view: TabView;
  onNavigate: (v: TabView) => void;
  /** Pending friend-request count for the Friends tab badge (0 = no badge). */
  friendsBadge?: number;
}) {
  const { t } = useI18n();
  return (
    <nav className="bottom-tabbar" aria-label="primary">
      {TABS.map((tab) => {
        const active = view === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            data-testid={`tab-${tab.id}`}
            className={active ? "on" : ""}
            aria-current={active ? "page" : undefined}
            onClick={() => onNavigate(tab.id)}
          >
            {t(tab.labelKey)}
            {tab.id === "friends" && friendsBadge > 0 && (
              <span className="tab-badge">{friendsBadge}</span>
            )}
          </button>
        );
      })}
    </nav>
  );
}
