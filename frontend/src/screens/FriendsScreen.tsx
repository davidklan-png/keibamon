// FriendsScreen — Friend Interactions Phase 3 (the new top-level Friends tab).
//
// Three panes + a detail: Feed (default — friends' shared tickets/wins), Friends
// (list + badged pending requests), Add friend (handle search + invite link),
// and Share detail (tap a feed card → full snapshot + win + congratulate +
// CommentThread). Empty states are first-class. This tab + the two re-pointed
// surfaces are the ONLY social entry points — social stays out of the solo flow.
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../i18n";
import { avatarColor } from "../lib/mytickets-view";
import { yen } from "../lib/format";
import { ShareCard } from "../components/ShareCard";
import { CommentThread } from "../components/CommentThread";
import { TicketLines } from "../components/TicketLines";
import {
  acceptFriendRequest,
  declineFriendRequest,
  getFeed,
  getShare,
  listFriends,
  postMe,
  removeFriend,
  requestFriend,
  searchUsers,
  type FeedItem,
  type FriendSummary,
} from "../auth/socialClient";

type Sub = "feed" | "list" | "add" | "detail";

export interface FriendsScreenProps {
  getToken: () => Promise<string | null>;
  onPendingChange: (n: number) => void;
}

export function FriendsScreen({ getToken, onPendingChange }: FriendsScreenProps) {
  const { t, tFmt, lang } = useI18n();
  const ja = lang === "ja";
  const [sub, setSub] = useState<Sub>("feed");
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [fr, setFr] = useState<{
    friends: FriendSummary[];
    pending_incoming: FriendSummary[];
    pending_outgoing: FriendSummary[];
    pending_count: number;
  } | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedItem | null>(null);
  const [myHandle, setMyHandle] = useState<string | null>(null);

  const refreshFeed = useCallback(async () => {
    const token = await getToken();
    if (!token) return setFeed([]);
    const r = await getFeed(token);
    setFeed(r.ok ? r.data.items : []);
  }, [getToken]);

  const refreshFriends = useCallback(async () => {
    const token = await getToken();
    if (!token) return;
    const r = await listFriends(token);
    if (r.ok) {
      setFr(r.data);
      onPendingChange(r.data.pending_count);
    }
  }, [getToken, onPendingChange]);

  // Load handle (for the invite link) + friends (for the badge) on mount.
  useEffect(() => {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const me = await postMe(token);
      if (me?.handle) setMyHandle(me.handle);
      void refreshFriends();
    })();
  }, [getToken, refreshFriends]);

  // Load the feed when entering the feed pane.
  useEffect(() => {
    if (sub === "feed") void refreshFeed();
  }, [sub, refreshFeed]);

  const [detailMissing, setDetailMissing] = useState(false);
  async function openDetail(shareId: string) {
    setDetailId(shareId);
    setDetail(null);
    setDetailMissing(false);
    setSub("detail");
    const token = await getToken();
    if (!token) return;
    const r = await getShare(token, shareId);
    // Dead-subject resilience (Social UX Fixes): a share whose ticket was
    // deleted/retracted 404s → show "no longer available" instead of hanging
    // on the loading "…". The bell deep-links here from a stale notification.
    if (r.ok) setDetail(r.data);
    else setDetailMissing(true);
  }

  const hasFriends = (fr?.friends.length ?? 0) > 0 || (fr?.pending_incoming.length ?? 0) > 0;

  return (
    <main className="app friends-screen">
      {sub !== "detail" && (
        <nav className="friends-seg" aria-label="friends panes">
          <button className={sub === "feed" ? "on" : ""} onClick={() => setSub("feed")}>
            {t("friends.feedTitle")}
          </button>
          <button className={sub === "list" ? "on" : ""} onClick={() => setSub("list")}>
            {t("friends.friendsTitle")}
            {(fr?.pending_count ?? 0) > 0 && (
              <span className="friends-badge">{fr!.pending_count}</span>
            )}
          </button>
          <button className={sub === "add" ? "on" : ""} onClick={() => setSub("add")}>
            {t("friends.addTitle")}
          </button>
        </nav>
      )}

      {sub === "feed" && (
        <FeedPane feed={feed} hasFriends={hasFriends} getToken={getToken} onOpen={openDetail} onAddFriend={() => setSub("add")} />
      )}
      {sub === "list" && (
        <ListPane fr={fr} getToken={getToken} onChange={refreshFriends} />
      )}
      {sub === "add" && (
        <AddPane getToken={getToken} myHandle={myHandle} onChange={refreshFriends} />
      )}
      {sub === "detail" && detailId && (
        <DetailPane
          detail={detail}
          missing={detailMissing}
          getToken={getToken}
          onBack={() => {
            setSub("feed");
            void refreshFeed();
          }}
        />
      )}
    </main>
  );
}

