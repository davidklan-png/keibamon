// ============================================================================
// AppHeader — the single shared app header (Social UX Fixes, Phase A).
//
// BEFORE: every top-level screen owned its own <header className="head"> with
// an ad-hoc cluster of a notification bell + EN/JP toggle, duplicated 4×
// (App browse, FriendsScreen, ReferenceScreen, MyTickets bell-bar + FeedView
// toggle). FriendsScreen had no lang toggle at all; the bell's 60s poller was
// re-created per screen; and the `lang-toggle` class was overloaded for the
// sign-in / back / bell buttons too.
//
// NOW: one AppHeader, mounted ONCE in the App shell (above the per-view body,
// below nothing). Because it never unmounts on a tab switch, there is exactly
// one NotificationBell instance — and therefore one 60s unread-count poller —
// for the whole session. Left = brand + the active screen's title/context;
// right = EN/JP toggle + bell + one account slot, in one fixed order on every
// screen.
//
// The per-view title/eyebrow is the "screen context" the left side shows; the
// right cluster is identical everywhere (the whole point of the consolidation).
// ============================================================================
import { UserButton } from "@clerk/clerk-react";
import { useI18n } from "../i18n";
import { useAuth } from "../auth/AuthProvider";
import { NotificationBell } from "./NotificationBell";
import type { NotificationView } from "../auth/socialClient";

/** The app's top-level views (mirrors App's View union + BottomTabBar's TabView). */
export type AppHeaderView = "browse" | "mine" | "friends" | "reference";

export interface AppHeaderProps {
  view: AppHeaderView;
  /** Clerk JWT getter — forwarded to the single NotificationBell. */
  getToken: () => Promise<string | null>;
  /** Map a tapped notification to a navigation (App owns the routing). */
  onDeepLink: (n: NotificationView) => void;
}

/** Per-view left-side context: the eyebrow tag + the title. */
function useContext(view: AppHeaderView): { eyebrow: string; titleKey: string } {
  switch (view) {
    case "mine":
      return { eyebrow: "keibamon · マイ", titleKey: "tabs.tickets" };
    case "friends":
      return { eyebrow: "keibamon · 友だち", titleKey: "tabs.friends" };
    case "reference":
      return { eyebrow: "keibamon · 用語", titleKey: "tabs.reference" };
    case "browse":
    default:
      // Browse keeps the full bilingual brand title (the landing identity).
      return { eyebrow: "keibamon · 競馬モン", titleKey: "app.title" };
  }
}

export function AppHeader({ view, getToken, onDeepLink }: AppHeaderProps) {
  const { t, lang, setLang } = useI18n();
  const { isSignedIn, clerkMounted, openSignIn } = useAuth();
  const { eyebrow, titleKey } = useContext(view);
  const isBrowse = view === "browse";

  return (
    <header className="app-header">
      <div className="head">
        <img className="avatar" src="/keibamon.png" width={44} height={44} alt="Keibamon" />
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h1>
            {t(titleKey)}
            {/* Browse carries the JA brand glyph; the other screens' titles
                are already localized by their titleKey, so no extra span. */}
            {isBrowse && <span className="ja">競馬モン</span>}
          </h1>
        </div>
        {/* Fixed-order right cluster, identical on every screen:
            bell (signed-in only) → EN/JP toggle → account slot. */}
        <div className="head-actions">
          {isSignedIn && <NotificationBell getToken={getToken} onDeepLink={onDeepLink} />}
          <button
            className="lang-toggle"
            onClick={() => setLang(lang === "ja" ? "en" : "ja")}
            aria-label="toggle language"
          >
            {t("app.langToggle")}
          </button>
          {/* Single account slot. Signed-out → "Sign in" affordance that opens
              Clerk's modal. Signed-in → Clerk's hosted <UserButton />. Gated on
              BOTH isSignedIn and clerkMounted: the Playwright bypass branch
              fakes a session WITHOUT mounting <ClerkProvider>, and <UserButton />
              throws without that ancestor. */}
          {isSignedIn && clerkMounted ? (
            <UserButton
              appearance={{
                elements: {
                  avatarBox: "kbm-userbtn-avatar",
                  userButtonTrigger: "kbm-userbtn",
                },
              }}
              afterSignOutUrl="/"
            />
          ) : (
            <button
              className="lang-toggle account-signin"
              onClick={() => openSignIn()}
              aria-label={t("account.signIn")}
            >
              {t("account.signIn")}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
