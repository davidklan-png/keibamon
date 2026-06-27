import { useEffect, useMemo, useRef, useState } from "react";
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
import { useAuth } from "./auth/AuthProvider";
import { postTicket } from "./auth/socialClient";
import { pushPending } from "./auth/ticketQueue";
import { RaceScreen } from "./screens/RaceScreen";
import { StyleScreen } from "./screens/StyleScreen";
import { TicketsScreen } from "./screens/TicketsScreen";
import { ExplainScreen } from "./screens/ExplainScreen";
import { MyTicketsHome } from "./screens/MyTickets";
import { ReferenceScreen } from "./screens/ReferenceScreen";
import { Footer } from "./components/Footer";

type Step = "race" | "style" | "tickets" | "explain";
type View = "browse" | "mine" | "reference";

function App() {
  const i18n = useI18n();
  const { t, tFmt, lang, setLang } = i18n;
  // Lift auth into App so the header's "My Tickets" tab can trigger Clerk's
  // sign-in modal directly, and so placeTicket() can commit on the signed-in
  // user without re-reading the context inside the handler.
  const { isSignedIn, userId, getToken, openSignIn } = useAuth();

  // Race-first UX: the race browser is the landing. "My Tickets" is a separate
  // top-level view toggled from the header (auth-gated). The classic 4-step
  // builder (race → style → tickets → explain) lives under view === "browse".
  const [view, setView] = useState<View>("browse");
  const [step, setStep] = useState<Step>("race");
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
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);
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
    setActiveTicketId(out[0]?.id ?? null);
  }

  // Auto-regen on any change to runners/style/impressions/raceId. Skip the
  // very first render (handled by the initial loadLive flow). Stay on the
  // current step.
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

  /** Explicit "I want to see tickets now" — used by Style + Remix. */
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
    const race = (snap?.races || []).find(
      (r) => raceKey(r, snap?.meta?.date) === selectedRaceKey,
    );
    if (!race) return; // no race to snapshot — can't commit
    const id = "kb-" + Date.now().toString(36);
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

  // ---------- Step nav (classic builder, under view === "browse") ----------
  const steps: { id: Step; label: string; enabled: boolean }[] = [
    { id: "race", label: t("nav.race"), enabled: true },
    { id: "style", label: t("nav.style"), enabled: runners.length >= 2 },
    {
      id: "tickets",
      label: t("nav.tickets"),
      enabled: runners.length >= 2,
    },
    { id: "explain", label: t("nav.explain"), enabled: !!activeTicketId },
  ];

  // ADR-0007: My Tickets is its own full-screen home (own header). "Browse
  // races" (onClassic) returns here. AuthGate + AgeGate stay wrapped inside
  // MyTicketsHome as defense-in-depth (harmless when already authed).
  if (view === "mine") {
    return (
      <MyTicketsHome
        snap={snap}
        onClassic={() => setView("browse")}
        onToggleLang={() => setLang(lang === "ja" ? "en" : "ja")}
      />
    );
  }

  // Reference section: bilingual glossary + weekend graded-stakes roundup.
  // Full-screen, non-auth-gated (reference material). "Back to race builder"
  // (onBack) returns here. ADR-0011 Phase 2: threads the impression store so
  // the Roundup contender drill-down can read/write marks on the same spine.
  if (view === "reference") {
    return (
      <ReferenceScreen
        onBack={() => setView("browse")}
        impressions={impressions}
        onSetImpressions={setImpressions}
        oddsSnapshotAt={
          snap?.meta?.published_at ?? snap?.meta?.updated_at ?? null
        }
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
        {/* ADR-0011 Phase 2: two-path entry. "Quick ticket" jumps to the live
            card (browse); "Research" opens the Roundup. Both lanes share the
            same drill-down + impression store, so a mark made on either surface
            shows on the other. The active lane is visually marked. */}
        <button
          className={`lane-pill ${funnel === "quick" ? "on" : ""}`}
          onClick={() => {
            setFunnel("quick");
            setView("browse");
            setStep("race");
          }}
          aria-label={t("lane.quick")}
          aria-pressed={funnel === "quick"}
        >
          {t("lane.quick")}
        </button>
        <button
          className={`lane-pill ${funnel === "research" ? "on" : ""}`}
          onClick={() => {
            setFunnel("research");
            setView("reference");
          }}
          aria-label={t("lane.research")}
          aria-pressed={funnel === "research"}
        >
          {t("lane.research")}
        </button>
        {/* My Tickets tab — auth-gated. Triggers Clerk's sign-in modal when
            signed out (or age not yet self-attested) instead of navigating
            into the AuthGate full-screen. Non-dominant placement. */}
        <button
          className="lang-toggle mine-tab"
          onClick={() => {
            // Signed-in → drop into My Tickets (AgeGate inside MyTicketsHome
            // catches the not-yet-age-verified case at the right screen).
            // Signed-out → open Clerk's sign-in modal in place.
            if (isSignedIn) setView("mine");
            else openSignIn();
          }}
          aria-label={t("mine.home")}
        >
          {t("mine.home")}
        </button>
        {/* Reference section: bilingual glossary + weekend graded-stakes
            roundup. Non-auth-gated reference material. */}
        <button
          className="lang-toggle reference-tab"
          onClick={() => setView("reference")}
          aria-label={t("reference.home")}
        >
          {t("reference.tab")}
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

      {/* ADR-0011 Phase 2: first-launch intro card. Shown only when the user
          hasn't picked a lane yet AND is still on the race picker (no race in
          flight). One short paragraph per lane, single-disclaimer posture.
          Dismissed on first selection (the lane pills set `funnel`). */}
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
          onPlace={placeTicket}
          placeLabel={isSignedIn ? t("tickets.placeCta") : t("tickets.placeSignIn")}
          toast={toast}
        />
      )}

      {step === "explain" && (
        <ExplainScreen
          ticket={tickets.find((x) => x.id === activeTicketId) ?? null}
          style={style}
          onBack={() => setStep("tickets")}
          runners={runners}
          raceId={raceId}
          impressions={impressions}
          oddsSnapshotAt={
            snap?.meta?.published_at ?? snap?.meta?.updated_at ?? null
          }
          onSetImpressions={setImpressions}
        />
      )}

      <Footer />
    </main>
  );
}

export default App;
