import React, { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "./i18n";
import {
  winProbs,
  RET,
  type Runner,
  type BetType,
} from "./lib/fairvalue";
import { recommend } from "./lib/recommender";
import type {
  StyleState,
  IntuitionState,
  PersonalityId,
  Complexity,
  Flavor,
  Ticket,
  MoodKey,
  CommittedTicket,
  CommittedState,
  RaceSnapshot,
} from "./lib/types";
import { DEFAULT_STYLE, applyPersonality, moodKey } from "./lib/types";
import {
  fetchLiveSnapshot,
  seedManualRunners,
  type LiveSnapshot,
  type LiveRace,
} from "./api";
import { AuthGate } from "./auth/AuthGate";
import { AgeGate } from "./auth/AgeGate";
import { useAuth } from "./auth/AuthProvider";
import {
  postMe,
  postMeTyped,
  listTickets,
  postTicket,
  patchTicket,
  follow as socialFollow,
  unfollow as socialUnfollow,
  cheer as socialCheer,
  uncheer as socialUncheer,
  block as socialBlock,
  report as socialReport,
  getProfile,
  getFriendsOnRace,
  getFriendsOnCard,
  type PublicProfile,
  type FriendsAvatar,
} from "./auth/socialClient";
import {
  loadPending,
  pushPending,
  clearPending,
} from "./auth/ticketQueue";
import { resolveTicket, type RaceResult } from "./lib/settle";
import { storageKeyFor } from "./auth/storageKey";
import { exportTicketCard, type ShareOutcome } from "./lib/share";
import { yen, fmt } from "./lib/format";
import {
  MT_MOOD_COLOR,
  MT_VIBES,
  avatarColor,
  mtStateColor,
  mtSep,
  mtRaceKey,
  mtFmtDate,
  mtPickFeature,
  mtRunnersOf,
  mtLoadStored,
  raceHasLiveOdds,
  type MtView,
  type DriftDir,
} from "./lib/mytickets-view";
import { RaceScreen } from "./screens/RaceScreen";
import { StyleScreen } from "./screens/StyleScreen";
import { TicketsScreen } from "./screens/TicketsScreen";
import { ExplainScreen } from "./screens/ExplainScreen";

type Step = "mine" | "race" | "style" | "tickets" | "explain";

// Persistent not-betting-advice footer — non-negotiable per app_plan guardrails.
function Footer() {
  const { t } = useI18n();
  return (
    <footer className="foot">
      {t("footer.notAdvice")}
      <a href="/">{t("footer.back")}</a>
    </footer>
  );
}

function App() {
  const i18n = useI18n();
  const { t, tFmt, lang, setLang } = i18n;

  // ADR-0007: My Tickets is the home/landing; the classic builder is reached
  // via the New-bet flow (and an "advanced builder" affordance).
  const [step, setStep] = useState<Step>("mine");
  const [runners, setRunners] = useState<Runner[]>([]);
  const [raceLabel, setRaceLabel] = useState<string>("");
  const [selectedRaceDate, setSelectedRaceDate] = useState<string>("");
  const [selectedRaceKey, setSelectedRaceKey] = useState<string>("");
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapError, setSnapError] = useState<string>("");
  // ADR-0006: lifecycle of the selected race — "registered" (grayed, est odds),
  // "open" (live), "result", or "manual" (hand-entered).
  const [raceStatus, setRaceStatus] = useState<string>("manual");

  const [style, setStyle] = useState<StyleState>(DEFAULT_STYLE);
  const [intuition, setIntuition] = useState<Record<string, IntuitionState>>(
    {},
  );
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);

  // ---------- Live snapshot ----------
  useEffect(() => {
    loadLive(true);
    // ADR-0006: poll in the background so newly REGISTERED races (and odds
    // going live) surface within ~45s without a reload. This only refreshes
    // the snapshot (race list + odds in the picker); it never re-applies a
    // race, so a user's current selection or manual entry is left intact.
    const id = setInterval(() => {
      void refreshSnap();
    }, 45000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refreshSnap() {
    try {
      const s = await fetchLiveSnapshot();
      setSnap(s);
      setSnapError("");
    } catch {
      /* keep the last good snapshot; surfaced errors only on explicit reload */
    }
  }

  async function loadLive(silent: boolean) {
    if (!silent) setSnapLoading(true);
    try {
      const s = await fetchLiveSnapshot();
      setSnap(s);
      setSnapError("");
      // ADR-0006: a race is shown as soon as it is REGISTERED (has runners),
      // not only once odds open. Prefer an open race; otherwise surface a
      // registered one (grayed, estimated odds).
      const races = (s.races || []).filter(
        (r) => (r.runners || []).length > 0,
      );
      if (races.length > 0) {
        const open = races.filter((r) => raceHasLiveOdds(r));
        const pool = open.length > 0 ? open : races;
        const feature =
          pool.find((r) => /g1|takarazuka/i.test(r.name || "")) ||
          pool[pool.length - 1];
        applyRace(feature, s.meta?.date);
      } else {
        if (runners.length === 0) seedManual();
      }
    } catch (e) {
      setSnapError(e instanceof Error ? e.message : String(e));
      if (runners.length === 0) seedManual();
    } finally {
      setSnapLoading(false);
    }
  }

  function raceDate(race: LiveRace, fallbackDate?: string): string {
    return race.date ?? fallbackDate ?? snap?.meta?.date ?? "";
  }

  function raceKey(race: LiveRace, fallbackDate?: string): string {
    return `${raceDate(race, fallbackDate)}|${race.venue ?? ""}|${race.race_no}|${race.name ?? ""}`;
  }

  function applyRace(race: LiveRace, fallbackDate?: string) {
    // Fall back to estimated odds when the pool hasn't opened, so a registered
    // race is playable (grayed + labeled "estimated"). Scratched/odds-less
    // runners get 0 and winProbs treats them as out.
    const date = raceDate(race, fallbackDate);
    const next = (race.runners || []).map((r) => ({
      uma: String(r.umaban),
      name: r.name ?? null,
      odds: (r.win_odds ?? r.win_odds_est ?? 0) as number,
    }));
    setRunners(next);
    setRaceLabel(race.name || `${t("race.placeholderRace")} ${race.race_no}`);
    setSelectedRaceDate(date);
    setSelectedRaceKey(raceKey(race, date));
    setRaceStatus(race.status ?? (raceHasLiveOdds(race) ? "open" : "registered"));
    setIntuition({});
    // Auto-regen effect (driven by [runners, style, intuition]) will refill
    // tickets; no need to set them here.
  }

  function seedManual(n = 12) {
    setRunners(seedManualRunners(n));
    setRaceLabel(t("race.placeholderRace"));
    setSelectedRaceDate("");
    setSelectedRaceKey("");
    setRaceStatus("manual");
    setIntuition({});
  }

  // ---------- Derived: de-vigged probs ----------
  const { p } = useMemo(() => winProbs(runners), [runners]);
  const allUmas = useMemo(() => runners.map((r) => r.uma), [runners]);

  // ---------- Generate recommendations ----------
  //
  // Fix 3: tickets auto-regenerate as soon as a race has >=2 runners, and
  // again whenever style changes. The TICKETS tab is never a dead
  // end. Style is framed as optional refinement; the
  // "Standard tickets" CTA on the Race screen jumps straight to results.
  function regenerate(overrideStyle?: StyleState, overrideIntuition?: Record<string, IntuitionState>) {
    const s = overrideStyle ?? style;
    const i = overrideIntuition ?? intuition;
    const out = recommend({ allUmas, p, style: s, intuition: i });
    setTickets(out);
    setActiveTicketId(out[0]?.id ?? null);
  }

  // Auto-regen on any change to runners/style/intuition. Skip the very first
  // render (handled by the initial loadLive flow). Stay on the current step.
  const firstRender = useRef(true);
  useEffect(() => {
    if (runners.length < 2) {
      setTickets([]);
      setActiveTicketId(null);
      return;
    }
    if (firstRender.current) {
      firstRender.current = false;
    }
    regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runners, style, intuition]);

  /** "Standard tickets" CTA — apply DEFAULT_STYLE + empty intuition, jump. */
  function standardTickets() {
    setStyle(DEFAULT_STYLE);
    setIntuition({});
    regenerate(DEFAULT_STYLE, {});
    setStep("tickets");
  }

  /** Explicit "I want to see tickets now" — used by Style + Remix. */
  function goToTickets() {
    regenerate();
    setStep("tickets");
  }

  /** Reset over-constraints and try again — used by the empty state. */
  function resetToStandard() {
    setStyle(DEFAULT_STYLE);
    setIntuition({});
    regenerate(DEFAULT_STYLE, {});
  }

  // ---------- Step nav ----------
  const steps: { id: Step; label: string; enabled: boolean }[] = [
    { id: "mine", label: t("mine.home"), enabled: true },
    { id: "race", label: t("nav.race"), enabled: true },
    { id: "style", label: t("nav.style"), enabled: runners.length >= 2 },
    {
      id: "tickets",
      label: t("nav.tickets"),
      enabled: runners.length >= 2,
    },
    { id: "explain", label: t("nav.explain"), enabled: !!activeTicketId },
  ];

  // ADR-0007: My Tickets surface is its own full-screen home (own header). The
  // classic 4-step builder remains reachable via onClassic. Phase 1 wraps it
  // in AuthGate + AgeGate so identity + 20+ self-attestation precede the feed.
  if (step === "mine") {
    return (
      <MyTicketsHome
        snap={snap}
        onClassic={() => setStep("race")}
        onToggleLang={() => setLang(lang === "ja" ? "en" : "ja")}
      />
    );
  }

  return (
    <main className="app">
      <header className="head">
        <img
          className="avatar"
          src="/keibamon.png"
          width={44}
          height={44}
          alt="Keibamon"
        />
        <div>
          <p className="eyebrow">keibamon · 競馬モン</p>
          <h1>
            {t("app.title")} <span className="ja">競馬モン</span>
          </h1>
        </div>
        <button
          className="lang-toggle"
          onClick={() => setLang(lang === "ja" ? "en" : "ja")}
          aria-label="toggle language"
        >
          {t("app.langToggle")}
        </button>
      </header>

      <nav className="stepper" aria-label="steps">
        {steps.map((s) => (
          <button
            key={s.id}
            className={step === s.id ? "on" : ""}
            disabled={!s.enabled}
            aria-current={step === s.id ? "step" : undefined}
            onClick={() => setStep(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {step === "race" && (
        <RaceScreen
          runners={runners}
          raceLabel={raceLabel}
          snap={snap}
          snapLoading={snapLoading}
          snapError={snapError}
          selectedRaceDate={selectedRaceDate}
          selectedRaceKey={selectedRaceKey}
          onReload={() => loadLive(false)}
          onSeedManual={() => seedManual()}
          onApplyRace={applyRace}
          onStandard={standardTickets}
          onRefine={() => setStep("style")}
          raceStatus={raceStatus}
        />
      )}

      {step === "style" && (
        <StyleScreen
          style={style}
          onChange={setStyle}
          onBack={() => setStep("race")}
          onSeeTickets={goToTickets}
        />
      )}

      {step === "tickets" && (
        <TicketsScreen
          tickets={tickets}
          onRemix={goToTickets}
          onReset={resetToStandard}
          onBackStyle={() => setStep("style")}
          onExplain={(id) => {
            setActiveTicketId(id);
            setStep("explain");
          }}
        />
      )}

      {step === "explain" && (
        <ExplainScreen
          ticket={tickets.find((x) => x.id === activeTicketId) ?? null}
          style={style}
          onBack={() => setStep("tickets")}
        />
      )}

      <Footer />
    </main>
  );
}

// ============================================================================
// ADR-0007 — "My Tickets" surface (Phase 0)
// Recreates the design handoff against real data: the three vibe options come
// from the real recommend() engine, live odds/drift come from the existing 45s
// /api/live poll (NOT the prototype's 3s timer), and committed tickets persist
// to localStorage as a stand-in until the Clerk + social-D1 backend lands.
// ============================================================================

interface MyTicketsProps {
  snap: LiveSnapshot | null;
  onClassic: () => void;
  onToggleLang: () => void;
  /** Clerk user id; null only in transition states once MyTickets is rendered. */
  userId: string | null;
  /** Resolves a fresh Clerk JWT; null when signed out / Clerk unavailable. */
  getToken: () => Promise<string | null>;
}

// ADR-0007 Phase 1 — wraps MyTickets in AuthGate + AgeGate. The auth context
// is read here so MyTickets itself stays Clerk-free and testable. Best-effort
// profile upsert runs on sign-in (offline-first; postMe swallows its errors).
interface MyTicketsHomeProps {
  snap: LiveSnapshot | null;
  onClassic: () => void;
  onToggleLang: () => void;
}

function MyTicketsHome({ snap, onClassic, onToggleLang }: MyTicketsHomeProps) {
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

  return (
    <AuthGate isSignedIn={isSignedIn}>
      {ageVerified ? (
        <main className="app">
          <MyTickets
            snap={snap}
            onClassic={onClassic}
            onToggleLang={onToggleLang}
            userId={userId}
            getToken={getToken}
          />
          <Footer />
        </main>
      ) : (
        <AgeGate />
      )}
    </AuthGate>
  );
}

function MyTickets({ snap, onClassic, onToggleLang, userId, getToken }: MyTicketsProps) {
  const { t, tFmt, lang } = useI18n();
  const ja = lang === "ja";

  const [view, setView] = useState<MtView>("feed");
  const [detailId, setDetailId] = useState<string | null>(null);
  // Phase 3 — social state.
  const [selectedProfileHandle, setSelectedProfileHandle] = useState<string | null>(null);
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [friendsOnCard, setFriendsOnCard] = useState<{ count: number; avatars: FriendsAvatar[] }>({ count: 0, avatars: [] });
  const [friendsOnRace, setFriendsOnRace] = useState<Record<string, { count: number; avatars: FriendsAvatar[] }>>({});
  const [handlePromptOpen, setHandlePromptOpen] = useState(false);
  const [handleDraft, setHandleDraft] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleSetting, setHandleSetting] = useState(false);
  // Phase 4 — report modal state. `reportTarget` is null when modal is closed.
  const [reportTarget, setReportTarget] = useState<{ type: "ticket" | "user"; id: string } | null>(null);
  const [reportReason, setReportReason] = useState("");
  const [reportSending, setReportSending] = useState(false);
  // The signed-in viewer's handle (null = hasn't set one yet → prompt on social action).
  const [viewerHandle, setViewerHandle] = useState<string | null>(null);
  // Ref to the detail-card root so the share button can raster it.
  const detailCardRef = useRef<HTMLDivElement | null>(null);
  // Initial state is the localStorage CACHE so the feed renders instantly on
  // signed-in load (read-through). The first server GET below replaces it.
  const [tickets, setTickets] = useState<CommittedTicket[]>(() =>
    mtLoadStored(lang, userId),
  );
  const [selIdx, setSelIdx] = useState(1);
  const [unit, setUnit] = useState(200);
  const [burstId, setBurstId] = useState<string | null>(null);
  const [settleId, setSettleId] = useState<string | null>(null);
  const [toast, setToast] = useState<string>("");
  const [now, setNow] = useState(() => Date.now());
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

  function snapshotRace(race: LiveRace): RaceSnapshot {
    const date = race.date ?? fallbackDate ?? "";
    return {
      raceKey: mtRaceKey(race, fallbackDate),
      grade: race.grade_label ?? "",
      nameEn: race.name ?? "",
      nameJa: race.name ?? "",
      venueEn: race.venue ?? "",
      venueJa: race.venue ?? "",
      raceNo: race.race_no,
      dateEn: mtFmtDate(date, "en"),
      dateJa: mtFmtDate(date, "ja"),
      post: race.post_time ?? "",
      runners: (race.runners || []).map((r) => ({
        num: r.umaban,
        en: r.name ?? "",
        ja: r.name ?? "",
        odds: (r.win_odds ?? r.win_odds_est ?? 0) as number,
      })),
    };
  }

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
    const rs = snapshotRace(feature);
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
      const card = await getFriendsOnCard(token, raceKeys);
      if (!cancelled && card.ok) setFriendsOnCard(card.data);
      // Per-race counts: fetch for each raceKey with tickets we care about.
      // Cheap upper bound — the snapshot rarely has >12 races.
      const perRace: Record<string, { count: number; avatars: FriendsAvatar[] }> = {};
      for (const rk of raceKeys.slice(0, 12)) {
        const r = await getFriendsOnRace(token, rk);
        if (r.ok) perRace[rk] = r.data;
      }
      if (!cancelled) setFriendsOnRace(perRace);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snap, userId]);

  // ---- Phase 3 — read the viewer's handle on sign-in. If null, the first
  // social action will trip the set-handle prompt.
  useEffect(() => {
    if (!userId) {
      setViewerHandle(null);
      return;
    }
    void (async () => {
      const token = await getToken();
      if (!token) return;
      // postMe with no body upserts + returns the row (Phase 1 contract).
      const p = await postMe(token);
      if (p?.handle) setViewerHandle(p.handle);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

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
        const settled = {
          ...tk,
          state: outcome.state as CommittedState,
          ...(outcome.state === "won" ? { returned: outcome.returned } : {}),
        };
        next[idx] = settled;
        mutated = true;
        // Fire-and-forget PATCH. If it fails, the ticket stays 'open' on
        // the server; the next poll will re-resolve and re-PATCH.
        void patchTicket(token, tk.id, {
          state: outcome.state,
          returned: outcome.state === "won" ? outcome.returned : 0,
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

  /**
   * Phase 3 — cheer toggle. Optimistic flip; reconcile to server-authoritative
   * count on response. Second tap while already cheering = uncheer.
   *
   * Won-only + self-cheer are enforced at the server; a 409 surfaces a friendly
   * message and rolls back the optimistic update.
   */
  function cheer(id: string) {
    const tk = tickets.find((x) => x.id === id);
    if (!tk) return;
    // Gate: prompt for handle on first social action.
    if (!viewerHandle) {
      setHandlePromptOpen(true);
      return;
    }
    const wasCheering = !!tk.cheeredByMe;
    const next = tickets.map((x) =>
      x.id === id
        ? {
            ...x,
            cheeredByMe: !wasCheering,
            cheers: Math.max(0, (x.cheers ?? x.claps ?? 0) + (wasCheering ? -1 : 1)),
          }
        : x,
    );
    setTickets(next);
    mirrorToCache(next);
    if (!wasCheering) {
      setBurstId(id);
      window.setTimeout(() => setBurstId(null), 1100);
    }
    if (!userId) return;
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = !wasCheering
        ? await socialCheer(token, id)
        : await socialUncheer(token, id);
      if (r.ok) {
        const settled = tickets.map((x) =>
          x.id === id
            ? { ...x, cheers: r.data.count, cheeredByMe: r.data.cheeredByMe }
            : x,
        );
        setTickets(settled);
        mirrorToCache(settled);
      } else if (r.err.kind === "http" && r.err.status === 409) {
        // likely self-cheer or won-only; re-fetch to learn which.
        flash(t("mine.cannotCheerOwn"));
        // Roll back.
        const rolled = tickets.map((x) =>
          x.id === id ? { ...x, cheeredByMe: wasCheering } : x,
        );
        setTickets(rolled);
        mirrorToCache(rolled);
      } else if (r.err.kind === "http" && r.err.status === 429) {
        flash(t("mine.rateLimited"));
      }
    })();
  }

  /** Phase 3 — follow/unfollow a user by id. Used by ProfileView. */
  function doFollow(targetUserId: string, targetHandle: string | null) {
    if (!viewerHandle && targetHandle) {
      // Following doesn't strictly need the caller's handle, but the prompt
      // gives a better UX (the followee sees a real handle in their follower list).
      setHandlePromptOpen(true);
      return;
    }
    // Optimistic: we'll flip from the current profile.is_following.
    setProfile((p) =>
      p ? { ...p, is_following: true, follower_count: p.follower_count + 1 } : p,
    );
    void (async () => {
      const token = await getToken();
      if (!token) return;
      const r = await socialFollow(token, targetUserId);
      if (!r.ok && r.err.kind === "http" && r.err.status === 403) {
        flash(t("profile.blockedSelfFollow"));
      }
      // Reconcile by re-reading the profile (server-authoritative).
      if (targetHandle) void loadProfile(targetHandle, true);
    })();
  }
  function doUnfollow(targetUserId: string, targetHandle: string | null) {
    setProfile((p) =>
      p
        ? {
            ...p,
            is_following: false,
            follower_count: Math.max(0, p.follower_count - 1),
          }
        : p,
    );
    void (async () => {
      const token = await getToken();
      if (!token) return;
      await socialUnfollow(token, targetUserId);
      if (targetHandle) void loadProfile(targetHandle, true);
    })();
  }

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
   * Phase 3 — save a handle for the signed-in viewer. On 409 (taken) surface
   * inline; on success close the prompt and proceed with whatever social
   * action triggered it.
   */
  async function saveHandle() {
    const h = handleDraft.trim();
    if (!h || !/^[a-zA-Z0-9_]+$/.test(h)) {
      setHandleError(t("mine.setHandlePlaceholder"));
      return;
    }
    setHandleSetting(true);
    setHandleError(null);
    const token = await getToken();
    const r = await postMeTyped(token, { handle: h });
    setHandleSetting(false);
    if (r.ok) {
      setViewerHandle(r.data.handle ?? null);
      setHandlePromptOpen(false);
      setHandleDraft("");
    } else if (r.err.kind === "http" && r.err.status === 409) {
      setHandleError(t("mine.setHandlePlaceholder") + " — taken");
    } else {
      setHandleError(t("mine.shareFailed"));
    }
  }

  /** Phase 3 — export the detail card as a PNG (share or download). */
  async function doShare() {
    if (!detailCardRef.current) return;
    let outcome: ShareOutcome;
    try {
      outcome = await exportTicketCard(detailCardRef.current);
    } catch {
      flash(t("mine.shareFailed"));
      return;
    }
    if (outcome.kind === "none") {
      flash(t("mine.shareFailed"));
    }
    // 'shared' / 'downloaded' are silent successes — the OS already showed
    // the share sheet or saved the file.
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
    const id = "kb-" + Date.now().toString(36);
    const serial = "KB-" + Math.random().toString(16).slice(2, 8).toUpperCase();
    const tk: CommittedTicket = {
      id,
      serial,
      ticket: opt.ticket,
      unit,
      mood: opt.mood,
      state: "open",
      payoutBase: opt.ticket.avgPayout,
      race: snapshotRace(feature),
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
          pushPending(userId, tk);
          flash(t("mine.offlineQueued"));
          if (import.meta.env.DEV) {
            // eslint-disable-next-line no-console
            console.warn("[commit] POST failed, queued for retry:", r.err);
          }
        }
      })();
    }
  }
  function openDetail(id: string) {
    setDetailId(id);
    setView("detail");
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

  // ====================== FEED ======================
  function renderFeed() {
    return (
      <>
        <header className="mt-head">
          <div className="mt-brand">競</div>
          <div className="mt-brand-text">
            <div className="mt-brand-name">{t("app.title")}</div>
            <div className="mt-brand-eyebrow">KEIBAMON · 競馬モン</div>
          </div>
          <button
            className="lang-toggle"
            onClick={onToggleLang}
            aria-label="toggle language"
            style={{ marginRight: 8 }}
          >
            {t("app.langToggle")}
          </button>
          <div className="mt-me">{ja ? "私" : "You"}</div>
        </header>

        <div className="mt-feed">
          {friendsOnCard.count > 0 && (
            <div className="mt-community">
              <div className="mt-avatars">
                {friendsOnCard.avatars.slice(0, 8).map((f, i) => (
                  <div
                    key={i}
                    className="mt-avatar"
                    style={{ background: avatarColor(f.handle ?? f.display_name ?? "") }}
                    onClick={() =>
                      f.handle && openProfile(f.handle)
                    }
                    role={f.handle ? "button" : undefined}
                    tabIndex={f.handle ? 0 : undefined}
                  >
                    {(f.handle ?? f.display_name ?? "?").charAt(0).toUpperCase()}
                  </div>
                ))}
              </div>
              <div className="mt-community-text">
                {tFmt("mine.communityCard", { n: friendsOnCard.count })}
              </div>
            </div>
          )}

          {feature && (
            <div className="mt-banner">
              <div className="mt-banner-inner">
                <div className="mt-banner-eyebrow">
                  <span className="mt-dot mt-dot-gold" />
                  <span>
                    {t("mine.live")} · {t("mine.raceDay")}
                  </span>
                </div>
                <div className="mt-banner-name">{feature.name}</div>
                <div className="mt-banner-foot">
                  <span className="mt-banner-meta">
                    {feature.venue} · R{feature.race_no} ·{" "}
                    {mtFmtDate(feature.date ?? fallbackDate ?? "", lang)}
                  </span>
                  {countdownText(feature.post_time ?? "") && (
                    <span className="mt-chip-countdown">
                      {countdownText(feature.post_time ?? "")}
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="mt-section-head">
            <h2>{t("mine.home")}</h2>
            <span className="mt-count">
              {tFmt("mine.count", { n: tickets.length })}
            </span>
          </div>

          {tickets.length === 0 && (
            <p className="empty">{t("mine.empty")}</p>
          )}

          {tickets.map((tk) => {
            const open = tk.state === "open";
            const sep = mtSep(tk.ticket.type);
            const topNum = Number(tk.ticket.lines[0]?.combo[0] ?? 0);
            const topR = tk.race.runners.find((r) => r.num === topNum);
            const d = driftView(topNum, tk, open);
            const ownerYou = tk.owner === "you";
            const payLabel =
              tk.state === "won" ? t("mine.returned") : t("mine.ifHits");
            const payValue =
              tk.state === "won" ? tk.returned ?? 0 : tk.payoutBase;
            const payColor =
              tk.state === "won"
                ? "var(--gold-amber)"
                : tk.state === "miss"
                  ? "var(--miss)"
                  : "var(--ink)";
            return (
              <div
                key={tk.id}
                className="mt-card"
                onClick={() => openDetail(tk.id)}
                role="button"
                tabIndex={0}
              >
                <div
                  className="mt-stripe"
                  style={{ background: mtStateColor(tk.state) }}
                />
                <div className="mt-card-body">
                  <div className="mt-card-top">
                    <div className="mt-card-top-main">
                      <div className="mt-badges">
                        <span
                          className="mt-state-badge"
                          style={{ background: mtStateColor(tk.state) }}
                        >
                          {open ? t("mine.live") : t("mine.result")}
                        </span>
                        {tk.race.grade && (
                          <span className="mt-grade-badge">{tk.race.grade}</span>
                        )}
                      </div>
                      <div className="mt-card-race">{runnerRaceName(tk)}</div>
                    </div>
                    <span
                      className="mt-mood-pill"
                      style={{ background: MT_MOOD_COLOR[tk.mood] }}
                    >
                      {t(`mood.${tk.mood}`)}
                    </span>
                  </div>

                  <div className="mt-betline">
                    <span className="mt-bet-label">
                      {t(`betType.${tk.ticket.type}`)}
                    </span>
                    <div className="mt-chips">
                      {tk.ticket.lines.slice(0, 4).map((ln, j) => (
                        <span key={j} className="mt-chip">
                          {ln.combo.join(sep)}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div className="mt-metrics">
                    <div>
                      <div className="mt-metric-label">{t("mine.cost")}</div>
                      <div className="mt-metric-cost">{yen(tk.ticket.cost)}</div>
                    </div>
                    <div>
                      <div className="mt-metric-label">{payLabel}</div>
                      <div className="mt-metric-pay" style={{ color: payColor }}>
                        {yen(payValue)}
                      </div>
                    </div>
                  </div>

                  {open && (
                    <div className="mt-live-strip">
                      <div className="mt-live-row">
                        <span className="mt-dot-sm" />
                        <span className="mt-live-contender">
                          #{topNum} {topR ? runnerName(topR) : ""}
                        </span>
                        <span className="mt-live-odds">
                          {liveOdds(tk, topNum).toFixed(1)}
                        </span>
                        <span className="mt-drift" style={{ color: d.color }}>
                          {d.arrow} {d.label}
                        </span>
                        <span className="mt-countdown">
                          {countdownText(tk.race.post)}
                        </span>
                      </div>
                      <div className="mt-refresh">
                        <i />
                      </div>
                    </div>
                  )}

                  {!open && (
                    <div className="mt-owner-row">
                      <div
                        className="mt-owner-avatar"
                        style={{
                          background: ownerYou
                            ? "var(--turf)"
                            : (tk.owner as { color: string }).color,
                        }}
                      >
                        {ownerYou
                          ? ja
                            ? "私"
                            : "Y"
                          : ja
                            ? (tk.owner as { initialJa: string }).initialJa
                            : (tk.owner as { initial: string }).initial}
                      </div>
                      <span className="mt-owner-line">
                        {ownerYou
                          ? tk.state === "won"
                            ? t("mine.won")
                            : t("mine.settled")
                          : `${ja ? (tk.owner as { ja: string }).ja : (tk.owner as { en: string }).en} · ${t("mine.hit")}`}
                      </span>
                      {tk.state === "won" && (
                        <button
                          className="mt-cheer"
                          onClick={(e) => {
                            e.stopPropagation();
                            cheer(tk.id);
                          }}
                        >
                          <span style={{ fontSize: 13 }}>👏</span>
                          {tk.cheers ?? tk.claps}
                          {burstId === tk.id && burstSpans}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          <div className="mt-microline">{t("mine.notAdvice")}</div>
        </div>

        <button className="mt-fab" onClick={() => setView("new")}>
          <span>+</span>
          {t("mine.newBet")}
        </button>
      </>
    );
  }

  function runnerRaceName(tk: CommittedTicket): string {
    return (ja ? tk.race.nameJa : tk.race.nameEn) || tk.race.nameEn || "";
  }

  // ====================== NEW BET ======================
  function renderNew() {
    const selCost = options[selIdx]?.ticket.cost ?? 0;
    return (
      <>
        <div className="mt-back-head">
          <button className="mt-back" onClick={() => setView("feed")}>
            ‹
          </button>
          <div className="mt-back-title">{t("mine.newTitle")}</div>
          <button
            className="lang-toggle"
            onClick={onClassic}
            style={{ marginLeft: "auto" }}
          >
            {ja ? "詳細" : "Builder"}
          </button>
        </div>

        <div className="mt-new">
          {feature ? (
            <>
              <div className="mt-race-card">
                <div className="mt-race-card-eyebrow">
                  {feature.grade_label || "—"} · {t("mine.raceDay")}
                </div>
                <div className="mt-race-card-name">{feature.name}</div>
                <div className="mt-race-card-meta">
                  {feature.venue} · R{feature.race_no} ·{" "}
                  {mtFmtDate(feature.date ?? fallbackDate ?? "", lang)}
                  {feature.post_time ? ` · ${t("mine.post")} ${feature.post_time}` : ""}
                </div>
              </div>

              <div className="mt-vibe-label">{t("mine.pickVibe")}</div>
              {options.map((o, i) => {
                const sel = selIdx === i;
                const sep = mtSep(o.ticket.type);
                const descKey =
                  o.mood === "safer"
                    ? "mine.saferDesc"
                    : o.mood === "spicier"
                      ? "mine.spicierDesc"
                      : "mine.balancedDesc";
                return (
                  <div
                    key={o.mood}
                    className="mt-option"
                    style={{ borderColor: sel ? MT_MOOD_COLOR[o.mood] : "var(--line)" }}
                    onClick={() => setSelIdx(i)}
                  >
                    <div className="mt-option-head">
                      <span
                        className="mt-option-mooddot"
                        style={{ background: MT_MOOD_COLOR[o.mood] }}
                      />
                      <span className="mt-option-mood">{t(`mine.${o.mood}`)}</span>
                      <span className="mt-option-bet">
                        {t(`betType.${o.ticket.type}`)}
                      </span>
                      {sel && (
                        <span
                          className="mt-check"
                          style={{ background: MT_MOOD_COLOR[o.mood] }}
                        >
                          ✓
                        </span>
                      )}
                    </div>
                    <div className="mt-option-desc">{t(descKey)}</div>
                    <div className="mt-chips">
                      {o.ticket.lines.slice(0, 4).map((ln, j) => (
                        <span key={j} className="mt-chip">
                          {ln.combo.join(sep)}
                        </span>
                      ))}
                    </div>
                    <div className="mt-option-figures">
                      <div>
                        <span>{t("mine.cost")} </span>
                        <b>{yen(o.ticket.cost)}</b>
                      </div>
                      <div>
                        <span>{t("mine.ifHits")} </span>
                        <b className="pay">{yen(o.ticket.avgPayout)}</b>
                      </div>
                    </div>
                  </div>
                );
              })}

              <div className="mt-unit-label">{t("mine.unit")}</div>
              <div className="mt-units">
                {[100, 200, 300].map((v) => (
                  <button
                    key={v}
                    className={`mt-unit ${unit === v ? "on" : ""}`}
                    onClick={() => setUnit(v)}
                  >
                    ¥{v}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p className="empty">{t("race.noLive")}</p>
          )}
        </div>

        {feature && options.length > 0 && (
          <div className="mt-cta-wrap">
            <button className="mt-cta" onClick={commit}>
              {t("mine.confirm")} · {yen(selCost)}
            </button>
          </div>
        )}
      </>
    );
  }

  // ====================== PROFILE (Phase 3) ======================
  function renderProfile() {
    const p = profile;
    return (
      <>
        <div className="mt-back-head">
          <button className="mt-back" onClick={() => setView("feed")}>
            ‹
          </button>
          <div className="mt-back-title">{t("profile.title")}</div>
        </div>
        <div className="mt-profile">
          {profileLoading && !p && <p className="empty">…</p>}
          {!profileLoading && !p && <p className="empty">404</p>}
          {p && (
            <>
              <div className="mt-profile-head">
                <div
                  className="mt-profile-avatar"
                  style={{ background: avatarColor(p.handle ?? p.display_name ?? "") }}
                >
                  {(p.handle ?? p.display_name ?? "?").charAt(0).toUpperCase()}
                </div>
                <div className="mt-profile-meta">
                  <div className="mt-profile-handle">@{p.handle}</div>
                  <div className="mt-profile-counts">
                    <span>{tFmt("profile.followers", { n: p.follower_count })}</span>
                    <span>{tFmt("profile.following", { n: p.followee_count })}</span>
                  </div>
                </div>
                {userId && selectedProfileHandle && p.id !== "__self__" && (
                  <>
                    <button
                      className={`mt-follow-btn ${p.is_following ? "on" : ""}`}
                      onClick={() =>
                        p.is_following
                          ? doUnfollow(p.id, p.handle)
                          : doFollow(p.id, p.handle)
                      }
                    >
                      {p.is_following ? t("profile.unfollow") : t("profile.follow")}
                    </button>
                    <button
                      className="mt-block-btn"
                      onClick={() => doBlock(p.id)}
                    >
                      {t("profile.block")}
                    </button>
                    <button
                      className="mt-report-btn"
                      onClick={() =>
                        setReportTarget({ type: "user", id: p.id })
                      }
                    >
                      {t("profile.report")}
                    </button>
                  </>
                )}
              </div>
              <div className="mt-profile-tickets">
                {(!p.tickets || p.tickets.length === 0) && (
                  <p className="empty">{t("profile.noTickets")}</p>
                )}
                {(p.tickets ?? []).map((tk) => {
                  const sep = mtSep(tk.ticket.type);
                  const payLabel =
                    tk.state === "won" ? t("mine.returned") : t("mine.ifHits");
                  const payValue =
                    tk.state === "won" ? tk.returned ?? 0 : tk.payoutBase;
                  return (
                    <div
                      key={tk.id}
                      className="mt-card"
                      onClick={() => openDetail(tk.id)}
                      role="button"
                      tabIndex={0}
                    >
                      <div
                        className="mt-stripe"
                        style={{ background: mtStateColor(tk.state) }}
                      />
                      <div className="mt-card-body">
                        <div className="mt-card-top">
                          <div className="mt-badges">
                            <span
                              className="mt-state-badge"
                              style={{ background: mtStateColor(tk.state) }}
                            >
                              {tk.state === "open"
                                ? t("mine.live")
                                : t("mine.result")}
                            </span>
                            {tk.race.grade && (
                              <span className="mt-grade-badge">{tk.race.grade}</span>
                            )}
                          </div>
                          <div className="mt-card-race">{runnerRaceName(tk)}</div>
                        </div>
                        <div className="mt-chips">
                          {tk.ticket.lines.slice(0, 4).map((ln, j) => (
                            <span key={j} className="mt-chip">
                              {ln.combo.join(sep)}
                            </span>
                          ))}
                        </div>
                        <div className="mt-metrics">
                          <div>
                            <div className="mt-metric-label">{t("mine.cost")}</div>
                            <div className="mt-metric-cost">
                              {yen(tk.ticket.cost)}
                            </div>
                          </div>
                          <div>
                            <div className="mt-metric-label">{payLabel}</div>
                            <div className="mt-metric-pay">{yen(payValue)}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  // ====================== HANDLE PROMPT (Phase 3) ======================
  function renderHandlePrompt() {
    if (!handlePromptOpen) return null;
    return (
      <div className="mt-modal-overlay" onClick={() => setHandlePromptOpen(false)}>
        <div className="mt-modal" onClick={(e) => e.stopPropagation()}>
          <div className="mt-modal-title">{t("mine.setHandleTitle")}</div>
          <p className="mt-modal-hint">{t("mine.setHandleHint")}</p>
          <input
            className="mt-modal-input"
            type="text"
            value={handleDraft}
            placeholder={t("mine.setHandlePlaceholder")}
            onChange={(e) => {
              setHandleDraft(e.target.value);
              setHandleError(null);
            }}
            autoFocus
            maxLength={32}
          />
          {handleError && <div className="mt-modal-error">{handleError}</div>}
          <button
            className="mt-modal-cta"
            onClick={() => void saveHandle()}
            disabled={handleSetting || !handleDraft.trim()}
          >
            {handleSetting ? "…" : t("mine.setHandleCta")}
          </button>
        </div>
      </div>
    );
  }

  // ====================== REPORT MODAL (Phase 4) ======================
  function renderReportModal() {
    if (!reportTarget) return null;
    return (
      <div className="mt-modal-overlay" onClick={() => !reportSending && setReportTarget(null)}>
        <div className="mt-modal" onClick={(e) => e.stopPropagation()}>
          <div className="mt-modal-title">{t("profile.report")}</div>
          <p className="mt-modal-hint">{t("profile.reportReason")}</p>
          <textarea
            className="mt-modal-input"
            value={reportReason}
            placeholder={t("profile.reportReason")}
            onChange={(e) => setReportReason(e.target.value)}
            autoFocus
            maxLength={500}
            rows={3}
            disabled={reportSending}
          />
          <button
            className="mt-modal-cta"
            onClick={() => sendReport()}
            disabled={reportSending || !reportReason.trim()}
          >
            {reportSending ? "…" : t("profile.report")}
          </button>
        </div>
      </div>
    );
  }

  // ====================== DETAIL ======================
  function renderDetail() {
    const tk = detailTk;
    if (!tk) return null;
    const open = tk.state === "open";
    const sep = mtSep(tk.ticket.type);
    const ribbon =
      open
        ? "linear-gradient(135deg,#0E7A47,#16AC66)"
        : tk.state === "won"
          ? "linear-gradient(135deg,#D98A12,#F2A93B)"
          : "linear-gradient(135deg,#5E6E63,#8A9A8E)";
    const payLabel = tk.state === "won" ? t("mine.returned") : t("mine.ifHits");
    const payValue = tk.state === "won" ? tk.returned ?? 0 : tk.payoutBase;
    const payColor =
      tk.state === "won"
        ? "var(--gold-amber)"
        : tk.state === "miss"
          ? "var(--miss)"
          : "var(--ink)";
    const topNum = Number(tk.ticket.lines[0]?.combo[0] ?? 0);
    const board = tk.race.runners.slice(0, 6);
    const justSettled = settleId === tk.id;

    return (
      <>
        <div className="mt-back-head">
          <button className="mt-back" onClick={() => setView("feed")}>
            ‹
          </button>
          <div className="mt-back-title">{t("mine.ticketTitle")}</div>
        </div>

        <div className="mt-detail">
          <div className="mt-ticket" ref={detailCardRef}>
            {justSettled && (
              <div className="mt-confetti">
                {[
                  ["8%", "#15A862", 8, 13, "2px", "1.5s", "0s"],
                  ["20%", "#F2A93B", 7, 10, "2px", "1.7s", ".1s"],
                  ["33%", "#2D8CF0", 9, 9, "50%", "1.4s", ".05s"],
                  ["46%", "#FF6A6A", 7, 12, "2px", "1.65s", ".18s"],
                  ["58%", "#F2A93B", 8, 8, "50%", "1.5s", ".08s"],
                  ["70%", "#15A862", 7, 11, "2px", "1.75s", ".14s"],
                  ["82%", "#FF6A6A", 9, 9, "50%", "1.45s", ".03s"],
                  ["92%", "#2D8CF0", 7, 12, "2px", "1.6s", ".2s"],
                ].map((c, i) => (
                  <span
                    key={i}
                    style={{
                      left: c[0] as string,
                      width: c[2] as number,
                      height: c[3] as number,
                      borderRadius: c[4] as string,
                      background: c[1] as string,
                      animationDuration: c[5] as string,
                      animationDelay: c[6] as string,
                    }}
                  />
                ))}
              </div>
            )}

            <div className="mt-ribbon" style={{ background: ribbon }}>
              <div className="mt-ribbon-top">
                <div className="mt-ribbon-brand">
                  <div className="mt-ribbon-mark">競</div>
                  <span className="mt-ribbon-wordmark">KEIBAMON</span>
                </div>
                <span className="mt-serial">{tk.serial}</span>
              </div>
              <div className="mt-ribbon-pills">
                {tk.race.grade && (
                  <span className="mt-ribbon-pill">{tk.race.grade}</span>
                )}
                <span className="mt-ribbon-pill">
                  {open ? t("mine.live") : t("mine.result")}
                </span>
              </div>
              <div className="mt-ribbon-race">{runnerRaceName(tk)}</div>
              <div className="mt-ribbon-meta">
                {tk.race.venueEn} · R{tk.race.raceNo} ·{" "}
                {ja ? tk.race.dateJa : tk.race.dateEn}
                {tk.race.post ? ` · ${t("mine.post")} ${tk.race.post}` : ""}
              </div>
            </div>

            <div className="mt-perf">
              <i className="l" />
              <i className="r" />
            </div>

            <div className="mt-ticket-body">
              <div className="mt-ticket-bethead">
                <span className="mt-ticket-betlabel">
                  {t(`betType.${tk.ticket.type}`)}
                </span>
                <span
                  className="mt-mood-pill"
                  style={{ background: MT_MOOD_COLOR[tk.mood] }}
                >
                  {t(`mood.${tk.mood}`)}
                </span>
              </div>

              <div className="mt-chips-lg">
                {tk.ticket.lines.map((ln, j) => (
                  <span key={j} className="mt-chip-lg">
                    {ln.combo.join(sep)}
                  </span>
                ))}
              </div>

              <div className="mt-pay-panel">
                <div>
                  <div className="mt-metric-label">{t("mine.cost")}</div>
                  <div className="mt-pay-cost">{yen(tk.ticket.cost)}</div>
                  <div className="mt-pay-break">
                    {tk.ticket.lines.length}
                    {ja ? "点 × " : " × "}
                    {yen(tk.unit)}
                  </div>
                </div>
                <div className="mt-pay-right">
                  <div className="mt-metric-label">{payLabel}</div>
                  <div className="mt-pay-value" style={{ color: payColor }}>
                    {yen(payValue)}
                  </div>
                </div>
              </div>

              {open && (
                <div className="mt-board">
                  <div className="mt-board-head">
                    <span className="mt-dot-sm" />
                    <span className="mt-board-title">{t("mine.liveOdds")}</span>
                    <span className="mt-board-sub">{t("mine.oddsRefresh")}</span>
                    <span className="mt-countdown">
                      {countdownText(tk.race.post)}
                    </span>
                  </div>
                  <div className="mt-refresh" style={{ marginBottom: 10 }}>
                    <i />
                  </div>
                  {board.map((r) => {
                    const top = r.num === topNum;
                    const d = driftView(r.num, tk, open);
                    return (
                      <div key={r.num} className="mt-board-row">
                        <span
                          className="mt-board-num"
                          style={{
                            background: top ? "var(--turf)" : "var(--tint-3)",
                            color: top ? "#fff" : "var(--ink-2)",
                          }}
                        >
                          {r.num}
                        </span>
                        <span className="mt-board-name">{runnerName(r)}</span>
                        <span
                          className="mt-board-drift"
                          style={{ color: d.color }}
                        >
                          {d.arrow} {d.label}
                        </span>
                        <span className="mt-board-odds">
                          {liveOdds(tk, r.num).toFixed(1)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}

              {!open && (
                <div
                  className="mt-result"
                  style={{
                    background:
                      tk.state === "won" ? "var(--won-bg)" : "var(--miss-bg)",
                    border: `1px solid ${tk.state === "won" ? "var(--gold-border)" : "var(--line)"}`,
                  }}
                >
                  <div
                    className="mt-stamp"
                    style={{
                      background:
                        tk.state === "won" ? "var(--gold-amber)" : "#8A9A8E",
                      animation: justSettled ? "kbmStamp .6s ease-out" : "none",
                    }}
                  >
                    {tk.state === "won"
                      ? t("mine.hit")
                      : tk.state === "refunded"
                        ? t("mine.refund")
                        : t("mine.miss")}
                  </div>
                  <div>
                    <div className="mt-result-caption">
                      {tk.state === "won"
                        ? t("mine.returned")
                        : tk.state === "refunded"
                          ? t("mine.refunded")
                          : t("mine.settled")}
                    </div>
                    <div
                      className="mt-result-value"
                      style={{
                        color:
                          tk.state === "won" ? "var(--gold-amber)" : "#8A9A8E",
                      }}
                    >
                      {yen(payValue)}
                    </div>
                  </div>
                </div>
              )}

              <div className="mt-card-foot">
                <div className="mt-card-foot-mark">競</div>
                <div style={{ lineHeight: 1.2 }}>
                  <div className="mt-handle">{t("mine.handle")}</div>
                  <div className="mt-card-foot-micro" data-not-advice="">{t("mine.notAdvice")}</div>
                </div>
                <div className="mt-barcode" />
              </div>
            </div>
          </div>

          {open && import.meta.env.DEV && (
            <button className="mt-watch" onClick={() => settle(tk.id)}>
              <span className="mt-dot" />
              {t("mine.watchResult")}
            </button>
          )}

          <div className="mt-actions">
            <button
              className="mt-share"
              onClick={() => void doShare()}
            >
              <span style={{ fontSize: 16 }}>⇪</span>
              {t("mine.tapShare")}
            </button>
            {tk.state === "won" && (
              <button className="mt-cheer-lg" onClick={() => cheer(tk.id)}>
                <span style={{ fontSize: 16 }}>👏</span>
                {tk.cheers ?? tk.claps}
                {burstId === tk.id && burstSpans}
              </button>
            )}
            {/* Phase 4 — ticket report. Anyone can report any ticket
                (including their own — the moderation queue decides). */}
            <button
              className="mt-report-btn"
              onClick={() =>
                setReportTarget({ type: "ticket", id: tk.id })
              }
            >
              {t("profile.report")}
            </button>
          </div>

          <div className="mt-friends">
            <div className="mt-avatars">
              {(friendsOnRace[tk.race.raceKey]?.avatars ?? [])
                .slice(0, 8)
                .map((f, i) => (
                  <div
                    key={i}
                    className="mt-avatar"
                    style={{ background: avatarColor(f.handle ?? f.display_name ?? "") }}
                    onClick={(e) => {
                      if (f.handle) {
                        e.stopPropagation();
                        openProfile(f.handle);
                      }
                    }}
                    role={f.handle ? "button" : undefined}
                    tabIndex={f.handle ? 0 : undefined}
                  >
                    {(f.handle ?? f.display_name ?? "?").charAt(0).toUpperCase()}
                  </div>
                ))}
            </div>
            <div className="mt-friends-text">
              {tFmt("mine.friendsOnRace", {
                n: friendsOnRace[tk.race.raceKey]?.count ?? 0,
              })}
            </div>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="mt">
      {view === "feed" && renderFeed()}
      {view === "new" && renderNew()}
      {view === "detail" && renderDetail()}
      {view === "profile" && renderProfile()}
      {renderHandlePrompt()}
      {renderReportModal()}
      {toast && <div className="mt-toast">{toast}</div>}
    </div>
  );
}

export default App;
