// ShareCard — Friend Interactions Phase 3 (+ Item 4 own-share-in-feed).
//
// A friend's shared ticket in the feed: the immutable snapshot (type, lines,
// cost framing, race, mood) + win state (multiplier, NOT currency) + a one-tap
// congratulate that works directly on the card (no detail open) + the comment
// count (tap the card → share detail for the thread).
//
// Item 4: the viewer's OWN shares now appear in the feed too. An own card is
// badged "You" (not the @handle), its congratulate COUNT stays visible but is
// read-only (the server forbids self-congrats — cannot_congratulate_own — so
// the count can't change from here), and tapping it routes to the owner
// engagement surface (My Tickets detail) via onOpenOwn rather than the share
// detail viewer. A friend's card behaves exactly as before.
import { useState } from "react";
import { useI18n } from "../i18n";
import { yen } from "../lib/format";
import { avatarColor } from "../lib/mytickets-view";
import { MT_MOOD_COLOR } from "../lib/mytickets-view";
import { congratulate as apiCongratulate, unCongratulate, type FeedItem } from "../auth/socialClient";
import { TicketLines } from "./TicketLines";

export interface ShareCardProps {
  item: FeedItem;
  getToken: () => Promise<string | null>;
  /** Open the share-detail viewer (friend's share). */
  onOpen: (shareId: string) => void;
  /** Item 4 — open the viewer's OWN ticket detail (owner engagement surface). */
  onOpenOwn: (ticketId: string) => void;
  /** Item 4 — true when this share is the viewer's own. */
  viewerIsOwner: boolean;
}

export function ShareCard({ item, getToken, onOpen, onOpenOwn, viewerIsOwner }: ShareCardProps) {
  const { t, tFmt, lang } = useI18n();
  const ja = lang === "ja";
  const [count, setCount] = useState(item.congrats_count);
  const [mine, setMine] = useState(item.congratulated_by_me);
  const [busy, setBusy] = useState(false);

  const tk = item.ticket;
  const ownerLabel = item.owner.handle ? `@${item.owner.handle}` : item.owner.display_name ?? "";

  // Item 4 — own cards route to the owner engagement surface (My Tickets
  // detail), not the share-detail viewer.
  function open() {
    if (viewerIsOwner && item.ticket_id) onOpenOwn(item.ticket_id);
    else onOpen(item.id);
  }

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
      onClick={open}
    >
      <header className="sc-head">
        <span className="sc-avatar" style={{ background: avatarColor(ownerLabel) }}>
          {ownerLabel.charAt(0).toUpperCase() || "?"}
        </span>
        {viewerIsOwner ? (
          // Item 4 — own share: "You" pill in place of the @handle.
          <span className="sc-owner sc-you">{t("friends.you")}</span>
        ) : (
          <span className="sc-owner">{ownerLabel}</span>
        )}
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
            {raceMeta(tk.race, ja) && <span className="sc-race-meta">{raceMeta(tk.race, ja)}</span>}
          </div>
          {/* Ticket-detail UX — structure-aware body (compact): Box/Formation/
              Wheel tiles, or capped chips + "+N" for legacy. Old share
              snapshots without `structure` take the legacy path untouched. */}
          <TicketLines ticket={tk.ticket} unitStake={tk.unit} compact />
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
          viewerIsOwner ? (
            // Item 4 — read-only congrats count on own items (server forbids
            // self-congrats; the count is informational, not a control).
            <span className="sc-congrats-readonly" aria-label={t("friends.congratulate")}>
              <span aria-hidden="true">👏</span> {count}
            </span>
          ) : (
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
          )
        )}
        <button className="sc-comments" onClick={open}>
          <span aria-hidden="true">💬</span> {item.comment_count}
        </button>
      </div>
    </article>
  );
}

/**
 * Item 5 — the race identity line (venue · R# · date) shown alongside the race
 * name, matching the My Tickets detail header. Returns "" when no identity
 * fields are present so old share snapshots without them render gracefully
 * (just the name + grade, as before). Each field is guarded individually.
 */
export function raceMeta(
  race: { venueEn?: string; venueJa?: string; raceNo?: number; dateEn?: string; dateJa?: string },
  ja: boolean,
): string {
  const parts: string[] = [];
  const venue = ja ? (race.venueJa || race.venueEn) : race.venueEn;
  if (venue) parts.push(venue);
  if (race.raceNo) parts.push(`R${race.raceNo}`);
  const date = ja ? (race.dateJa || race.dateEn) : race.dateEn;
  if (date) parts.push(date);
  return parts.join(" · ");
}
