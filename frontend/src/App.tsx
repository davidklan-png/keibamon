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
} from "./lib/types";
import { DEFAULT_STYLE, applyPersonality, moodKey } from "./lib/types";
import {
  fetchLiveSnapshot,
  seedManualRunners,
  type LiveSnapshot,
  type LiveRace,
} from "./api";

type Step = "race" | "style" | "tickets" | "explain";

const PERSONALITIES: PersonalityId[] = [
  "safe",
  "balanced",
  "longshot",
  "fan",
  "antiChalk",
];

const COMPLEXITIES: Complexity[] = ["auto", "two", "three", "straight"];
const FLAVORS: Flavor[] = ["mixed", "chalk", "value"];

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

function yen(n: number): string {
  return "¥" + Math.round(n).toLocaleString();
}

function fmt(n: number | undefined, d = 1): string {
  if (n == null || !isFinite(n)) return "-";
  return Number(n).toFixed(d);
}

/** ADR-0006: a race is "open" once any runner carries a live (non-estimated) price. */
function raceHasLiveOdds(race: LiveRace): boolean {
  if (race.status) return race.status === "open" || race.status === "result";
  return (race.runners || []).some((r) => (r.win_odds || 0) > 0);
}

function App() {
  const i18n = useI18n();
  const { t, tFmt, lang, setLang } = i18n;

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
    { id: "race", label: t("nav.race"), enabled: true },
    { id: "style", label: t("nav.style"), enabled: runners.length >= 2 },
    {
      id: "tickets",
      label: t("nav.tickets"),
      enabled: runners.length >= 2,
    },
    { id: "explain", label: t("nav.explain"), enabled: !!activeTicketId },
  ];

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
// Race Screen
// ============================================================================
interface RaceScreenProps {
  runners: Runner[];
  raceLabel: string;
  snap: LiveSnapshot | null;
  snapLoading: boolean;
  snapError: string;
  selectedRaceDate: string;
  selectedRaceKey: string;
  onReload: () => void;
  onSeedManual: () => void;
  onApplyRace: (r: LiveRace, fallbackDate?: string) => void;
  onStandard: () => void;
  onRefine: () => void;
  raceStatus: string;
}

