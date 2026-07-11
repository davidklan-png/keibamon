// ============================================================================
// HandleSetup — the single shared @handle onboarding step (Social UX Fixes,
// Phase B).
//
// Replaces the vestigial MyTickets HandlePromptModal (which was rendered but
// never opened). This is the ONE handle-setup UI in the codebase. It is a
// BLOCKING step mounted by the App shell right after first sign-in (and on the
// next sign-in for any existing account that still has no handle) — it cannot
// be skipped.
//
// UX budget is near-zero (mobile-game "name pick" norm): one field, one button.
// The field is prefilled with a suggestion derived from the Clerk display name
// / email prefix (see suggestHandle), so the common path is accept-and-continue
// in a single tap. A debounced availability probe (/api/social/handle-available)
// confirms the handle is free. Format errors are shown ONLY on violation; the
// rules line is always visible as a quiet hint.
//
// Rules (one source of truth in socialClient, mirrored server-side): 3–20
// chars, [a-z0-9_], case-insensitive unique, stored lowercase.
// ============================================================================
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  checkHandleAvailable,
  normalizeHandle,
  postMeTyped,
  validateHandle,
  HANDLE_MAX,
} from "../auth/socialClient";

export interface HandleSetupProps {
  getToken: () => Promise<string | null>;
  /** Suggested handle (already valid) from the display name / email prefix. */
  seed: string | null;
  /** Called with the chosen lowercase handle once the server accepts it. */
  onSuccess: (handle: string) => void;
}

export function HandleSetup({ getToken, seed, onSuccess }: HandleSetupProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(seed ?? "");
  // availability: null = unknown/checking, true = free, false = taken
  const [avail, setAvail] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const violation = validateHandle(draft); // null | "short" | "long" | "charset"
  const normalized = normalizeHandle(draft);

  // Debounced availability check — only when the format is valid. reqId guards
  // against out-of-order responses as the user types.
  useEffect(() => {
    setError(null);
    if (violation) {
      setAvail(null);
      setChecking(false);
      return;
    }
    const myId = ++reqId.current;
    setChecking(true);
    setAvail(null);
    const id = window.setTimeout(async () => {
      const token = await getToken();
      if (reqId.current !== myId) return;
      if (!token) {
        setChecking(false);
        return;
      }
      const r = await checkHandleAvailable(token, normalized);
      if (reqId.current !== myId) return;
      setChecking(false);
      setAvail(r.ok ? r.data.available : null);
    }, 350);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, getToken]);

  async function save() {
    if (violation) return; // CTA is disabled, but defend in depth
    setSaving(true);
    setError(null);
    const token = await getToken();
    const r = await postMeTyped(token, { handle: normalized });
    setSaving(false);
    if (r.ok) {
      onSuccess(r.data.handle ?? normalized);
      return;
    }
    if (r.err.kind === "http" && r.err.status === 409) {
      setAvail(false);
      setError(t("mine.setHandleTaken"));
    } else if (r.err.kind === "http" && r.err.status === 400) {
      setError(t("mine.setHandleErrCharset"));
    } else {
      setError(t("mine.setHandleFailed"));
    }
  }

  const ctaDisabled = saving || violation !== null || avail === false;

  return (
    <main className="app handle-setup">
      <div className="handle-setup-card">
        <img className="avatar" src="/keibamon.png" width={56} height={56} alt="Keibamon" />
        <h1 className="handle-setup-title">{t("mine.setHandleTitle")}</h1>
        <p className="handle-setup-hint">{t("mine.setHandleHint")}</p>

        <div className="handle-setup-field">
          <span className="handle-setup-at" aria-hidden="true">@</span>
          <input
            className="handle-setup-input"
            type="text"
            value={draft}
            maxLength={HANDLE_MAX}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder={t("mine.setHandlePlaceholder")}
            onChange={(e) => setDraft(e.target.value.toLowerCase())}
            autoFocus
          />
        </div>

        {/* Status line: charset error ONLY on violation; otherwise the
            availability result. Save-time errors (taken / failed) surface here. */}
        <div className="handle-setup-status" role="status" aria-live="polite">
          {violation === "charset" && (
            <span className="handle-setup-err">{t("mine.setHandleErrCharset")}</span>
          )}
          {!violation && checking && (
            <span className="handle-setup-checking">{t("mine.setHandleChecking")}</span>
          )}
          {!violation && !checking && avail === true && (
            <span className="handle-setup-ok">{t("mine.setHandleAvailable")}</span>
          )}
          {!violation && !checking && avail === false && (
            <span className="handle-setup-err">{t("mine.setHandleTaken")}</span>
          )}
          {!violation && error && (
            <span className="handle-setup-err">{error}</span>
          )}
        </div>

        <p className="handle-setup-rules">{t("mine.setHandleRules")}</p>

        <button
          className="btn primary handle-setup-cta"
          onClick={() => void save()}
          disabled={ctaDisabled}
        >
          {saving ? "…" : t("mine.setHandleContinue")}
        </button>
      </div>
    </main>
  );
}