// ---- Feed pane -----------------------------------------------------------

function FeedPane({ feed, hasFriends, getToken, onOpen, onAddFriend }: {
  feed: FeedItem[] | null;
  hasFriends: boolean;
  getToken: () => Promise<string | null>;
  onOpen: (id: string) => void;
  onAddFriend: () => void;
}) {
  const { t } = useI18n();
  if (feed === null) return <p className="empty">…</p>;
  if (feed.length === 0) {
    return (
      <section className="section friends-empty">
        <p className="hint">{hasFriends ? t("friends.feedEmpty") : t("friends.feedEmptyNoFriends")}</p>
        {!hasFriends && (
          <button className="btn primary" onClick={onAddFriend}>{t("friends.addTitle")}</button>
        )}
      </section>
    );
  }
  return (
    <div className="friends-feed">
      {feed.map((item) => (
        <ShareCard key={item.id} item={item} getToken={getToken} onOpen={onOpen} />
      ))}
    </div>
  );
}

// ---- Friends list pane ---------------------------------------------------

function ListPane({ fr, getToken, onChange }: {
  fr: { friends: FriendSummary[]; pending_incoming: FriendSummary[]; pending_outgoing: FriendSummary[]; pending_count: number } | null;
  getToken: () => Promise<string | null>;
  onChange: () => Promise<void>;
}) {
  const { t } = useI18n();
  if (!fr) return <p className="empty">…</p>;
  if (fr.friends.length === 0 && fr.pending_incoming.length === 0 && fr.pending_outgoing.length === 0) {
    return (
      <section className="section friends-empty">
        <p className="hint">{t("friends.friendsEmptyHint")}</p>
      </section>
    );
  }
  async function accept(id: string) {
    const token = await getToken();
    if (!token) return;
    await acceptFriendRequest(token, id);
    void onChange();
  }
  async function decline(id: string) {
    const token = await getToken();
    if (!token) return;
    await declineFriendRequest(token, id);
    void onChange();
  }
  async function remove(id: string) {
    const token = await getToken();
    if (!token) return;
    await removeFriend(token, id);
    void onChange();
  }
  const label = (f: FriendSummary) => (f.handle ? `@${f.handle}` : f.display_name ?? "");
  return (
    <div className="friends-list">
      {fr.pending_incoming.length > 0 && (
        <section className="section">
          <h3 className="section-title">{t("friends.friendsTitle")}</h3>
          {fr.pending_incoming.map((f) => (
            <div key={f.id} className="friends-row">
              <span className="friends-avatar" style={{ background: avatarColor(label(f)) }}>{label(f).charAt(0).toUpperCase() || "?"}</span>
              <span className="friends-name">{label(f)}</span>
              <button className="btn primary friends-act" onClick={() => void accept(f.id)}>{t("friends.accept")}</button>
              <button className="btn ghost friends-act" onClick={() => void decline(f.id)}>{t("friends.decline")}</button>
            </div>
          ))}
        </section>
      )}
      <section className="section">
        {fr.friends.map((f) => (
          <div key={f.id} className="friends-row">
            <span className="friends-avatar" style={{ background: avatarColor(label(f)) }}>{label(f).charAt(0).toUpperCase() || "?"}</span>
            <span className="friends-name">{label(f)}</span>
            <button className="btn ghost friends-act" onClick={() => void remove(f.id)}>{t("friends.remove")}</button>
          </div>
        ))}
      </section>
    </div>
  );
}

// ---- Add friend pane (search + invite link) ------------------------------