function RaceScreen(props: RaceScreenProps) {
  const { t } = useI18n();
  const {
    runners,
    raceLabel,
    snap,
    snapLoading,
    snapError,
    selectedRaceDate,
    selectedRaceKey,
    onReload,
    onSeedManual,
    onApplyRace,
    onStandard,
    onRefine,
    raceStatus,
  } = props;

  // ADR-0006: list every registered race, not just ones with live odds.
  const cardRaces = (snap?.races || []).filter(
    (r) => (r.runners || []).length > 0,
  );
  const fallbackDate = snap?.meta?.date ?? "";
  const dateFor = (race: LiveRace) => race.date ?? fallbackDate;
  const keyFor = (race: LiveRace) =>
    `${dateFor(race)}|${race.venue ?? ""}|${race.race_no}|${race.name ?? ""}`;
  const dateOptions = Array.from(
    new Set(cardRaces.map(dateFor).filter((date) => date.length > 0)),
  );
  const activeDate = dateOptions.includes(selectedRaceDate)
    ? selectedRaceDate
    : dateOptions[0] || "";
  const racesForDate = cardRaces.filter((r) => dateFor(r) === activeDate);
  const activeRaceKey = racesForDate.some((r) => keyFor(r) === selectedRaceKey)
    ? selectedRaceKey
    : racesForDate.length > 0
      ? keyFor(racesForDate[0])
      : "";
  const pending = raceStatus === "registered";

  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("race.title")}</h2>
          <small>{t("race.hint")}</small>
        </div>
        <div className="grid-2" style={{ marginBottom: 10 }}>
          <select
            aria-label={t("race.date")}
            value={activeDate}
            onChange={(e) => {
              const nextDate = e.target.value;
              const nextRace = cardRaces.find((r) => dateFor(r) === nextDate);
              if (nextRace) onApplyRace(nextRace, fallbackDate);
            }}
          >
            {dateOptions.length === 0 ? (
              <option value="">{t("race.noLive")}</option>
            ) : (
              dateOptions.map((date) => (
                <option key={date} value={date}>
                  {date}
                </option>
              ))
            )}
          </select>
          <select
            aria-label={t("race.live")}
            value={activeRaceKey}
            onChange={(e) => {
              const r = racesForDate.find((x) => keyFor(x) === e.target.value);
              if (r) onApplyRace(r, fallbackDate);
            }}
          >
            {racesForDate.length === 0 ? (
              <option value="">{t("race.noLive")}</option>
            ) : (
              racesForDate.map((r) => (
                <option
                  key={keyFor(r)}
                  value={keyFor(r)}
                >
                  R{r.race_no} · {r.name || `Race ${r.race_no}`} ·{" "}
                  {r.venue || "-"}
                  {raceHasLiveOdds(r) ? "" : ` · ${t("race.pendingTag")}`}
                </option>
              ))
            )}
          </select>
        </div>
        <div className="grid-2" style={{ marginBottom: 10 }}>
          <div className="hint selected-race">{raceLabel}</div>
          <div className="btn-row">
            <button
              className="btn"
              onClick={onReload}
              disabled={snapLoading}
            >
              {snapLoading ? "..." : t("race.reload")}
            </button>
            <button className="btn gold" onClick={onSeedManual}>
              {t("race.manual")}
            </button>
          </div>
        </div>
        {snapError && (
          <p className="hint" style={{ color: "var(--warn)" }}>
            {snapError}
          </p>
        )}
      </section>

      {pending && (
        <p className="pending-banner">{t("race.pendingBanner")}</p>
      )}

      <section className={`section ${pending ? "is-pending" : ""}`}>
        <div className="section-title">
          <h2>{t("race.runners")}</h2>
        </div>
        {runners.length === 0 ? (
          <p className="empty">{t("tickets.noRunners")}</p>
        ) : (
          <div className="runners">
            {runners.map((r) => {
              return (
                <div key={r.uma} className="runner">
                  <span className="uma">{r.uma}</span>
                  <span>
                    <span className="nm">{r.name || `#${r.uma}`}</span>
                    <span className="odds-line">
                      <span className="odds-value">
                        {fmt(r.odds, 1)}
                      </span>
                      {pending && <span className="pc">{t("race.estOdds")}</span>}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <button
        className="btn primary"
        style={{ width: "100%" }}
        disabled={runners.length < 2}
        onClick={onStandard}
      >
        {t("race.standardCta")}
      </button>
      <p className="hint" style={{ textAlign: "center", marginTop: 8 }}>
        {t("race.standardHint")}
      </p>
      <button
        className="btn ghost"
        style={{ width: "100%", marginTop: 8 }}
        onClick={onRefine}
        disabled={runners.length < 2}
      >
        {t("race.refine")}
      </button>
    </>
  );
}

// ============================================================================
// Style Screen
// ============================================================================
interface StyleScreenProps {
  style: StyleState;
  onChange: (s: StyleState) => void;
  onBack: () => void;
  onSeeTickets: () => void;
}

function StyleScreen(props: StyleScreenProps) {
  const { t } = useI18n();
  const { style, onChange, onBack, onSeeTickets } = props;
  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("style.title")}</h2>
          <small>{t("style.hint")}</small>
        </div>
        {/* ADR-0005: personality is the ONE "how you play" control. Picking it
            derives flavor + complexity (Advanced lets power users override). */}
        <div className="persona-grid">
          {PERSONALITIES.map((id) => (
            <button
              key={id}
              className={`persona ${style.personality === id ? "on" : ""}`}
              onClick={() => onChange(applyPersonality(style, id))}
            >
              <div className="pname">{t(`personality.${id}.name`)}</div>
              <div className="pdesc">{t(`personality.${id}.desc`)}</div>
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <div className="grid-2">
          <div className="field">
            <label>{t("style.budget")} (¥)</label>
            <input
              type="number"
              min={100}
              step={100}
              value={style.budget}
              onChange={(e) =>
                onChange({ ...style, budget: Math.max(100, +e.target.value || 0) })
              }
            />
          </div>
          <div className="field">
            <label>{t("style.unit")} (¥)</label>
            <input
              type="number"
              min={100}
              step={100}
              value={style.unit}
              onChange={(e) =>
                onChange({ ...style, unit: Math.max(100, +e.target.value || 0) })
              }
            />
          </div>
        </div>
        {/* Advanced: the raw knobs personality now sets for you. Kept, not deleted. */}
        <details className="advanced">
          <summary>{t("style.advanced")}</summary>
          <div className="grid-2" style={{ marginTop: 10 }}>
            <div className="field">
              <label>{t("style.complexity")}</label>
              <select
                value={style.complexity}
                onChange={(e) =>
                  onChange({ ...style, complexity: e.target.value as Complexity })
                }
              >
                {COMPLEXITIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`style.complexity${cap(c)}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>{t("style.flavor")}</label>
              <select
                value={style.flavor}
                onChange={(e) =>
                  onChange({ ...style, flavor: e.target.value as Flavor })
                }
              >
                {FLAVORS.map((f) => (
                  <option key={f} value={f}>
                    {t(`style.flavor${cap(f)}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </details>
      </section>

      <button
        className="btn primary"
        style={{ width: "100%" }}
        onClick={onSeeTickets}
      >
        {t("tickets.title")} →
      </button>
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="btn ghost" onClick={onBack}>
          ← {t("nav.race")}
        </button>
      </div>
    </>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================================
// Tickets Screen
// ============================================================================
interface TicketsScreenProps {
  tickets: Ticket[];
  onRemix: () => void;
  onReset: () => void;
  onBackStyle: () => void;
  onExplain: (id: string) => void;
}

function TicketsScreen(props: TicketsScreenProps) {
  const { t } = useI18n();
  const { tickets, onRemix, onReset, onBackStyle, onExplain } = props;
  if (tickets.length === 0) {
    // Only reachable when a real regenerate() returned 0 tickets — i.e. the
    // current constraints (typically too many "avoid" tags) are unsolvable.
    // Pair the message with a one-tap reset instead of a dead end.
    return (
      <>
        <section className="section">
          <p className="empty">{t("tickets.noCandidates")}</p>
          <button
            className="btn primary"
            style={{ width: "100%", marginTop: 12 }}
            onClick={onReset}
          >
            {t("tickets.resetStandard")}
          </button>
        </section>
        <div className="btn-row">
          <button className="btn ghost" onClick={onBackStyle}>
            ← {t("tickets.backToStyle")}
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <div className="tickets">
        {tickets.map((tk, i) => {
          const sep = tk.type === "exacta" || tk.type === "trifecta" ? " > " : " - ";
          const shownLines = tk.lines.slice(0, 9);
          const mood = moodKey(tk);
          return (
            <article
              key={tk.id}
              className={`ticket ${i === 0 ? "top-pick" : ""}`}
            >
              {/* ADR-0005 Phase 3: default card carries two numbers + one mood
                  label. Hit %, variance, value tag and the house-edge line all
                  move to "Why" (one tap away). */}
              <div className="ticket-head">
                <div>
                  <h3>{t(`betType.${tk.type}`)}</h3>
                </div>
                <span className={`badge mood-${mood}`}>{t(`mood.${mood}`)}</span>
              </div>
              <div className="metrics">
                <div className="metric cost-metric">
                  <span>{t("tickets.cost")}</span>
                  <b>{yen(tk.cost)}</b>
                </div>
                <div className="metric">
                  <span>{t("tickets.ifHits")}</span>
                  <b>{yen(tk.avgPayout)}</b>
                </div>
              </div>
              <div className="combos">
                {shownLines.map((ln, j) => (
                  <span key={j} className="combo-chip">
                    {ln.combo.join(sep)}
                  </span>
                ))}
                {tk.lines.length > shownLines.length && (
                  <span className="combo-chip">
                    +{tk.lines.length - shownLines.length}
                  </span>
                )}
              </div>
              <div className="btn-row" style={{ marginTop: 12 }}>
                <button
                  className="btn gold"
                  onClick={() => onExplain(tk.id)}
                >
                  {t("tickets.whyTicket")}
                </button>
                <button className="btn ghost" onClick={onRemix}>
                  ⟳ {t("tickets.remix")}
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <div className="btn-row" style={{ marginTop: 12 }}>
        <button className="btn ghost" onClick={onBackStyle}>
          ← {t("tickets.backToStyle")}
        </button>
      </div>
    </>
  );
}

// ============================================================================
// Explain Screen
// ============================================================================
interface ExplainScreenProps {
  ticket: Ticket | null;
  style: StyleState;
  onBack: () => void;
}

function ExplainScreen(props: ExplainScreenProps) {
  const { t, tFmt } = useI18n();
  const { ticket, style, onBack } = props;
  if (!ticket) {
    return (
      <section className="section">
        <p className="empty">—</p>
        <button className="btn ghost" onClick={onBack}>
          ← {t("explain.back")}
        </button>
      </section>
    );
  }
  const sep = ticket.type === "exacta" || ticket.type === "trifecta" ? " > " : " - ";
  const ev = ticket.expectedReturn;
  const edgePct = ((ev / Math.max(1, ticket.cost) - 1) * 100).toFixed(0);
  const fairForTicket = ticket.lines[0]?.fairOdds ?? Infinity;
  // Coverage: how many of the contender pool's top combos this ticket holds.
  const coveragePct = (ticket.hitProb * 100).toFixed(ticket.hitProb < 0.1 ? 1 : 0);

  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("explain.title")}</h2>
          <small>
            {t(`betType.${ticket.type}`)} · {t(`valueTag.${ticket.tag}`)}
          </small>
        </div>
        {/* ADR-0005 Phase 3: plain sentence first, the math below it. */}
        <p className="explain-lead">
          {tFmt("explain.lead", {
            mood: t(`mood.${moodKey(ticket)}`),
            cost: yen(ticket.cost),
            hit: coveragePct,
          })}
        </p>
        <h3 className="details-heading">{t("explain.detailsHeading")}</h3>
        <dl className="explain">
          <dt>{t("explain.coverage")}</dt>
          <dd>
            {ticket.lines.length} {t("tickets.lines")} ·{" "}
            {t("tickets.hitEst")} {coveragePct}% ·{" "}
            {t("explain.fairValue")}: {fmt(fairForTicket, 1)}x
          </dd>
          <dt>{t("explain.upside")}</dt>
          <dd>
            {t("tickets.avgPayout")}: {yen(ticket.avgPayout)} ·{" "}
            {t("tickets.cost")}: {yen(ticket.cost)}
          </dd>
          <dt>{t("explain.fragility")}</dt>
          <dd>
            {ticket.variance === "high"
              ? t("tickets.variance")
              : t("tickets.lowVariance")}
            {ticket.tag === "chalk" && ` · ${t("valueTag.chalk")}`}
            {ticket.tag === "value" && ` · ${t("valueTag.value")}`}
          </dd>
          <dt>{t("explain.costLabel")}</dt>
          <dd>
            {yen(ticket.cost)} ({ticket.lines.length} × {yen(ticket.unit)})
          </dd>
        </dl>
        <div className="ev-line">
          {tFmt("tickets.estReturnLine", {
            ret: ev.toFixed(0),
            edge: `${edgePct}%`,
          })}{" "}
          {t("tickets.houseEdgeNote")}
        </div>
        <div className="combos">
          {ticket.lines.slice(0, 12).map((ln, j) => (
            <span key={j} className="combo-chip">
              {ln.combo.join(sep)}
            </span>
          ))}
        </div>
        <p className="math" style={{ marginTop: 16 }}>
          <strong>{t("explain.math")}:</strong>
          <br />
          {t("explain.mathBody")}
          <br />
          <span style={{ color: "var(--muted)" }}>
            RET[{ticket.type}] = {RET[ticket.type as BetType]} · γ = 0.856
          </span>
        </p>
        <p className="hint" style={{ marginTop: 12 }}>
          {t("explain.takeoutReminder")}
        </p>
      </section>
      <button className="btn primary" style={{ width: "100%" }} onClick={onBack}>
        ← {t("explain.back")}
      </button>
    </>
  );
}

export default App;
