import { useEffect, useMemo, useRef, useState } from "react";
import { UserButton } from "@clerk/clerk-react";
import { useI18n } from "./i18n";
import { winProbs, type Runner } from "./lib/fairvalue";
import { recommend, recommendDiverse } from "./lib/recommender";
import type {
  StyleState,
  IntuitionState,
  Ticket,
  CommittedTicket,
} from "./lib/types";
import { DEFAULT_STYLE, moodKey } from "./lib/types";
import {
  loadImpressions,
  saveImpressions,
  impressionsByRace,
  clearRace as clearRaceForReset,
  type ImpressionMap,
} from "./lib/impressions";
import { loadFunnel, saveFunnel, type FunnelLane } from "./lib/funnel";
import { normalizeName } from "./lib/normalizeName";
import {
  fetchLiveSnapshot,
  seedManualRunners,
  type LiveSnapshot,
  type LiveRace,
} from "./api";
import { raceHasLiveOdds, snapshotRace } from "./lib/mytickets-view";
import { newTicketId } from "./lib/ticketId";
import { useAuth } from "./auth/AuthProvider";
import { postTicket } from "./auth/socialClient";
import { pushPending } from "./auth/ticketQueue";
import { useImpressionsSync } from "./auth/impressionsSync";
import { RaceScreen } from "./screens/RaceScreen";
import { TicketsScreen } from "./screens/TicketsScreen";
import { MyTicketsHome } from "./screens/MyTickets";
import { ReferenceScreen } from "./screens/ReferenceScreen";
import { RoundupPanel } from "./screens/RoundupPanel";
import { Footer } from "./components/Footer";
import { BottomTabBar } from "./components/BottomTabBar";
import { RaceContextBar } from "./components/RaceContextBar";

type Step = "race" | "tickets";
type View = "browse" | "mine" | "reference";

