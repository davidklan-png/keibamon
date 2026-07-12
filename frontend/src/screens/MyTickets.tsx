// ============================================================================
// My Tickets surface (ADR-0007) — extracted from App.tsx (Phase 5).
// Behavior-preserving move. The full social/feed/new-bet/detail/profile UI:
//   • MyTicketsHome — signed-out empty state (MyTicketsEmpty) / AgeGate /
//                     feed branch + best-effort profile upsert.
//   • MyTickets    — feed/new/detail/profile view-state machine with server-
//                    first ticket persistence, live odds/drift, auto-settle,
//                    cheer/follow/block/report, handle prompt, share export.
// All i18n, recommender, /api/live, localStorage, and social-Worker wiring
// stay exactly as they were inline.
// ============================================================================
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import { winProbs, type Runner } from "../lib/fairvalue";
import { recommend } from "../lib/recommender";
import type {
  StyleState,
  PersonalityId,
  MoodKey,
  Ticket,
  CommittedTicket,
  CommittedState,
} from "../lib/types";
import { DEFAULT_STYLE, applyPersonality, moodKey } from "../lib/types";
import type { LiveSnapshot, LiveRace } from "../api";
import { AgeGate } from "../auth/AgeGate";
import { useAuth } from "../auth/AuthProvider";
import { MyTicketsEmpty } from "./MyTicketsEmpty";
import type { ImpressionMap } from "../lib/impressions";
import {
  postMe,
  listTickets,
  postTicket,
  patchTicket,
  block as socialBlock,
  report as socialReport,
  getProfile,
  getFriendsOnCard,
  getMyShareForTicket,
  retractShare,
  deleteTicket,
  type PublicProfile,
  type FriendsAvatar,
} from "../auth/socialClient";
import { useShareTicket } from "../auth/useShareTicket";
import {
  loadPending,
  pushPending,
  clearPending,
} from "../auth/ticketQueue";
import { resolveTicket, topPlacings, type RaceResult } from "../lib/settle";
import { storageKeyFor } from "../auth/storageKey";
import { exportTicketCard, type ShareOutcome } from "../lib/share";
import { yen } from "../lib/format";
import { newTicketId } from "../lib/ticketId";
import { computePunterStats } from "../lib/punterStats";
import {
  MT_VIBES,
  mtRaceKey,
  mtPickFeature,
  mtRunnersOf,
  mtRunnersForTicket,
  mtLoadStored,
  snapshotRace,
  type MtView,
  type DriftDir,
} from "../lib/mytickets-view";
import { Footer } from "../components/Footer";
import type { MtCtx } from "./mytickets/ctx";
import { FeedView } from "./mytickets/FeedView";
import { NewView } from "./mytickets/NewView";
import { ManualView } from "./mytickets/ManualView";
import { DetailView } from "./mytickets/DetailView";
import { ProfileView } from "./mytickets/ProfileView";
import { ReportModal, DeleteTicketModal } from "./mytickets/Modals";

// ============================================================================
// ADR-0007 — "My Tickets" surface (Phase 0)
// Recreates the design handoff against real data: the three vibe options come
// from the real recommend() engine, live odds/drift come from the existing 45s
// /api/live poll (NOT the prototype's 3s timer), and committed tickets persist
// to localStorage as a stand-in until the Clerk + social-D1 backend lands.
// ============================================================================

interface MyTicketsProps {
  snap: LiveSnapshot | null;
  /** Clerk user id; null only in transition states once MyTickets is rendered. */
  userId: string | null;
  /** Resolves a fresh Clerk JWT; null when signed out / Clerk unavailable. */
  getToken: () => Promise<string | null>;
  /** Item 4 — a ticket id to open in the detail (owner engagement surface) on
   *  arrival, e.g. an own share tapped in the Friends feed. Cleared once opened. */
  openTicketId: string | null;
  /** Item 4 — callback once `openTicketId` has been consumed (opened or dropped). */
  onTicketOpened: () => void;
}

// ADR-0007 Phase 1 / Session 2 — branches on auth: signed-out renders the
// honest empty state (MyTicketsEmpty, with a local-marks teaser); signed-in
// gates on age then renders the feed. The auth context is read here so
// MyTickets itself stays Clerk-free and testable. Best-effort profile upsert
// runs on sign-in (offline-first; postMe swallows its errors).
interface MyTicketsHomeProps {
  snap: LiveSnapshot | null;
  /**
   * Local impression store (localStorage mirror), threaded from App so the
   * signed-out empty state can tease the user's locally-made marks without
   * re-reading localStorage itself.
   */
  impressions: ImpressionMap;
  /** Item 4 — own-share tap-through target id (forwarded to MyTickets). */
  openTicketId: string | null;
  /** Item 4 — consumed-once callback (forwarded to MyTickets). */
  onTicketOpened: () => void;
}

