// ============================================================================
// MtCtx — the explicit closure of the MyTickets container (2026-07-08 split;
// see docs/codebase-review-2026-07-08.md #5). MyTickets.tsx owns ALL state and
// actions and builds one `ctx` object per render; the per-view components
// (FeedView / NewView / ProfileView / DetailView / ManualView / Modals /
// TicketCard) are behavior-preserving extractions of the old inner render
// functions and read everything through this interface. No view component
// holds its own state — adding state here keeps the container the single
// source of truth, which is what the visual-regression suite pins.
// ============================================================================
import type React from "react";
import type { useI18n } from "../../i18n";
import type { LiveRace } from "../../api";
import type { Runner } from "../../lib/fairvalue";
import type { CommittedTicket, MoodKey, Ticket } from "../../lib/types";
import type { FriendsAvatar, PublicProfile } from "../../auth/socialClient";
import type { mtPickFeature, MtView } from "../../lib/mytickets-view";

type I18n = ReturnType<typeof useI18n>;
type Feature = ReturnType<typeof mtPickFeature>;
export type FriendsBadge = { count: number; avatars: FriendsAvatar[] };
export type ReportTarget = { type: "ticket" | "user"; id: string } | null;

export interface MtCtx {
  // i18n
  t: I18n["t"];
  tFmt: I18n["tFmt"];
  lang: I18n["lang"];
  ja: boolean;

  // container props threaded through
  userId: string | null;
  /** Clerk JWT getter — for the DetailView CommentThread (share-scoped). */
  getToken: () => Promise<string | null>;

  // live data
  feature: Feature;
  fallbackDate: string | undefined;
  /** Every live race with a declared runner field; manual tickets may target any of them. */
  races: LiveRace[];
  featRunners: Runner[];
  options: { mood: MoodKey; ticket: Ticket }[];

  // ticket state
  tickets: CommittedTicket[];
  detailTk: CommittedTicket | null | undefined;
  selIdx: number;
  setSelIdx: (i: number) => void;
  unit: number;
  setUnit: React.Dispatch<React.SetStateAction<number>>;
  manualEditId: string | null;
  setManualEditId: (id: string | null) => void;
  historyExpanded: boolean;
  setHistoryExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  burstId: string | null;
  settleId: string | null;
  burstSpans: React.ReactNode;
  detailCardRef: React.MutableRefObject<HTMLDivElement | null>;

  // view routing
  setView: (v: MtView) => void;
  /** Ticket-detail UX — return to the actual previous (non-detail) screen. */
  goBack: () => void;

  // social state
  friendsOnCard: FriendsBadge;
  friendsOnRace: Record<string, FriendsBadge>;
  profile: PublicProfile | null;
  profileLoading: boolean;
  selectedProfileHandle: string | null;

  // report modal state
  reportTarget: ReportTarget;
  setReportTarget: (v: ReportTarget) => void;
  reportReason: string;
  setReportReason: (v: string) => void;
  reportSending: boolean;

  // live helpers (close over snap/driftMap/now in the container)
  liveOdds: (tk: CommittedTicket, num: number) => number;
  /** Runner field for `tk`'s own race — never the app's globally "featured"
   *  race. Live-matched by raceKey when possible, else the frozen field
   *  captured on the ticket at commit time. */
  runnersForTicket: (tk: CommittedTicket) => Runner[];
  driftView: (
    num: number,
    tk: CommittedTicket,
    open: boolean,
  ) => { arrow: string; label: string; color: string };
  runnerName: (r: { en: string; ja: string }) => string;
  countdownText: (post: string) => string;
  runnerRaceName: (tk: CommittedTicket) => string;

  // actions
  openDetail: (id: string) => void;
  openProfile: (handle: string) => void;
  settle: (id: string) => void;
  commit: () => void;
  /** New manual tickets save against `race`; edits remain pinned to their original race. */
  commitManual: (ticket: Ticket, existingId?: string, race?: LiveRace) => void;
  doBlock: (targetUserId: string) => void;
  sendReport: () => void;
  // Social UX Fixes — ticket delete (soft) with retract-cascade.
  deleteTarget: CommittedTicket | null;
  requestDelete: (tk: CommittedTicket) => void;
  cancelDelete: () => void;
  confirmDelete: () => Promise<void>;
  doShare: () => Promise<void>;
  // Friend Interactions Phase 2 — share-later / retract on the owner's detail
  // view (the owner engagement surface; structured for Phase 3 congratulate +
  // comment counts + the comment thread to land here without rework).
  requestShare: (ticket: CommittedTicket) => void;
  /** Active share for the open detail ticket (null = unknown/loading). */
  detailShare: { shared: boolean; id?: string; audience_mode?: string } | null;
  retractDetail: () => void;
  /** Share the currently-selected New-bet option (opens FriendPicker). */
  shareSelected: () => void;
  /** Share the manual builder's ticket (opens FriendPicker). */
  shareManual: (ticket: Ticket, race?: LiveRace) => void;
}