function App() {
  const i18n = useI18n();
  const { t, tFmt, lang, setLang } = i18n;
  // Lift auth into App so the header's "My Tickets" tab can trigger Clerk's
  // sign-in modal directly, and so placeTicket() can commit on the signed-in
  // user without re-reading the context inside the handler.
  const { isSignedIn, userId, getToken, openSignIn, clerkMounted } = useAuth();

  // Race-first UX: the race browser is the landing. "My Tickets" is a separate
  // top-level view toggled from the header (auth-gated). Session 3a collapsed
  // the builder to two steps (race → tickets) under view === "browse": Style is
  // now an inline "Refine ▾" panel on Tickets and Why is an inline per-ticket
  // <details>, so neither is a routed step anymore.
  const [view, setView] = useState<View>("browse");
  const [step, setStep] = useState<Step>("race");
  const [runners, setRunners] = useState<Runner[]>([]);
  const [raceLabel, setRaceLabel] = useState<string>("");
  const [selectedRaceDate, setSelectedRaceDate] = useState<string>("");
  const [selectedRaceKey, setSelectedRaceKey] = useState<string>("");
  // Frozen LiveRace object at selection time. placeTicket snapshots THIS
  // rather than re-finding the race in `snap`, which is replaced every 45s by
  // refreshSnap — a refresh that rotates the card (race ran and dropped off,
  // name drifted, meta.date rolled) would otherwise make the race-key lookup
  // miss silently and every Place-ticket tap bail with no POST, no toast.
  const [selectedRace, setSelectedRace] = useState<LiveRace | null>(null);
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapError, setSnapError] = useState<string>("");
  // ADR-0006: lifecycle of the selected race — "registered" (grayed, est odds),
  // "open" (live), "result", or "manual" (hand-entered).
  const [raceStatus, setRaceStatus] = useState<string>("manual");

  const [style, setStyle] = useState<StyleState>(DEFAULT_STYLE);
  // ADR-0011 Phase 1: replace the uma-keyed intuition record with the
  // (race_id, horse_key)-keyed impression store. raceId is the active race's
  // namespace key (JRA race_id when present, else the composite fallback);
  // impressions is the full in-memory mirror of localStorage, so child
  // components re-render naturally when a mark changes.
  const [raceId, setRaceId] = useState<string>("");
  const [impressions, setImpressions] = useState<ImpressionMap>(() =>
    loadImpressions(),
  );
  // ADR-0011 Phase 2: top-of-funnel lane choice ("quick" ticket-build vs
  // "research" roundup). Both lanes share the same drill-down + impression
  // store; this only picks the entry screen. null on first launch → the intro
  // card is shown until the user picks a lane.
  const [funnel, setFunnel] = useState<FunnelLane | null>(() => loadFunnel());
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // Transient status line on the Tickets screen (marks-applied / place result).
  const [toast, setToast] = useState<string>("");

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
      // Race-first UX: don't gate the snapshot on having runners. Prefer a
      // playable (has-runners) race for the auto-apply so the user lands on
      // something they can build tickets for; if every race is still 0-runner
      // (mid-week, shutuba finalizes Thu ~14:00 JST), fall back to surfacing
      // a registered one so the weekend G3s are visible instead of collapsing
      // to "No live card available."
      const all = s.races || [];
      const withRunners = all.filter((r) => (r.runners || []).length > 0);
      const pool = withRunners.length > 0 ? withRunners : all;
      if (pool.length > 0) {
        const open = pool.filter((r) => raceHasLiveOdds(r));
        const live = open.length > 0 ? open : pool;
        const feature =
          live.find((r) => /g1|takarazuka/i.test(r.name || "")) ||
          live[live.length - 1];
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
      // Milestone 4 form panel (jockey-gap option a): carry jockey fields
      // through so the FormPanel can query /api/jockeys/{id}/form. Absent on
      // legacy/manual runners; the panel then hides the jockey block.
      jockey_id: r.jockey_id ?? null,
      jockey_name: r.jockey_name ?? null,
      // ADR-0011 Phase 3b: carry the bracket (gate) through so the structural
      // views light up 枠連 on the live path. null when the draw isn't
      // published yet → bracketQuinellaAgg omits the row cleanly.
      gate: r.gate ?? null,
    }));
    setRunners(next);
    setRaceLabel(race.name || `${t("race.placeholderRace")} ${race.race_no}`);
    setSelectedRaceDate(date);
    setSelectedRaceKey(raceKey(race, date));
    setSelectedRace(race);
    setRaceStatus(race.status ?? (raceHasLiveOdds(race) ? "open" : "registered"));
    // ADR-0011 Phase 1: switch the active race namespace. JRA race_id when
    // present, else the composite `date|venue|race_no|name` key — marks land
    // in the new race's namespace; the prior race's marks stay in storage
    // (invisible until Phase 2 surfaces cross-race browsing). Old behavior
    // was `setIntuition({})` (wiped ALL marks in-memory); the namespace
    // switch preserves the user-visible "fresh race, no marks" experience
    // without losing prior research.
    setRaceId(race.race_id ?? raceKey(race, date));
    // Auto-regen effect (driven by [runners, style, impressions, raceId])
    // will refill tickets; no need to set them here.
  }

  function seedManual(n = 12) {
    setRunners(seedManualRunners(n));
    setRaceLabel(t("race.placeholderRace"));
    setSelectedRaceDate("");
    setSelectedRaceKey("");
    setSelectedRace(null);
    setRaceStatus("manual");
    // Manual mode has no race_id and no composite key — use a stable
    // namespace so in-session marks work (they won't survive reload to a
    // different race, which matches the old in-memory-only behavior).
    setRaceId("manual");
  }

  // Persist the impression store whenever it changes. Best-effort: failures
  // (quota / disabled storage) degrade silently to in-memory only — the
  // store layer swallows the throw so the React render never sees it.
  useEffect(() => {
    saveImpressions(impressions);
  }, [impressions]);

  // ADR-0018 (Session 5b): account-backed impression marks. Observer-only —
  // syncs the impressions state to /api/social/me/impressions when signed in.
  // On sign-in transition: GET → LWW merge → setImpressions → PUT (one-time
  // per session). While signed in: debounced best-effort PUT on changes. No
  // UI surface for sync failures (mirrors the ticketQueue offline tolerance).
  // The hook does NOT fork the store; RunnerMark/HorseDrillView write paths
  // are untouched.
  useImpressionsSync(impressions, setImpressions, {
    isSignedIn,
    getToken,
  });

  // ADR-0011 Phase 2: persist the funnel lane choice. Same best-effort shell
  // as the impression store.
  useEffect(() => {
    if (funnel) saveFunnel(funnel);
  }, [funnel]);

  // ---------- Derived: de-vigged probs ----------
  const { p } = useMemo(() => winProbs(runners), [runners]);
  const allUmas = useMemo(() => runners.map((r) => r.uma), [runners]);

  // ---------- Generate recommendations ----------
  //
  // Fix 3: tickets auto-regenerate as soon as a race has >=2 runners, and
  // again whenever style changes. The TICKETS tab is never a dead
  // end. Style is framed as optional refinement; the
  // "Standard tickets" CTA on the Race screen jumps straight to results.
  //
  // ADR-0011 Phase 1: the recommender's interface is still uma-keyed (its
  // math operates on combos of umas — changing the input shape would ripple
  // through recommender.ts + its tests for no behavioral gain). App.deriveIntuitionRecord
  // rebuilds that uma-keyed view on every regenerate from the impression
  // store + the current runners list. This is the "ticket builder consumes
  // byRace(race_id)" hop — the store IS the source of truth; the derived
  // record is just a thin adapter for the recommender's stable interface.
  function deriveIntuitionRecord(
    overrideImpressions?: ImpressionMap,
    overrideRaceId?: string,
  ): Record<string, IntuitionState> {
    const store = overrideImpressions ?? impressions;
    const ns = overrideRaceId ?? raceId;
    if (!ns) return {};
    const byHorseKey = impressionsByRace(store, ns);
    const out: Record<string, IntuitionState> = {};
    for (const r of runners) {
      const hk = normalizeName(r.name);
      if (hk && byHorseKey[hk]) out[r.uma] = byHorseKey[hk].mark;
    }
    return out;
  }

  function regenerate(
    overrideStyle?: StyleState,
    overrideImpressions?: ImpressionMap,
    overrideRaceId?: string,
  ) {
    const s = overrideStyle ?? style;
    const i = deriveIntuitionRecord(overrideImpressions, overrideRaceId);
    // Default diverse; personality refines: on the beginner path (DEFAULT_STYLE
    // + no intuition), surface one safer / balanced / spicier ticket each so
    // the user reaches 3 ideas in ≤2 decisions. The moment a personality is
    // picked OR any intuition is marked, switch to single-personality mode.
    const beginnerPath =
      s.personality === DEFAULT_STYLE.personality &&
      Object.keys(i).length === 0;
    const out = beginnerPath
      ? recommendDiverse({ allUmas, p, style: s, intuition: i })
      : recommend({ allUmas, p, style: s, intuition: i });
    setTickets(out);
  }

  // Auto-regen on any change to runners/style/impressions/raceId. Skip the
  // very first render (handled by the initial loadLive flow). Stay on the
  // current step.
  const firstRender = useRef(true);
  useEffect(() => {
    if (runners.length < 2) {
      setTickets([]);
      return;
    }
    if (firstRender.current) {
      firstRender.current = false;
    }
    regenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runners, style, impressions, raceId]);

  // "Updated with your marks" toast: flashes once when the user adds a mark
  // while on the Tickets step, so the auto-regen reshape is visible. Tracked
  // against the impression store (race-scoped) so a stale mark from another
  // race doesn't trigger it; runner/style changes don't trigger it either.
  const prevMarkCount = useRef<number>(0);
  useEffect(() => {
    const count = Object.keys(impressionsByRace(impressions, raceId)).length;
    const prev = prevMarkCount.current;
    prevMarkCount.current = count;
    if (count <= prev) return;       // only fires on a NEW mark, not a clear
    if (count === 0) return;          // empty state — no toast
    if (step !== "tickets") return;
    setToast(t("tickets.updatedMarks"));
    const id = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [impressions, raceId, step]);

  /** "Standard tickets" CTA — apply DEFAULT_STYLE + clear marks for this race, jump. */
  function standardTickets() {
    setStyle(DEFAULT_STYLE);
    if (raceId) setImpressions((prev) => clearRaceForReset(prev, raceId));
    regenerate(DEFAULT_STYLE, undefined, raceId);
    setStep("tickets");
  }

  /** Explicit "regenerate + show tickets now" — used by the Tickets Remix CTA. */
  function goToTickets() {
    regenerate();
    setStep("tickets");
  }

  /** Reset over-constraints and try again — used by the empty state. */
  function resetToStandard() {
    setStyle(DEFAULT_STYLE);
    if (raceId) setImpressions((prev) => clearRaceForReset(prev, raceId));
    regenerate(DEFAULT_STYLE, undefined, raceId);
  }

  /**
   * Place (commit) a single ticket from the Tickets screen — mirrors
   * MyTickets.commit(). If not signed in, open Clerk's sign-in modal and stop
   * (the user returns to the same TicketsScreen and taps Place again). On a
   * successful POST, drop into the My Tickets view; on failure, queue the
   * ticket offline and flash the offline-queued copy.
   */
  async function placeTicket(tk: Ticket) {
    if (!isSignedIn) {
      openSignIn();
      return;
    }
    // Use the race frozen at selection time. Re-finding it in `snap` would
    // miss whenever the 45s live refresh rotated the card (race ran / name
    // drifted / date rolled) — the silent-bail bug that made every tap no-op.
    const race = selectedRace;
    if (!race) {
      // This should not happen post-fix (selectedRace is set in applyRace).
      // Surface it loudly in DEV so a regression of the volatile-snap lookup
      // can't hide as a silent no-op again.
      if (import.meta.env.DEV) {
        // eslint-disable-next-line no-console
        console.warn(
          "[placeTicket] no selectedRace — Place tapped without a race context",
        );
      }
      return; // no race to snapshot — can't commit
    }
    const id = newTicketId();
    const serial = "KB-" + Math.random().toString(16).slice(2, 8).toUpperCase();
    const committed: CommittedTicket = {
      id,
      serial,
      ticket: tk,
      unit: style.unit,
      mood: moodKey(tk),
      state: "open",
      payoutBase: tk.avgPayout,
      race: snapshotRace(race, snap?.meta?.date),
      owner: "you",
      claps: 0,
      createdAt: Date.now(),
    };
    const token = await getToken();
    if (!token) {
      if (userId) pushPending(userId, committed);
      setToast(t("mine.offlineQueued"));
      setView("mine");
      return;
    }
    const r = await postTicket(token, committed);
    if (r.ok) {
      setToast("");
      setView("mine");
    } else {
      if (userId) pushPending(userId, committed);
      setToast(t("mine.offlineQueued"));
    }
  }

  // ---------- Step nav (two-step builder, under view === "browse") ----------
  // Session 3a: Race → Tickets only. Style folded into the inline Refine panel
  // on Tickets; Why folded into an inline per-ticket disclosure.
  const steps: { id: Step; label: string; enabled: boolean }[] = [
    { id: "race", label: t("nav.race"), enabled: true },
    {
      id: "tickets",
      label: t("nav.tickets"),
      enabled: runners.length >= 2,
    },
  ];

  // ADR-0007: My Tickets is its own full-screen home (own header). "Browse
  // races" (onClassic) returns here. AuthGate + AgeGate stay wrapped inside
  // MyTicketsHome as defense-in-depth (harmless when already authed).
  if (view === "mine") {
    return (
      <>
        <MyTicketsHome
          snap={snap}
          onClassic={() => setView("browse")}
          onToggleLang={() => setLang(lang === "ja" ? "en" : "ja")}
          impressions={impressions}
        />
        <BottomTabBar view={view} onNavigate={setView} />
      </>
    );
  }

  // Reference destination (ADR-0015): glossary-only. The weekend roundup
  // moved into the Races "Research" segment (RoundupPanel below) so the
  // two-lane funnel converges on a single destination. Full-screen, non-
  // auth-gated reference material. "Back to race builder" returns here.
  if (view === "reference") {
    return (
      <>
        <ReferenceScreen onBack={() => setView("browse")} />
        <BottomTabBar view={view} onNavigate={setView} />
      </>
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
        {/* Session 1 UX refactor: the top row holds only brand, language
            toggle, and ONE account slot. Destinations (Races / My Tickets /
            Reference) moved to the persistent <BottomTabBar />; the two-lane
            funnel moved to an in-view segmented control on the Races view. */}
        <div className="head-actions">
          <button
            className="lang-toggle"
            onClick={() => setLang(lang === "ja" ? "en" : "ja")}
            aria-label="toggle language"
          >
            {t("app.langToggle")}
          </button>
          {/* Single account slot. Signed-out → one "Sign in" affordance that
              opens Clerk's sign-in modal. Signed-in → Clerk's hosted
              <UserButton /> (avatar + menu). The UserButton is gated on BOTH
              isSignedIn and clerkMounted because the Playwright bypass branch
              fakes a session WITHOUT mounting <ClerkProvider>, and
              <UserButton /> throws without that ancestor. */}
          {isSignedIn && clerkMounted ? (
            <UserButton
              appearance={{
                elements: {
                  avatarBox: "kbm-userbtn-avatar",
                  userButtonTrigger: "kbm-userbtn",
                },
              }}
              afterSignOutUrl="/"
            />
          ) : (
            <button
              className="lang-toggle account-signin"
              onClick={() => openSignIn()}
              aria-label={t("account.signIn")}
            >
              {t("account.signIn")}
            </button>
          )}
        </div>
      </header>

      {/* Session 5a (ADR-0017): persistent race-context bar — "what race am I
          on and what's its status?" Visible on the Races destination whenever
          the funnel is Quick (not research — the roundup carries its own
          context) AND a race is applied (selectedRace or the manual sample
          card). Fed from the FROZEN selectedRace + raceStatus, not the live
          snap — the 45s snap rotation (refreshSnap replaces the snapshot,
          race may rotate off / name may drift) would silently blank a snap-
          re-lookup. Persists across BOTH steps (race → tickets). */}
      {view === "browse" &&
        funnel !== "research" &&
        (selectedRace || raceLabel) && (
          <RaceContextBar
            race={selectedRace}
            raceLabel={raceLabel}
            raceStatus={raceStatus}
          />
        )}

      {/* Session 3b (ADR-0015): the race→tickets stepper hides in research mode —
          Research renders RoundupPanel below, not the ticket-builder spine. The
          lane segmented control still shows so the user can flip back to Quick. */}
      {funnel !== "research" && (
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
      )}

      {/* Session 3b (ADR-0015): two-lane funnel rendered as an in-view
          segmented control near the top of the Races view. Quick keeps you on
          the live card ticket-builder; Research swaps in RoundupPanel inline —
          the two lanes now converge on a single destination (Races), sharing
          the App header + bottom tab bar + impression spine. The lane choice
          persists via saveFunnel (the [funnel] effect). Shown on the race
          picker step (and in research mode, so the user can flip back). */}
      {step === "race" && (
        <div
          className="lane-segmented"
          role="group"
          aria-label={t("lane.pickLane")}
        >
          <button
            type="button"
            className={funnel === "quick" ? "on" : ""}
            aria-pressed={funnel === "quick"}
            onClick={() => {
              setFunnel("quick");
              setView("browse");
              setStep("race");
            }}
          >
            {t("lane.quick")}
          </button>
          <button
            type="button"
            className={funnel === "research" ? "on" : ""}
            aria-pressed={funnel === "research"}
            onClick={() => {
              setFunnel("research");
              setView("browse");
              setStep("race");
            }}
          >
            {t("lane.research")}
          </button>
        </div>
      )}

      {/* ADR-0011 Phase 2: first-launch intro card. Shown only when the user
          hasn't picked a lane yet AND is still on the race picker (no race in
          flight). One short paragraph per lane, single-disclaimer posture.
          Dismissed on first selection (the segmented control sets `funnel`). */}
      {funnel === null && step === "race" && (
        <section className="section lane-intro">
          <h2>{t("lane.introTitle")}</h2>
          <div className="lane-introw-cols">
            <div className="lane-introw-col">
              <strong>{t("lane.quick")}</strong>
              <p className="hint">{t("lane.quickHint")}</p>
            </div>
            <div className="lane-introw-col">
              <strong>{t("lane.research")}</strong>
              <p className="hint">{t("lane.researchHint")}</p>
            </div>
          </div>
        </section>
      )}

      {/* Session 3b (ADR-0015): Research lane renders RoundupPanel inline —
          shares the App header + bottom tab bar + impression spine with the
          live-card builder. Marks made in the roundup drill-down land on the
          same store as marks made on the Quick ticket-builder. */}
      {funnel === "research" && step === "race" && (
        <RoundupPanel
          impressions={impressions}
          onSetImpressions={setImpressions}
          oddsSnapshotAt={
            snap?.meta?.published_at ?? snap?.meta?.updated_at ?? null
          }
        />
      )}

      {funnel !== "research" && step === "race" && (
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
          raceStatus={raceStatus}
          raceId={raceId}
          impressions={impressions}
          // Snapshot heartbeat — stamped into each mark so a future reader
          // can tell whether the mark was made against the live odds or a
          // stale snapshot. Falls back to updated_at when the producer hasn't
          // set published_at.
          oddsSnapshotAt={
            snap?.meta?.published_at ?? snap?.meta?.updated_at ?? null
          }
          onSetImpressions={setImpressions}
          unitStake={style.unit}
        />
      )}

      {funnel !== "research" && step === "tickets" && (
        <TicketsScreen
          tickets={tickets}
          onRemix={goToTickets}
          onReset={resetToStandard}
          style={style}
          onStyleChange={setStyle}
          onPlace={placeTicket}
          placeLabel={isSignedIn ? t("tickets.placeCta") : t("tickets.placeSignIn")}
          toast={toast}
          runners={runners}
          raceId={raceId}
          impressions={impressions}
        />
      )}

      <Footer />
      <BottomTabBar view={view} onNavigate={setView} />
    </main>
  );
}

export default App;