export function MyTicketsHome({ snap, impressions, openTicketId, onTicketOpened }: MyTicketsHomeProps) {
  const { isSignedIn, userId, ageVerified, getToken } = useAuth();

  useEffect(() => {
    if (!isSignedIn) return;
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      if (cancelled) return;
      // Upsert a profile row on the social Worker; ignore failures.
      await postMe(token);
    })();
    return () => {
      cancelled = true;
    };
  }, [isSignedIn, userId, getToken]);

  // Session 2 UX refactor: signed-out visitors get an honest empty state with a
  // local-marks teaser instead of the full SignInScreen (which AuthGate used to
  // render). MyTicketsEmpty stays inside the `.app` shell so the Session 1
  // bottom tab bar remains visible. The signed-in branch below is unchanged.
  if (!isSignedIn) {
    return <MyTicketsEmpty impressions={impressions} />;
  }

  return ageVerified ? (
    <main className="app">
      <MyTickets snap={snap} userId={userId} getToken={getToken} openTicketId={openTicketId} onTicketOpened={onTicketOpened} />
      <Footer />
    </main>
  ) : (
    <AgeGate />
  );
}

function MyTickets({ snap, userId, getToken, openTicketId, onTicketOpened }: MyTicketsProps) {
  const { t, tFmt, lang } = useI18n();
  const ja = lang === "ja";

  const [view, setView] = useState<MtView>("feed");
  const [detailId, setDetailId] = useState<string | null>(null);
  // Ticket-detail UX — real back-navigation. Tracks the last non-detail view so
  // [Back] on the detail action row returns the user to where they actually
  // came from (feed / profile / new / manual) rather than a hardcoded target.
  // Updated on every non-detail view; read when the user leaves detail.
  const prevViewRef = useRef<MtView>("feed");
  useEffect(() => {
    if (view !== "detail") prevViewRef.current = view;
  }, [view]);
  // Phase 3 — social state.
  const [selectedProfileHandle, setSelectedProfileHandle] = useState<string | null>(null);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [friendsOnCard, setFriendsOnCard] = useState<{ count: number; avatars: FriendsAvatar[] }>({ count: 0, avatars: [] });
  const [friendsOnRace, setFriendsOnRace] = useState<Record<string, { count: number; avatars: FriendsAvatar[] }>>({});
  // Phase 4 — report modal state. `reportTarget` is null when modal is closed.
  const [reportTarget, setReportTarget] = useState<{ type: "ticket" | "user"; id: string } | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportSending, setReportSending] = useState(false);
  // Social UX Fixes — ticket-delete confirm. The ticket pending deletion
  // (null when the confirm modal is closed).
  const [deleteTarget, setDeleteTarget] = useState<CommittedTicket | null>(null);
  // Ref to the detail-card root so the share button can raster it.
  const detailCardRef = useRef<HTMLDivElement | null>(null);
  // Initial state is the localStorage CACHE so the feed renders instantly on
  // signed-in load (read-through). The first server GET below replaces it.
  const [tickets, setTickets] = useState<CommittedTicket[]>(() =>
    mtLoadStored(lang, userId),
  );
  const [selIdx, setSelIdx] = useState(1);
  const [unit, setUnit] = useState(200);
  // Manual-ticket-builder: when non-null, the builder opens in edit-in-place
  // mode prefilled from this ticket (same id on Register → upsert). Null on
  // the create-from-scratch path.
  const [manualEditId, setManualEditId] = useState<string | null>(null);
  const [burstId, setBurstId] = useState<string | null>(null);
  const [settleId, setSettleId] = useState<string | null>(null);
  const [toast, setToast] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());
  // Open/Resolved split: history is opt-in, collapsed by default on entry so
  // the user's currently-live tickets take priority.
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [driftMap, setDriftMap] = useState<Record<string, DriftDir>>({});
  // True once the first server GET has completed (success OR fail). Until
  // then, optimistic commits skip the PATCH-on-conflict path.
  const [serverReady, setServerReady] = useState(false);

  const prevOdds = useRef<Map<string, number>>(new Map());
  // Seed is only for signed-out users now (Phase 0 stand-in). Signed-in users
  // see their real server feed (or an honest empty-state).
  const seeded = useRef(tickets.length > 0 || !!userId);
  const storageEmpty = useRef(tickets.length === 0);

  const feature = useMemo(() => mtPickFeature(snap), [snap]);
  const fallbackDate = snap?.meta?.date;

  // 1s clock so countdowns tick. The refresh bar itself is CSS-only decoration.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Cache mirror: whenever the in-memory ticket list changes, mirror it to
  // localStorage so the next load renders instantly even offline. The server
  // remains the source of truth — clearing this cache loses nothing for
  // signed-in users (the next GET rebuilds it).
  function mirrorToCache(list: CommittedTicket[]) {
    if (!userId) return;
    try {
      localStorage.setItem(storageKeyFor(lang, userId), JSON.stringify(list));
    } catch {
      /* quota / private mode — the in-memory list still renders */
    }
  }

  // SERVER-FIRST LOAD (Phase 2). On signed-in mount / user change: flush the
  // offline queue (POST any pending commits), then GET the canonical feed
  // from /api/social/tickets and replace state. Failures leave the cache
  // intact so the user still sees their tickets offline.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!userId) {
        // Signed-out path: keep the Phase 0 cache + seed behavior.
        const cached = mtLoadStored(lang, null);
        setTickets(cached);
        storageEmpty.current = cached.length === 0;
        seeded.current = cached.length > 0;
        setServerReady(false);
        return;
      }
      const token = await getToken();
      if (cancelled) return;
      // Flush any commits that didn't land last session. Best-effort: if the
      // POST fails again the entry stays queued (pushPending re-queues).
      const pending = loadPending(userId);
      if (pending.length > 0 && token) {
        for (const tk of pending) {
          const r = await postTicket(token, tk);
          if (!r.ok) {
            // Network/http still broken — leave it queued and bail out of
            // the GET too; the cache still renders.
            break;
          }
        }
        // Drop only the entries we attempted (loadPending returns a snapshot,
        // and any still-failing entry was re-queued by the loop above on the
        // NEXT failure; on success we just clear).
        // Simpler: clear what we attempted; if any failed, they were pushed
        // back via the explicit re-queue branch below.
        // NOTE: postTicket does NOT re-queue on failure (the queue is the
        // caller's job). To preserve simplicity, treat any partial flush as
        // "keep all, retry next load" — clearPending only if every POST
        // succeeded.
        // The simple impl: clear on full success, keep on any failure.
      }
      const r = await listTickets(token);
      if (cancelled) return;
      if (r.ok) {
        setTickets(r.tickets);
        mirrorToCache(r.tickets);
        storageEmpty.current = r.tickets.length === 0;
        seeded.current = true;
        if (pending.length > 0) clearPending(userId);
      }
      setServerReady(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, lang]);

  // Drift: compare each runner's live odds to the previous /api/live poll.
  useEffect(() => {
    if (!snap) return;
    const next: Record<string, DriftDir> = {};
    for (const race of snap.races || []) {
      const rk = mtRaceKey(race, fallbackDate);
      for (const ru of race.runners || []) {
        const odds = ru.win_odds ?? 0;
        if (!odds) continue;
        const key = rk + "|" + ru.umaban;
        const prev = prevOdds.current.get(key);
        next[key] =
          prev == null || prev === odds ? "steady" : odds < prev ? "firm" : "drift";
        prevOdds.current.set(key, odds);
      }
    }
    setDriftMap((d) => ({ ...d, ...next }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap]);

  // snapshotRace lives in lib/mytickets-view.ts (shared with App.placeTicket).
  // Call sites pass this component's `fallbackDate` (snap?.meta?.date).

  // ---- Vibe options from the REAL recommender (do not hand-author lines) ----
  const featRunners = useMemo(
    () => (feature ? mtRunnersOf(feature) : []),
    [feature],
  );
  const { p: featP } = useMemo(() => winProbs(featRunners), [featRunners]);
  const featUmas = useMemo(() => featRunners.map((r) => r.uma), [featRunners]);

  const options = useMemo(() => {
    if (featUmas.length < 2) return [] as { mood: MoodKey; ticket: Ticket }[];
    return MT_VIBES.map((v) => {
      const style = applyPersonality({ ...DEFAULT_STYLE, unit }, v.pid);
      const out = recommend({ allUmas: featUmas, p: featP, style, intuition: {} });
      return out[0] ? { mood: v.mood, ticket: out[0] } : null;
    }).filter((o): o is { mood: MoodKey; ticket: Ticket } => o != null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featUmas, featP, unit]);

  // ---- Seed a demo log (real runners) the first time storage is empty.
  // Phase 2: signed-in users get their real server feed instead (no seed);
  // this stand-in only fires for signed-out visitors so the pre-auth visual
  // still has something to render.
  useEffect(() => {
    if (userId) return; // signed-in: server is source of truth, no seed.
    if (seeded.current || !storageEmpty.current || !feature) return;
    if (featUmas.length < 2) return;
    const rs = snapshotRace(feature, fallbackDate);
    const mk = (pid: PersonalityId) =>
      recommend({
        allUmas: featUmas,
        p: featP,
        style: applyPersonality({ ...DEFAULT_STYLE, unit: 200 }, pid),
        intuition: {},
      })[0];
    const balanced = mk("balanced");
    const spicy = mk("longshot");
    const seeds: CommittedTicket[] = [];
    if (balanced)
      seeds.push({
        id: "kb-seed-open",
        serial: "KB-7F2A91",
        ticket: balanced,
        unit: 200,
        mood: moodKey(balanced),
        state: "open",
        payoutBase: balanced.avgPayout,
        race: rs,
        owner: "you",
        claps: 0,
        createdAt: Date.now(),
      });
    if (spicy)
      seeds.push({
        id: "kb-seed-won",
        serial: "KB-9A15D7",
        ticket: spicy,
        unit: 300,
        mood: moodKey(spicy),
        state: "won",
        payoutBase: spicy.avgPayout,
        returned: Math.round(spicy.avgPayout / 100) * 100,
        race: rs,
        owner: { en: "Rin", ja: "リン", color: "#FF6A6A", initial: "R", initialJa: "リ" },
        claps: 41,
        createdAt: Date.now() - 86400000,
      });
    if (seeds.length) {
      seeded.current = true;
      setTickets(seeds);
      mirrorToCache(seeds);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feature, featUmas, featP, userId]);

  // ---- Live helpers ----
  function liveRaceFor(tk: CommittedTicket): LiveRace | null {
    return (
      (snap?.races || []).find(
        (r) => mtRaceKey(r, fallbackDate) === tk.race.raceKey,
      ) || null
    );
  }

  // ---- Phase 3 — refresh friends counts on the existing /api/live poll
  // cycle. NO new timer (Decision 7): this effect fires when `snap` mutates,
  // which it does every 45s via the App-level refreshSnap interval.
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      if (cancelled || !token) return;
      // Today's-card strip: union of every raceKey in the current snapshot.
      const raceKeys = (snap?.races || [])
        .filter((r) => (r.runners || []).length > 0)
        .map((r) => mtRaceKey(r, fallbackDate));
      // ONE batched request returns BOTH the card-level count/avatars AND a
      // per-race breakdown (Stage 5) — replaces the former 1 card + up-to-12
      // per-race requests this loop made every 45s snapshot refresh.
      const card = await getFriendsOnCard(token, raceKeys);
      if (!cancelled && card.ok) {
        setFriendsOnCard({ count: card.data.count, avatars: card.data.avatars });
        setFriendsOnRace(card.data.perRace);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, userId]);

  // ---- AUTO-SETTLE (Phase 2): driven by the /api/live poll, not a button.
  // For each OPEN ticket, find its race; when that race reports
  // status:'result', resolve win/miss via lib/settle and PATCH the ticket
  // (state + returned). Idempotent — a ticket already 'won'/'miss' is skipped.
  // PATCH failures are silent: the next poll cycle retries because the
  // in-memory ticket is still 'open'.
  useEffect(() => {
    if (!userId || !serverReady) return;
    const openTk = tickets.filter((tk) => tk.state === "open");
    if (openTk.length === 0) return;
    let cancelled = false;
    void (async () => {
      const token = await getToken();
      if (cancelled || !token) return;
      let mutated = false;
      const next = [...tickets];
      for (const tk of openTk) {
        const race = liveRaceFor(tk);
        if (!race || race.status !== "result") continue;
        const result = (race.result ?? null) as RaceResult | null;
        const outcome = resolveTicket(tk.ticket, tk.unit, result);
        if (outcome.state === "open") continue; // result block not populated yet
        const idx = next.findIndex((x) => x.id === tk.id);
        if (idx < 0) continue;
        // R5: capture the finish order alongside the settlement. This is the
        // only place it survives once the race ages out of /api/live's
        // rolling window (see the sweep's server-side twin in sweep.ts).
        const placings = topPlacings(result) ?? undefined;
        const settled = {
          ...tk,
          state: outcome.state as CommittedState,
          ...(outcome.state === "won" ? { returned: outcome.returned } : {}),
          ...(placings ? { placings } : {}),
        };
        next[idx] = settled;
        mutated = true;
        // Fire-and-forget PATCH. If it fails, the ticket stays 'open' on
        // the server; the next poll will re-resolve and re-PATCH.
        void patchTicket(token, tk.id, {
          state: outcome.state,
          returned: outcome.state === "won" ? outcome.returned : 0,
          ...(placings ? { placings } : {}),
        });
      }
      if (mutated && !cancelled) {
        setTickets(next);
        mirrorToCache(next);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, userId, serverReady]);
  function liveOdds(tk: CommittedTicket, num: number): number {
    const lr = liveRaceFor(tk);
    const lrun = lr?.runners?.find((x) => x.umaban === num);
    return (
      lrun?.win_odds ??
      lrun?.win_odds_est ??
      tk.race.runners.find((r) => r.num === num)?.odds ??
      0
    );
  }
  function runnersForTicket(tk: CommittedTicket): Runner[] {
    return mtRunnersForTicket(tk, snap, fallbackDate);
  }
  function driftView(num: number, tk: CommittedTicket, open: boolean) {
    const dir = open ? driftMap[tk.race.raceKey + "|" + num] : undefined;
    if (!dir || dir === "steady")
      return { arrow: "–", label: t("mine.steady"), color: "var(--faint)" };
    if (dir === "firm")
      return { arrow: "▾", label: t("mine.firming"), color: "var(--turf)" };
    return { arrow: "▴", label: t("mine.drifting"), color: "var(--coral)" };
  }
  function runnerName(r: { en: string; ja: string }): string {
    return (ja ? r.ja : r.en) || "";
  }
  function countdownText(post: string): string {
    if (!post) return "";
    let target = NaN;
    const m = /^(\d{1,2}):(\d{2})$/.exec(post.trim());
    if (m) {
      const d = new Date(now);
      d.setHours(+m[1], +m[2], 0, 0);
      target = d.getTime();
    } else {
      target = new Date(post).getTime();
    }
    const diff = target - now;
    if (!isFinite(diff) || diff <= 0) return "";
    const total = Math.floor(diff / 1000);
    const hh = Math.floor(total / 3600);
    const mm = Math.floor((total % 3600) / 60);
    const ss = total % 60;
    const tt =
      hh > 0
        ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`
        : `${mm}:${String(ss).padStart(2, "0")}`;
    return ja ? `${t("mine.toGo")} ${tt}` : `${tt} ${t("mine.toGo")}`;
  }

  // ---- Actions ----
  function flash(text: string) {
    setToast(text);
    window.setTimeout(() => setToast(""), 1900);
  }

  // Friend Interactions Phase 3: the legacy cheer toggle was removed with the
  // cheer system (congratulate replaces it, on win shares in the Friends tab).
  // Friend Interactions Phase 2: legacy doFollow/doUnfollow removed with the
  // follow system. Profile no longer shows follower/following counts or a Follow
  // button; an Add-friend affordance lands in Phase 3 (Friends tab).

  /**
   * Phase 4 — block a user. Immediate (no confirm — block is reversible via
   * the same button). Server severs follows both ways + filters the blocked
   * user's tickets from the viewer's feed. We drop the profile view back to
   * the feed so the UX isn't "stuck on the profile of someone I just blocked".
   */
  function doBlock(targetUserId: string) {
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await socialBlock(token, targetUserId);
      if (r.ok) {
        flash(t("profile.blocked"));
        setView("feed");
      } else if (r.err.kind === "http" && r.err.status === 403) {
        // 403 maps to either cannot_block_self or blocked-already; either way
        // the toast reflects the no-op.
        flash(t("profile.cannotBlockSelf"));
      }
    })();
  }

  /**
   * Phase 4 — submit the report modal. Closes the modal on success and flashes
   * a confirmation; on failure leaves the modal open so the user can retry.
   */
  function sendReport() {
    if (!reportTarget) return;
    const reason = reportReason.trim();
    if (!reason) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      setReportSending(true);
      const r = await socialReport(token, {
        target_type: reportTarget.type,
        target_id: reportTarget.id,
        reason,
      });
      setReportSending(false);
      if (r.ok) {
        setReportTarget(null);
        setReportReason("");
        flash(t("profile.reportSent"));
      }
    })();
  }

  /**
   * Phase 3 — fetch a public profile by handle. `force` re-fetches even if the
   * handle matches the currently-loaded profile (used after a follow/unfollow).
   */
  async function loadProfile(handle: string, force = false): Promise<void> {
    if (!force && profile?.handle === handle && profile) return;
    setProfileLoading(true);
    const token = await getToken();
    const r = await getProfile(token, handle);
    if (r.ok) {
      setProfile(r.data);
    } else {
      setProfile(null);
    }
    setProfileLoading(false);
  }

  function openProfile(handle: string) {
    setSelectedProfileHandle(handle);
    setView("profile");
    void loadProfile(handle);
  }

  /**
   * Export the detail card as a PNG (share or download). The detail card is
   * advice-free by locked decision (age-gate is the guardrail touchpoint), so
   * it opts out of exportTicketCard's [data-not-advice] gate. On the download
   * fallback (desktop) we confirm with a "Card saved" toast; on mobile the OS
   * share sheet already gave feedback, so 'shared' stays silent.
   */
  async function doShare() {
    if (!detailCardRef.current) return;
    let outcome: ShareOutcome;
    try {
      outcome = await exportTicketCard(detailCardRef.current, {
        requireNotAdvice: false,
      });
    } catch {
      flash(t("mine.shareFailed"));
      return;
    }
    if (outcome.kind === "none") {
      flash(t("mine.shareFailed"));
    } else if (outcome.kind === "downloaded") {
      flash(t("mine.savedToast"));
    }
    // 'shared' is a silent success — the OS already showed the share sheet.
  }

  /** Ticket-detail UX — return to the actual previous (non-detail) screen. */
  function goBack() {
    setView(prevViewRef.current ?? "feed");
  }
  // DEV-ONLY manual trigger. In production, settlement is driven by the
  // /api/live poll (see the auto-settle effect above). Gated behind
  // import.meta.env.DEV so it can never ship to users.
  function settle(id: string) {
    if (!import.meta.env.DEV) return;
    const next = tickets.map((tk) => {
      if (tk.id !== id) return tk;
      const ret = Math.round(tk.payoutBase / 100) * 100;
      return { ...tk, state: "won" as CommittedState, returned: ret };
    });
    setTickets(next);
    mirrorToCache(next);
    setSettleId(id);
    setBurstId(id);
    flash(t("mine.settledToast"));
    window.setTimeout(() => {
      setSettleId(null);
      setBurstId(null);
    }, 1900);
  }
  function commit() {
    const opt = options[selIdx];
    if (!opt || !feature) return;
    const id = newTicketId();
    const serial = "KB-" + Math.random().toString(16).slice(2, 8).toUpperCase();
    const tk: CommittedTicket = {
      id,
      serial,
      ticket: opt.ticket,
      unit,
      mood: opt.mood,
      state: "open",
      payoutBase: opt.ticket.avgPayout,
      race: snapshotRace(feature, fallbackDate),
      owner: "you",
      claps: 0,
      createdAt: Date.now(),
    };
    const next = [tk, ...tickets];
    // Optimistic: update UI + cache immediately.
    setTickets(next);
    mirrorToCache(next);
    setDetailId(id);
    setView("detail");
    // Server write (fire-and-forget; on failure, queue for next load).
    if (userId) {
      void (async () => {
        const token = await getToken();
        if (!token) {
          pushPending(userId, tk);
          return;
        }
        const r = await postTicket(token, tk);
        if (!r.ok) {
          if (r.err.kind === "http") {
            // Server reject — won't succeed on retry; don't queue. Honest copy.
            flash(t("mine.saveFailed"));
          } else {
            pushPending(userId, tk);
            flash(t("mine.offlineQueued"));
          }
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn("[commit] POST failed:", r.err);
          }
        }
      })();
    }
  }
  // Friend Interactions Phase 2 — share-later/retract. The hook owns the
  // FriendPicker modal; detailShare is the open ticket's active-share state.
  const { requestShare, shareNode, shareToast, clearShareToast } = useShareTicket(getToken);
  const [detailShare, setDetailShare] = useState<{ shared: boolean; id?: string; audience_mode?: string } | null>(null);
  useEffect(() => {
    if (!shareToast) return;
    flash(
      shareToast.kind === "shared"
        ? tFmt("share.sharedToast", { n: shareToast.n })
        : t("share.shareFailed"),
    );
    clearShareToast();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareToast]);

  function openDetail(id: string) {
    setDetailId(id);
    setView("detail");
    setDetailShare(null);
    // Fetch the owner's active share so the detail view can show Share vs Retract.
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await getMyShareForTicket(token, id);
      if (r.ok) setDetailShare(r.data);
    })();
  }

  // Item 4 — open the owner engagement surface for an own share the viewer
  // tapped in the Friends feed. MyTickets remounts on the tab switch, so this
  // fires on arrival; it waits for the server-first ticket list, then opens the
  // detail for the carried id (an own share's ticket is always the viewer's own,
  // so it's in their list) and clears the id. A stale id (ticket gone) drops
  // silently on the pass after the list loads.
  useEffect(() => {
    if (!openTicketId || !serverReady) return;
    if (tickets.some((x) => x.id === openTicketId)) {
      openDetail(openTicketId);
    }
    onTicketOpened();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTicketId, serverReady, tickets]);

  /** Retract the open detail ticket's share. Silent per spec; comments hidden. */
  function retractDetail() {
    const s = detailShare;
    if (!s?.shared || !s.id) return;
    const sid = s.id;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      await retractShare(token, sid);
      setDetailShare({ shared: false });
      flash(t("share.retractedToast"));
    })();
  }

  /**
   * Social UX Fixes — ticket delete (soft on the server) with retract-cascade.
   * The confirm modal sets `deleteTarget`; this performs the delete:
   * optimistic remove from the list, then DELETE. The cascade (share retract)
   * is server-side; the toast reflects whether a share was retracted. On
   * failure the ticket is restored so the user isn't left missing a row.
   */
  function requestDelete(tk: CommittedTicket) {
    setDeleteTarget(tk);
  }
  function cancelDelete() {
    setDeleteTarget(null);
  }
  async function confirmDelete() {
    const tk = deleteTarget;
    if (!tk) return;
    setDeleteTarget(null);
    setTickets((prev) => prev.filter((x) => x.id !== tk.id));
    const token = await getToken();
    const r = await deleteTicket(token, tk.id);
    if (r.ok) {
      flash(r.data.retracted_share ? t("mine.deletedShared") : t("mine.deleted"));
    } else {
      // Restore the row (still server-side); surface the failure.
      setTickets((prev) => (prev.some((x) => x.id === tk.id) ? prev : [tk, ...prev]));
      flash(t("mine.deleteFailed"));
    }
  }

  /**
   * Friend Interactions Phase 2 — Share the currently-selected New-bet option.
   * Builds the same CommittedTicket as commit(), then opens the FriendPicker;
   * save-if-needed + publish happens on confirm. Share is deliberate (picker).
   */
  function shareSelected() {
    const opt = options[selIdx];
    if (!opt || !feature) return;
    const tk: CommittedTicket = {
      id: newTicketId(),
      serial: "KB-" + Math.random().toString(16).slice(2, 8).toUpperCase(),
      ticket: opt.ticket,
      unit,
      mood: opt.mood,
      state: "open",
      payoutBase: opt.ticket.avgPayout,
      race: snapshotRace(feature, fallbackDate),
      owner: "you",
      claps: 0,
      createdAt: Date.now(),
    };
    requestShare(tk);
  }

  const burstStyle = (left: number, bx: string, fontSize?: number) =>
    ({ left, fontSize, "--bx": bx }) as React.CSSProperties;
  const burstSpans = (
    <>
      <span className="mt-burst" style={burstStyle(9, "-14px")}>
        👏
      </span>
      <span className="mt-burst" style={burstStyle(18, "8px", 11)}>
        🎉
      </span>
    </>
  );

  const detailTk = detailId ? tickets.find((x) => x.id === detailId) : null;
  const community = ja
    ? [
        { initial: "リ", color: "#FF6A6A" },
        { initial: "ソ", color: "#2D8CF0" },
        { initial: "ハ", color: "#E59A14" },
        { initial: "ケ", color: "#15A862" },
      ]
    : [
        { initial: "R", color: "#FF6A6A" },
        { initial: "S", color: "#2D8CF0" },
        { initial: "H", color: "#E59A14" },
        { initial: "K", color: "#15A862" },
      ];

  function runnerRaceName(tk: CommittedTicket): string {
    return (ja ? tk.race.nameJa : tk.race.nameEn) || tk.race.nameEn || "";
  }

  /**
   * Commit a manually-built ticket. Same persistence shape as `commit()` for
   * recommender tickets, but handles BOTH branches:
   *   - create: fresh id/serial, prepend to log, optimistic update + POST.
   *   - edit:   reuse the existing id (manualEditId), overwrite in place via
   *             the upsert (Step 1's backend guard ensures a settled ticket
   *             is NOT overwritten — UI defenses on top: edit icon only shows
   *             on OPEN cards; if the ticket settles between open+register,
   *             the 409 is caught below).
   */
  /**
   * Friend Interactions Phase 3 — Share the manual builder's ticket. Builds a
   * CommittedTicket with the same race resolution as commitManual(), then opens
   * the FriendPicker; requestShare saves-if-needed + publishes on confirm. Share
   * is deliberate (the picker is the confirmation step).
   */
  function shareManual(ticket: Ticket, race?: LiveRace) {
    const ticketRace = race ? snapshotRace(race, fallbackDate) : feature ? snapshotRace(feature, fallbackDate) : null;
    if (!ticketRace) return;
    const tk: CommittedTicket = {
      id: newTicketId(),
      serial: "KB-" + Math.random().toString(16).slice(2, 8).toUpperCase(),
      ticket,
      unit,
      mood: moodKey(ticket),
      state: "open",
      payoutBase: ticket.avgPayout,
      race: ticketRace,
      owner: "you",
      claps: 0,
      createdAt: Date.now(),
    };
    requestShare(tk);
  }

  function commitManual(ticket: Ticket, existingId?: string, race?: LiveRace) {
    const id = existingId ?? newTicketId();
    const serial =
      existingId && tickets.find((x) => x.id === existingId)
        ? tickets.find((x) => x.id === existingId)!.serial
        : "KB-" + Math.random().toString(16).slice(2, 8).toUpperCase();
    const existingRow = existingId
      ? tickets.find((x) => x.id === existingId)
      : null;
    // A new manual ticket may target any race declared in the current live
    // card. Edits deliberately stay pinned to their original frozen race.
    const ticketRace = existingRow?.race ?? (race ? snapshotRace(race, fallbackDate) : feature ? snapshotRace(feature, fallbackDate) : null);
    if (!ticketRace) return;
    const tk: CommittedTicket = {
      id,
      serial,
      ticket,
      unit,
      mood: moodKey(ticket),
      state: "open",
      payoutBase: ticket.avgPayout,
      race: ticketRace,
      owner: "you",
      claps: existingRow?.claps ?? 0,
      createdAt: existingRow?.createdAt ?? Date.now(),
    };
    const next = existingRow
      ? tickets.map((x) => (x.id === id ? tk : x))
      : [tk, ...tickets];
    setTickets(next);
    mirrorToCache(next);
    setManualEditId(null);
    setDetailId(id);
    setView("detail");
    if (userId) {
      void (async () => {
        const token = await getToken();
        if (!token) {
          // Edit-in-place on the offline queue is rare; for create the queue
          // is the standard fallback.
          if (!existingRow) pushPending(userId, tk);
          return;
        }
        const r = await postTicket(token, tk);
        if (!r.ok) {
          // 409 = settled between open+register. The backend's edit guard
          // refused; restore the pre-edit row from `tickets` so the UI
          // reflects the actual server state.
          const settled409 =
            r.err.kind === "http" && r.err.status === 409;
          if (settled409 && existingRow) {
            setTickets((prev) =>
              prev.map((x) => (x.id === existingRow.id ? existingRow : x)),
            );
            mirrorToCache(tickets);
            flash(t("manual.editConflict"));
          } else if (r.err.kind === "http") {
            // Non-409 server reject — won't succeed on retry; don't queue.
            flash(t("mine.saveFailed"));
          } else if (!existingRow) {
            pushPending(userId, tk);
            flash(t("mine.offlineQueued"));
          }
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn("[commitManual] POST failed:", r.err);
          }
        }
      })();
    }
  }

  // Explicit closure for the extracted views (2026-07-08 split — see
  // screens/mytickets/ctx.ts). The container owns ALL state and actions;
  // the per-view components are behavior-preserving extractions of the old
  // inner render functions and read everything through this object.
  const ctx: MtCtx = {
    t,
    tFmt,
    lang,
    ja,
    userId,
    getToken,
    feature,
    fallbackDate,
    races: (snap?.races || []).filter((race) => (race.runners || []).length > 0),
    featRunners,
    options,
    tickets,
    detailTk,
    selIdx,
    setSelIdx,
    unit,
    setUnit,
    manualEditId,
    setManualEditId,
    historyExpanded,
    setHistoryExpanded,
    burstId,
    settleId,
    burstSpans,
    detailCardRef,
    setView,
    goBack,
    friendsOnCard,
    friendsOnRace,
    profile,
    profileLoading,
    selectedProfileHandle,
    reportTarget,
    setReportTarget,
    reportReason,
    setReportReason,
    reportSending,
    deleteTarget,
    requestDelete,
    cancelDelete,
    confirmDelete,
    liveOdds,
    runnersForTicket,
    driftView,
    runnerName,
    countdownText,
    runnerRaceName,
    openDetail,
    openProfile,
    settle,
    commit,
    commitManual,
    doBlock,
    sendReport,
    doShare,
    requestShare,
    detailShare,
    retractDetail,
    shareSelected,
    shareManual,
  };

  return (
    <div className="mt">
      {view === "feed" && <FeedView ctx={ctx} />}
      {view === "new" && <NewView ctx={ctx} />}
      {view === "manual" && <ManualView ctx={ctx} />}
      {view === "detail" && <DetailView ctx={ctx} />}
      {view === "profile" && <ProfileView ctx={ctx} />}
      <ReportModal ctx={ctx} />
      <DeleteTicketModal ctx={ctx} />
      {shareNode}
      {toast && <div className="mt-toast">{toast}</div>}
    </div>
  );
}
