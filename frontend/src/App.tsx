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
import { Footer } from "./components/Footer";

type Step = "race" | "style" | "tickets" | "explain";
type View = "browse" | "mine";

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
  const [intuition, setIntuition] = useState<Record<string, IntuitionState>>(
    {},
  );
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

  // "Updated with your marks" toast: flashes once when intuition changes while
  // the user is viewing the Tickets step, so the auto-regen reshape is visible.
  // Tracked against its own ref so runner/style changes don't trigger it.
  const prevIntuition = useRef(intuition);
  useEffect(() => {
    const prev = prevIntuition.current;
    prevIntuition.current = intuition;
    if (prev === intuition) return;
    if (Object.keys(intuition).length === 0) return; // cleared, not a mark
    if (step !== "tickets") return;
    setToast(t("tickets.updatedMarks"));
    const id = window.setTimeout(() => setToast(""), 1800);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intuition, step]);

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
          intuition={intuition}
          onIntuition={(uma, next) => {
            // Toggle/clear a mark: replace or delete the entry so the
            // recommender sees a clean Record each time.
            setIntuition((prev) => {
              const copy = { ...prev };
              if (next === null) delete copy[uma];
              else copy[uma] = next;
              return copy;
            });
          }}
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
          intuition={intuition}
          onIntuition={(uma, next) => {
            setIntuition((prev) => {
              const copy = { ...prev };
              if (next === null) delete copy[uma];
              else copy[uma] = next;
              return copy;
            });
          }}
        />
      )}

      <Footer />
    </main>
  );
}

export default App;
