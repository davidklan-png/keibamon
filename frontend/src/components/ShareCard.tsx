// ShareCard — Friend Interactions Phase 3.
//
// A friend's shared ticket in the feed: the immutable snapshot (type, lines,
// cost framing, race, mood) + win state (multiplier, NOT currency) + a one-tap
// congratulate that works directly on the card (no detail open) + the comment
// count (tap the card → share detail for the thread). Own shares never appear
// in the feed, so the viewer is never the owner → self-congratulate can't fire.
import { useState } from "react";
import { useI18n } from "../i18n";
import { yen } from "../lib/format";
import { avatarColor } from "../lib/mytickets-view";
import { MT_MOOD_COLOR } from "../lib/mytickets-view";
import { congratulate as apiCongratulate, unCongratulate, type FeedItem } from "../auth/socialClient";

export interface ShareCardProps {
  item: FeedItem;
  getToken: () => Promise<string | null>;
  onOpen: (shareId: string) => void;
}

export function ShareCard({ item, getToken, onOpen }: ShareCardProps) {
  const { t, tFmt, lang } = useI18n();
  const ja = lang === "ja";
  const [count, setCount] = useState(item.congrats_count);
  const [mine, setMine] = useState(item.congratulated_by_me);
  const [busy, setBusy] = useState(false);

  const tk = item.ticket;
  const ownerLabel = item.owner.handle ? `@${item.owner.handle}` : item.owner.display_name ?? "";
  const sep = tk && (tk.ticket.type === "exacta" || tk.ticket.type === "trifecta") ? " > " : " - ";

  async function toggleCongrats() {
    if (busy) return;
    setBusy(true);
    const token = await getToken();
    if (!token) {
      setBusy(false);
      return;
    }
    // Optimistic: flip immediately, reconcile from the API count.
    const r = mine
      ? await unCongratulate(token, item.id)
      : await apiCongratulate(token, item.id);
    if (r.ok) {
      setCount(r.data.count);
      setMine(r.data.congratulatedByMe);
    }
    setBusy(false);
  }

  return (
    <article
      className={`sc-card${item.is_win ? " is-win" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(item.id)}
    >
      <header className="sc-head">
        <span className="sc-avatar" style={{ background: avatarColor(ownerLabel) }}>
          {ownerLabel.charAt(0).toUpperCase() || "?"}
        </span>
        <span className="sc-owner">{ownerLabel}</span>
        {item.is_win && <span className="sc-win-badge">{t("friends.winBadge")}</span>}
      </header>

      {tk && (
        <div className="sc-body">
          <div className="sc-bethead">
            <span className="sc-bettype">{t(`betType.${tk.ticket.type}`)}</span>
            <span className="sc-mood" style={{ background: MT_MOOD_COLOR[tk.mood] }}>
              {t(`mood.${tk.mood}`)}
            </span>
          </div>
          <div className="sc-race">
            {ja ? tk.race.nameJa : tk.race.nameEn}
            {tk.race.grade ? ` · ${tk.race.grade}` : ""}
          </div>
          <div className="sc-chips">
            {tk.ticket.lines.slice(0, 6).map((ln, i) => (
              <span key={i} className="sc-chip">{ln.combo.join(sep)}</span>
            ))}
            {tk.ticket.lines.length > 6 && <span className="sc-chip">+{tk.ticket.lines.length - 6}</span>}
          </div>
          <div className="sc-foot">
            <span className="sc-cost">{t("mine.cost")} {yen(tk.ticket.cost)}</span>
            {item.is_win && item.multiplier != null && (
              <span className="sc-mult">{tFmt("friends.winMultiplier", { n: item.multiplier })}</span>
            )}
          </div>
        </div>
      )}

      <div className="sc-actions" onClick={(e) => e.stopPropagation()}>
        {item.is_win && (
          <button
            className={`sc-congrats ${mine ? "on" : ""}`}
            disabled={busy}
            onClick={() => void toggleCongrats()}
          >
            <span aria-hidden="true">👏</span> {count}
            <span className="sc-congrats-label">
              {mine ? t("friends.congratulated") : t("friends.congratulate")}
            </span>
          </button>
        )}
        <button className="sc-comments" onClick={() => onOpen(item.id)}>
          <span aria-hidden="true">💬</span> {item.comment_count}
        </button>
      </div>
    </article>
  );
}
