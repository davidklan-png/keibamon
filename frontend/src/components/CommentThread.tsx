// CommentThread — Friend Interactions Phase 3.
//
// The single comment-thread component, mounted in TWO places: the viewer share
// detail (Friends tab) and the owner's My Tickets DetailView. Single-level, ≤500
// chars, audience-visible only (the server enforces audience membership; this
// component is only rendered for an audience member or the owner).
//
// Delete: an author can delete their own; the share OWNER can delete any
// (`viewerIsOwner`). The server re-checks authority, so the client just calls
// DELETE for any comment it shows a delete affordance on.
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { avatarColor } from "../lib/mytickets-view";
import {
  addComment,
  deleteComment,
  listComments,
  type CommentView,
} from "../auth/socialClient";

export interface CommentThreadProps {
  shareId: string;
  getToken: () => Promise<string | null>;
  /** True on the owner's DetailView — shows a delete affordance on every comment. */
  viewerIsOwner: boolean;
}

export function CommentThread({ shareId, getToken, viewerIsOwner }: CommentThreadProps) {
  const { t } = useI18n();
  const [comments, setComments] = useState<CommentView[] | null>(null);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await listComments(token, shareId);
    setComments(r.ok ? r.data : []);
  }, [shareId, getToken]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function post() {
    const trimmed = draft.trim();
    if (trimmed.length === 0 || trimmed.length > 500 || posting) return;
    setPosting(true);
    setError(null);
    const token = await getToken();
    if (!token) {
      setPosting(false);
      return;
    }
    const r = await addComment(token, shareId, trimmed);
    setPosting(false);
    if (r.ok) {
      setDraft("");
      await refresh();
    } else {
      setError(t("friends.commentFailed"));
    }
  }

  async function remove(id: string) {
    const token = await getToken();
    if (!token) return;
    const r = await deleteComment(token, id);
    if (r.ok) await refresh();
  }

  const canShowDelete = (c: CommentView) => viewerIsOwner || c.mine;

  return (
    <section className="ct-thread" aria-label={t("friends.comments")}>
      <div className="ct-head">{t("friends.comments")}</div>
      {comments !== null && comments.length === 0 && (
        <p className="ct-empty hint">{t("friends.commentEmpty")}</p>
      )}
      <ul className="ct-list">
        {(comments ?? []).map((c) => {
          const label = c.author.handle ? `@${c.author.handle}` : c.author.display_name ?? "";
          return (
            <li key={c.id} className="ct-row">
              <span
                className="ct-avatar"
                style={{ background: avatarColor(c.author.handle ?? c.author.display_name ?? "") }}
              >
                {label.charAt(0).toUpperCase() || "?"}
              </span>
              <div className="ct-body">
                <div className="ct-author">{label}</div>
                <div className={c.deleted ? "ct-text ct-deleted" : "ct-text"}>
                  {c.deleted ? t("friends.commentDeleted") : c.body}
                </div>
              </div>
              {!c.deleted && canShowDelete(c) && (
                <button className="ct-del" onClick={() => void remove(c.id)}>
                  {t("friends.commentDelete")}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="ct-compose">
        <input
          className="ct-input"
          value={draft}
          maxLength={500}
          placeholder={t("friends.commentPlaceholder")}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
        />
        <button
          className="btn primary ct-send"
          disabled={draft.trim().length === 0 || draft.length > 500 || posting}
          onClick={() => void post()}
        >
          {t("friends.commentSend")}
        </button>
      </div>
      {draft.length > 500 && <p className="ct-err hint">{t("friends.commentTooLong")}</p>}
      {error && <p className="ct-err hint">{error}</p>}
    </section>
  );
}
