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
import { DEFAULT_STYLE } from "./lib/types";
import {
  fetchLiveSnapshot,
  seedManualRunners,
  type LiveSnapshot,
  type LiveRace,
} from "./api";

type Step = "race" | "style" | "intuition" | "tickets" | "explain";

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

function App() {
  const i18n = useI18n();
  const { t, tFmt, lang, setLang } = i18n;

  const [step, setStep] = useState<Step>("race");
  const [runners, setRunners] = useState<Runner[]>([]);
  const [raceLabel, setRaceLabel] = useState<string>("");
  const [snap, setSnap] = useState<LiveSnapshot | null>(null);
  const [snapLoading, setSnapLoading] = useState(false);
  const [snapError, setSnapError] = useState<string>("");

  const [style, setStyle] = useState<StyleState>(DEFAULT_STYLE);
  const [intuition, setIntuition] = useState<Record<string, IntuitionState>>(
    {},
  );
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [activeTicketId, setActiveTicketId] = useState<string | null>(null);

  // ---------- Live snapshot ----------
  useEffect(() => {
    loadLive(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadLive(silent: boolean) {
    if (!silent) setSnapLoading(true);
    try {
      const s = await fetchLiveSnapshot();
      setSnap(s);
      setSnapError("");
      const races = (s.races || []).filter((r) =>
        (r.runners || []).some((x) => (x.win_odds || 0) > 0),
      );
      if (races.length > 0) {
        const feature =
          races.find((r) => /g1|takarazuka/i.test(r.name || "")) ||
          races[races.length - 1];
        applyRace(feature);
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

  function applyRace(race: LiveRace) {
    const next = (race.runners || [])
      .filter((r) => (r.win_odds || 0) > 0)
      .map((r) => ({
        uma: String(r.umaban),
        name: r.name ?? null,
        odds: r.win_odds as number,
      }));
    setRunners(next);
    setRaceLabel(race.name || `${t("race.placeholderRace")} ${race.race_no}`);
    setIntuition({});
    // Auto-regen effect (driven by [runners, style, intuition]) will refill
    // tickets; no need to set them here.
  }

  function seedManual(n = 12) {
    setRunners(seedManualRunners(n));
    setRaceLabel(t("race.placeholderRace"));
    setIntuition({});
  }

  function addRunner() {
    setRunners((prev) => [
      ...prev,
      { uma: String(prev.length + 1), name: null, odds: 10.0 },
    ]);
  }

  function setOdds(uma: string, odds: number) {
    setRunners((prev) =>
      prev.map((r) => (r.uma === uma ? { ...r, odds } : r)),
    );
  }

  // ---------- Derived: de-vigged probs ----------
  const { p, overround } = useMemo(() => winProbs(runners), [runners]);
  const allUmas = useMemo(() => runners.map((r) => r.uma), [runners]);

  // ---------- Generate recommendations ----------
  //
  // Fix 3: tickets auto-regenerate as soon as a race has >=2 runners, and
  // again whenever style/intuition change. The TICKETS tab is never a dead
  // end. Style/Intuition are reframed as optional refinement; the
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

  /** Explicit "I want to see tickets now" — used by Intuition Generate + Remix. */
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
      id: "intuition",
      label: t("nav.intuition"),
      enabled: runners.length >= 2,
    },
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
          p={p}
          overround={overround}
          intuition={intuition}
          onReload={() => loadLive(false)}
          onSeedManual={() => seedManual()}
          onAddRunner={addRunner}
          onSetOdds={setOdds}
          onApplyRace={applyRace}
          onStandard={standardTickets}
          onRefine={() => setStep("style")}
        />
      )}

      {step === "style" && (
        <StyleScreen
          style={style}
          onChange={setStyle}
          onBack={() => setStep("race")}
          onNext={() => setStep("intuition")}
        />
      )}

      {step === "intuition" && (
        <IntuitionScreen
          runners={runners}
          p={p}
          intuition={intuition}
          onChange={(uma, v) =>
            setIntuition((prev) => {
              const next = { ...prev };
              if (v === null) delete next[uma];
              else next[uma] = v;
              return next;
            })
          }
          onBack={() => setStep("style")}
          onGenerate={goToTickets}
        />
      )}

      {step === "tickets" && (
        <TicketsScreen
          tickets={tickets}
          onRemix={goToTickets}
          onReset={resetToStandard}
          onBackStyle={() => setStep("style")}
          onBackIntuition={() => setStep("intuition")}
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
  p: Record<string, number>;
  overround: number;
  intuition: Record<string, IntuitionState>;
  onReload: () => void;
  onSeedManual: () => void;
  onAddRunner: () => void;
  onSetOdds: (uma: string, odds: number) => void;
  onApplyRace: (r: LiveRace) => void;
  onStandard: () => void;
  onRefine: () => void;
}

function RaceScreen(props: RaceScreenProps) {
  const { t, tFmt } = useI18n();
  const {
    runners,
    raceLabel,
    snap,
    snapLoading,
    snapError,
    p,
    overround,
    intuition,
    onReload,
    onSeedManual,
    onAddRunner,
    onSetOdds,
    onApplyRace,
    onStandard,
    onRefine,
  } = props;

  const liveRaces = (snap?.races || []).filter((r) =>
    (r.runners || []).some((x) => (x.win_odds || 0) > 0),
  );
  const taken = overround > 0 ? ((1 - 1 / overround) * 100).toFixed(0) : "-";

  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("race.title")}</h2>
          <small>{t("race.hint")}</small>
        </div>
        <div className="grid-2" style={{ marginBottom: 10 }}>
          <select
            aria-label={t("race.live")}
            value={raceLabel}
            onChange={(e) => {
              const r = liveRaces.find(
                (x) => (x.name || `${t("race.placeholderRace")} ${x.race_no}`) ===
                  e.target.value,
              );
              if (r) onApplyRace(r);
            }}
          >
            {liveRaces.length === 0 ? (
              <option value="">{t("race.noLive")}</option>
            ) : (
              liveRaces.map((r) => (
                <option
                  key={r.race_no}
                  value={r.name || `${t("race.placeholderRace")} ${r.race_no}`}
                >
                  R{r.race_no} · {r.name || `Race ${r.race_no}`}
                </option>
              ))
            )}
          </select>
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
        <p className="hint">
          {overround > 0 &&
            tFmt("race.overroundMsg", {
              taken,
              sum: overround.toFixed(3),
            })}
        </p>
      </section>

      <section className="section">
        <div className="section-title">
          <h2>{t("race.runners")}</h2>
          <button className="btn ghost" onClick={onAddRunner}>
            + {t("race.addRunner")}
          </button>
        </div>
        {runners.length === 0 ? (
          <p className="empty">{t("tickets.noRunners")}</p>
        ) : (
          <div className="runners">
            {runners.map((r) => {
              const pc = p[r.uma] ? (p[r.uma]! * 100).toFixed(1) + "%" : "-";
              const tag = intuition[r.uma];
              return (
                <div
                  key={r.uma}
                  className={`runner ${tag ? "has-intuition" : ""}`}
                >
                  <span className="uma">{r.uma}</span>
                  <span>
                    <span className="nm">{r.name || `#${r.uma}`}</span>
                    <span className="odds-line">
                      <input
                        type="number"
                        value={r.odds}
                        min={1}
                        step={0.1}
                        onChange={(e) =>
                          onSetOdds(r.uma, +e.target.value || 0)
                        }
                      />
                      <span className="pc">
                        {t("race.winProb")} {pc}
                      </span>
                    </span>
                    {tag && (
                      <span className={`itag itag--${tag}`}>
                        {t(`intuition.${tag === "priceHorse" ? "priceHorse" : tag}`)}
                      </span>
                    )}
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
  onNext: () => void;
}

function StyleScreen(props: StyleScreenProps) {
  const { t } = useI18n();
  const { style, onChange, onBack, onNext } = props;
  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("style.title")}</h2>
          <small>{t("style.hint")}</small>
        </div>
        <div className="persona-grid">
          {PERSONALITIES.map((id) => (
            <button
              key={id}
              className={`persona ${style.personality === id ? "on" : ""}`}
              onClick={() => onChange({ ...style, personality: id })}
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
      </section>

      <div className="btn-row">
        <button className="btn ghost" onClick={onBack}>
          ← {t("nav.race")}
        </button>
        <button className="btn primary" onClick={onNext}>
          {t("nav.intuition")} →
        </button>
      </div>
    </>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ============================================================================
// Intuition Screen
// ============================================================================
const INTUITION_BUTTONS: { kind: IntuitionState; key: string }[] = [
  { kind: "like", key: "like" },
  { kind: "distrust", key: "distrust" },
  { kind: "priceHorse", key: "priceHorse" },
  { kind: "anchor", key: "anchor" },
  { kind: "avoid", key: "avoid" },
];

interface IntuitionScreenProps {
  runners: Runner[];
  p: Record<string, number>;
  intuition: Record<string, IntuitionState>;
  onChange: (uma: string, v: IntuitionState) => void;
  onBack: () => void;
  onGenerate: () => void;
}

function IntuitionScreen(props: IntuitionScreenProps) {
  const { t } = useI18n();
  const { runners, p, intuition, onChange, onBack, onGenerate } = props;
  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("intuition.title")}</h2>
          <small>{t("intuition.hint")}</small>
        </div>
        {runners.map((r) => {
          const cur = intuition[r.uma] ?? null;
          const pc = p[r.uma] ? (p[r.uma]! * 100).toFixed(1) + "%" : "-";
          return (
            <div
              key={r.uma}
              style={{
                marginBottom: 12,
                paddingBottom: 12,
                borderBottom: "1px solid var(--line)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: 6,
                }}
              >
                <span className="uma" style={{ width: 30, height: 30 }}>
                  {r.uma}
                </span>
                <strong style={{ flex: 1, minWidth: 0 }}>
                  {r.name || `#${r.uma}`}
                </strong>
                <span className="pc">
                  {t("race.winProb")} {pc}
                </span>
              </div>
              <div className="intuition-picker">
                {INTUITION_BUTTONS.map((b) => (
                  <button
                    key={b.kind}
                    className={cur === b.kind ? "on" : ""}
                    onClick={() =>
                      onChange(r.uma, cur === b.kind ? null : b.kind)
                    }
                  >
                    {t(`intuition.${b.key}`)}
                  </button>
                ))}
                {cur && (
                  <button className="clear" onClick={() => onChange(r.uma, null)}>
                    ✕
                  </button>
                )}
              </div>
              {cur && (
                <p className="hint" style={{ marginTop: 6 }}>
                  {t(`intuition.explanation.${cur}`)}
                </p>
              )}
            </div>
          );
        })}
      </section>

      <div className="btn-row">
        <button className="btn ghost" onClick={onBack}>
          ← {t("nav.style")}
        </button>
        <button className="btn primary" onClick={onGenerate}>
          {t("tickets.title")} →
        </button>
      </div>
    </>
  );
}

// ============================================================================
// Tickets Screen
// ============================================================================
interface TicketsScreenProps {
  tickets: Ticket[];
  onRemix: () => void;
  onReset: () => void;
  onBackStyle: () => void;
  onBackIntuition: () => void;
  onExplain: (id: string) => void;
}

function TicketsScreen(props: TicketsScreenProps) {
  const { t, tFmt } = useI18n();
  const { tickets, onRemix, onReset, onBackStyle, onBackIntuition, onExplain } = props;
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
          <button className="btn ghost" onClick={onBackIntuition}>
            ← {t("tickets.backToIntuition")}
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
          const ev = tk.expectedReturn;
          const edgePct = ((ev / Math.max(1, tk.cost) - 1) * 100).toFixed(0);
          return (
            <article
              key={tk.id}
              className={`ticket ${i === 0 ? "top-pick" : ""}`}
            >
              <div className="ticket-head">
                <div>
                  <h3>
                    {i === 0 ? `${t("tickets.topMix")}: ` : ""}
                    {t(`betType.${tk.type}`)}
                  </h3>
                  <p className="tpdesc">
                    {shownLines.length} {t("tickets.lines")} ·{" "}
                    {t(`valueTag.${tk.tag}`)}
                  </p>
                </div>
                <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
                  <span className={`badge ${tk.tag}`}>{t(`valueTag.${tk.tag}`)}</span>
                  <span className={`badge ${tk.variance}`}>
                    {tk.variance === "high"
                      ? t("tickets.variance")
                      : t("tickets.lowVariance")}
                  </span>
                </div>
              </div>
              <div className="metrics">
                <div className="metric">
                  <span>{t("tickets.lines")}</span>
                  <b>{tk.lines.length}</b>
                </div>
                <div className="metric cost-metric">
                  <span>{t("tickets.cost")}</span>
                  <b>{yen(tk.cost)}</b>
                </div>
                <div className="metric">
                  <span>{t("tickets.hitEst")}</span>
                  <b>
                    {(tk.hitProb * 100).toFixed(tk.hitProb < 0.1 ? 1 : 0)}%
                  </b>
                </div>
                <div className="metric">
                  <span>{t("tickets.avgPayout")}</span>
                  <b>{yen(tk.avgPayout)}</b>
                </div>
              </div>
              <div className="ev-line">
                {tFmt("tickets.estReturnLine", {
                  ret: ev.toFixed(0),
                  edge: `${edgePct}%`,
                })}{" "}
                {t("tickets.houseEdgeNote")}
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
        <button className="btn ghost" onClick={onBackIntuition}>
          ← {t("tickets.backToIntuition")}
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