function AddPane({ getToken, myHandle, onChange }: {
  getToken: () => Promise<string | null>;
  myHandle: string | null;
  onChange: () => Promise<void>;
}) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<(FriendSummary & { friendship: string })[] | null>(null);
  const [copied, setCopied] = useState(false);

  async function runSearch(query: string) {
    setQ(query);
    if (query.trim().length === 0) {
      setResults(null);
      return;
    }
    const token = await getToken();
    if (!token) return;
    const r = await searchUsers(token, query.trim());
    setResults(r.ok ? r.data : []);
  }

  async function add(id: string) {
    const token = await getToken();
    if (!token) return;
    await requestFriend(token, id);
    void onChange();
    // Refresh results to reflect the new pending state.
    void runSearch(q);
  }

  const inviteUrl = myHandle ? `${window.location.origin}/?friend=${encodeURIComponent(myHandle)}` : null;

  async function share() {
    if (!inviteUrl) return;
    // Web Share API where available (mobile → LINE/Messages share sheet, where
    // race-day friend groups live). On cancel/failure, do nothing (no copy).
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      try {
        await navigator.share({ title: t("invite.shareTitle"), text: t("invite.shareHint"), url: inviteUrl });
        return;
      } catch {
        return; // user dismissed the sheet — don't surprise-copy
      }
    }
    // Clipboard fallback (desktop / no Web Share).
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — leave the link visible for manual copy */
    }
  }

  const label = (f: FriendSummary) => (f.handle ? `@${f.handle}` : f.display_name ?? "");

  return (
    <div className="friends-add">
      <section className="section">
        <input
          className="friends-search"
          placeholder={t("friends.searchPlaceholder")}
          value={q}
          onChange={(e) => void runSearch(e.target.value)}
        />
        <p className="hint">{t("friends.searchHint")}</p>
        {results !== null && results.length === 0 && <p className="empty">{t("friends.noResults")}</p>}
        {results?.map((f) => (
          <div key={f.id} className="friends-row">
            <span className="friends-avatar" style={{ background: avatarColor(label(f)) }}>{label(f).charAt(0).toUpperCase() || "?"}</span>
            <span className="friends-name">{label(f)}</span>
            {f.friendship === "none" && (
              <button className="btn primary friends-act" onClick={() => void add(f.id)}>{t("friends.addFriend")}</button>
            )}
            {f.friendship === "pending_outgoing" && <span className="hint">{t("friends.pendingSent")}</span>}
            {f.friendship === "friends" && <span className="hint">{t("tabs.friends")}</span>}
          </div>
        ))}
      </section>

      <section className="section">
        <h3 className="section-title">{t("invite.shareTitle")}</h3>
        {/* The invite section NEVER renders blank. With a handle → the link +
            a Share button (navigator.share → clipboard fallback). Without
            (transitional only — the Phase B gate guarantees a handle for any
            signed-in session, so this branch is a safe fallback) → the
            set-handle hint. */}
        {inviteUrl ? (
          <>
            <p className="hint">{t("invite.shareHint")}</p>
            <div className="friends-invite">
              <code className="friends-invite-url">{inviteUrl}</code>
              <button className="btn primary" onClick={() => void share()}>
                {copied ? t("invite.shareCopied") : t("invite.shareButton")}
              </button>
            </div>
          </>
        ) : (
          <p className="hint">{t("invite.needHandle")}</p>
        )}
      </section>
    </div>
  );
}

// ---- Share detail pane (viewer) ------------------------------------------

function DetailPane({ detail, missing, getToken, onBack }: {
  detail: FeedItem | null;
  /** True when the share 404'd (deleted/retracted) — show a graceful "gone"
   *  state instead of hanging on the loading "…". */
  missing: boolean;
  getToken: () => Promise<string | null>;
  onBack: () => void;
}) {
  const { t, tFmt, lang } = useI18n();
  const ja = lang === "ja";
  if (missing) return (
    <div className="friends-detail">
      <div className="mt-back-head">
        <button className="mt-back" onClick={onBack}>‹</button>
      </div>
      <p className="empty">{t("friends.shareGone")}</p>
    </div>
  );
  if (!detail) return (
    <div className="friends-detail">
      <button className="mt-back" onClick={onBack}>‹</button>
      <p className="empty">…</p>
    </div>
  );
  const tk = detail.ticket;
  const ownerLabel = detail.owner.handle ? `@${detail.owner.handle}` : detail.owner.display_name ?? "";
  return (
    <div className="friends-detail">
      <div className="mt-back-head">
        <button className="mt-back" onClick={onBack}>‹</button>
        <div className="mt-back-title">{ownerLabel}</div>
      </div>
      <div className="sc-card is-detail">
        <header className="sc-head">
          <span className="sc-avatar" style={{ background: avatarColor(ownerLabel) }}>{ownerLabel.charAt(0).toUpperCase() || "?"}</span>
          <span className="sc-owner">{ownerLabel}</span>
          {detail.is_win && <span className="sc-win-badge">{t("friends.winBadge")}</span>}
        </header>
        {tk && (
          <div className="sc-body">
            <div className="sc-bethead">
              <span className="sc-bettype">{t(`betType.${tk.ticket.type}`)}</span>
            </div>
            <div className="sc-race">{ja ? tk.race.nameJa : tk.race.nameEn}{tk.race.grade ? ` · ${tk.race.grade}` : ""}</div>
            {/* Ticket-detail UX — structure-aware body; old share snapshots
                without `structure` take the legacy capped-chip path. */}
            <TicketLines ticket={tk.ticket} unitStake={tk.unit} />
            <div className="sc-foot">
              <span className="sc-cost">{t("mine.cost")} {yen(tk.ticket.cost)}</span>
              {detail.is_win && detail.multiplier != null && (
                <span className="sc-mult">{tFmt("friends.winMultiplier", { n: detail.multiplier })}</span>
              )}
            </div>
          </div>
        )}
      </div>
      <CommentThread shareId={detail.id} getToken={getToken} viewerIsOwner={false} />
    </div>
  );
}
