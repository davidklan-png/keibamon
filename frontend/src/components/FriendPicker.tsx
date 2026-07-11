// FriendPicker — Friend Interactions Phase 2.
//
// The share-audience selector. UX rules (locked):
//   - No remembered audience, no preselection in v1 — explicit choice every
//     time (privacy-safe side of the requirements open question).
//   - "All friends" is a TOGGLE the user must turn on, never the default state.
//   - Confirm is disabled until a real choice exists (all_friends on, or ≥1
//     selected) — the picker IS the confirmation step that makes Share a
//     deliberate act, not a muscle-memory single tap.
//   - Zero friends → first-class empty state routing to add-friend paths.
//
// Pure presentational: the owning hook supplies friends + the confirm/cancel
// callbacks (which perform the API call + toast).
import { useState } from "react";
import { useI18n } from "../i18n";
import { avatarColor } from "../lib/mytickets-view";
import type { AudienceMode, FriendSummary } from "../auth/socialClient";

export interface FriendPickerProps {
  friends: FriendSummary[];
  loading: boolean;
  onConfirm: (mode: AudienceMode, selected: string[]) => void;
  onCancel: () => void;
  /** Empty-state CTA. Optional — absent until the Phase 3 add-friend surface. */
  onAddFriend?: () => void;
}

export function FriendPicker({ friends, loading, onConfirm, onCancel, onAddFriend }: FriendPickerProps) {
  const { t, tFmt } = useI18n();
  // Explicit-every-time: start with NO audience. all_friends off, none selected.
  const [allFriends, setAllFriends] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const empty = friends.length === 0;
  const canConfirm = allFriends || selected.size > 0;

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function confirm() {
    if (!canConfirm || loading) return;
    onConfirm(allFriends ? "all_friends" : "selected", [...selected]);
  }

  return (
    <div className="kbm-modal" role="dialog" aria-modal="true">
      <div className="kbm-modal-card">
        <header className="kbm-modal-head">
          <strong>{t("share.pickerTitle")}</strong>
          <button className="btn ghost form-close" onClick={onCancel} aria-label={t("share.cancel")}>
            ×
          </button>
        </header>

        <div className="kbm-modal-body">
          {empty && !loading ? (
            <div className="fp-empty">
              <p className="hint">{t("share.empty")}</p>
              {onAddFriend && (
                <button className="btn primary" onClick={onAddFriend}>
                  {t("share.addFriend")}
                </button>
              )}
            </div>
          ) : (
            <>
              <label className={`fp-all ${allFriends ? "on" : ""}`}>
                <input
                  type="checkbox"
                  checked={allFriends}
                  onChange={(e) => {
                    setAllFriends(e.target.checked);
                    if (e.target.checked) setSelected(new Set());
                  }}
                />
                <span>{t("share.allFriends")}</span>
              </label>

              {!allFriends && (
                <>
                  <p className="hint fp-select-hint">{t("share.selectHint")}</p>
                  <ul className="fp-list">
                    {friends.map((f) => {
                      const on = selected.has(f.id);
                      const label = f.handle ? `@${f.handle}` : f.display_name ?? "";
                      return (
                        <li
                          key={f.id}
                          className={`fp-row ${on ? "on" : ""}`}
                          onClick={() => toggle(f.id)}
                          role="checkbox"
                          aria-checked={on}
                          tabIndex={0}
                        >
                          <span
                            className="fp-avatar"
                            style={{ background: avatarColor(f.handle ?? f.display_name ?? "") }}
                          >
                            {label.charAt(0).toUpperCase() || "?"}
                          </span>
                          <span className="fp-name">{label}</span>
                          <span className="fp-check" aria-hidden="true">{on ? "✓" : ""}</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
            </>
          )}
        </div>

        {!empty && (
          <div className="fp-foot">
            <button className="btn ghost" onClick={onCancel}>
              {t("share.cancel")}
            </button>
            <button className="btn primary" disabled={!canConfirm || loading} onClick={confirm}>
              {allFriends
                ? t("share.allFriends")
                : selected.size > 0
                  ? tFmt("share.selected", { n: selected.size })
                  : t("share.confirm")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
