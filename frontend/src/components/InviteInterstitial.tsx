// ============================================================================
// InviteInterstitial — the invite deep-link profile card (Social UX Fixes, C).
//
// Rendered full-screen (blocking) by the App shell when useInvite resolves a
// ?friend=<handle> to "no relationship": shows the inviter's profile card +
// ONE primary button. Signed-in → "Add @handle" (one tap → pre-approved
// mutual friendship via /friends/invite/:handle). Signed-out → "Sign in to
// add @handle" (opens Clerk; the stashed invite survives auth + handle setup
// and resolves after). A "Not now" secondary consumes the invite without
// acting (it's not a trap).
// ============================================================================
import { useI18n } from "../i18n";
import { avatarColor } from "../lib/mytickets-view";
import type { PublicProfile } from "../auth/socialClient";

export interface InviteInterstitialProps {
  profile: PublicProfile;
  handle: string;
  mode: "add" | "signin";
  busy: boolean;
  /** mode "add": form the friendship (useInvite.accept). */
  onAdd: () => void;
  /** mode "signin": open Clerk (App.openSignIn). */
  onSignIn: () => void;
  /** "Not now" — consume the invite without acting. */
  onDismiss: () => void;
}

export function InviteInterstitial({ profile, handle, mode, busy, onAdd, onSignIn, onDismiss }: InviteInterstitialProps) {
  const { t } = useI18n();
  const label = profile.display_name || `@${handle}`;
  const initial = label.charAt(0).toUpperCase() || "?";
  const isAdd = mode === "add";

  return (
    <main className="app invite-interstitial">
      <div className="invite-card">
        <p className="invite-eyebrow">{t("invite.eyebrow")}</p>
        <div className="invite-profile">
          <span
            className="invite-avatar"
            style={{ background: avatarColor(label) }}
            aria-hidden="true"
          >
            {initial}
          </span>
          <div className="invite-profile-text">
            <div className="invite-handle">@{handle}</div>
            {profile.display_name && (
              <div className="invite-display-name">{profile.display_name}</div>
            )}
          </div>
        </div>
        <button
          className="btn primary invite-cta"
          onClick={isAdd ? onAdd : onSignIn}
          disabled={busy}
        >
          {busy ? "…" : isAdd ? tFmtAdd(t, handle) : tFmtSignIn(t, handle)}
        </button>
        <button className="invite-dismiss" onClick={onDismiss}>
          {t("invite.notNow")}
        </button>
      </div>
    </main>
  );
}

// Local helpers so the CTA copy interpolates the handle without dragging a
// global tFmt variant. Kept tiny + colocated.
function tFmtAdd(t: (k: string) => string, handle: string): string {
  return t("invite.addCta").replace("{handle}", handle);
}
function tFmtSignIn(t: (k: string) => string, handle: string): string {
  return t("invite.signInCta").replace("{handle}", handle);
}
