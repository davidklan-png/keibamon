// ============================================================================
// ReferenceScreen — top-level Reference surface (ADR-style full-screen view).
//
// Two tabs: Glossary (bilingual reference) + Weekend roundup (deterministic
// graded-stakes research report). When /api/weekly-report has a published
// edition in D1, the report is generated client-side from that WeekendInput
// (deterministic + testable). When no edition is published yet, the tab shows
// an honest empty state: a cadence message + the real upcoming graded stakes
// pulled from /api/live — never fabricated sample data.
//
// Framing: research only, never betting advice. The not-advice reminder is
// always visible (footer + roundup reminder line).
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import {
  fetchLiveSnapshot,
  fetchWeeklyReport,
  type LiveRace,
  type WeeklyReportResponse,
} from "../api";
import {
  generateReport,
  type WeekendInput,
  type WeeklyReport,
} from "../lib/weeklyReport";
import { pickGradedUpcoming } from "../lib/upcoming";
import { GlossaryView } from "./GlossaryView";
import { RoundupView } from "./RoundupView";
import { Footer } from "../components/Footer";

type Tab = "glossary" | "roundup";

export function ReferenceScreen({ onBack }: { onBack: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [tab, setTab] = useState<Tab>("glossary");

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
            {t("reference.title")} <span className="ja">リファレンス</span>
          </h1>
        </div>
        <button
          className="lang-toggle"
          onClick={() => setLang(lang === "ja" ? "en" : "ja")}
          aria-label="toggle language"
        >
          {t("app.langToggle")}
        </button>
        <button
          className="lang-toggle"
          onClick={onBack}
          aria-label={t("reference.back")}
        >
          {t("reference.back")}
        </button>
      </header>

      <nav className="stepper" aria-label="reference tabs">
        <button
          className={tab === "glossary" ? "on" : ""}
          aria-current={tab === "glossary" ? "step" : undefined}
          onClick={() => setTab("glossary")}
        >
          {t("reference.glossary")}
        </button>
        <button
          className={tab === "roundup" ? "on" : ""}
          aria-current={tab === "roundup" ? "step" : undefined}
          onClick={() => setTab("roundup")}
        >
          {t("reference.roundup")}
        </button>
      </nav>

      <p className="reference-subtitle">{t("reference.subtitle")}</p>

      {tab === "glossary" ? <GlossaryView /> : <RoundupTab />}

      <Footer />
    </main>
  );
}

// ---------------------------------------------------------------------------
// Roundup tab — owns the worker fetch + edition selection + generation. When
// no edition is published, renders EmptyRoundup (cadence + real upcoming
// graded stakes from /api/live).
// ---------------------------------------------------------------------------

function RoundupTab() {
  const { t } = useI18n();
  const [resp, setResp] = useState<WeeklyReportResponse>({ status: "empty" });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchWeeklyReport().then((r) => {
      if (!cancelled) {
        setResp(r);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Published D1 inputs, when the worker actually returned a usable edition.
  // A malformed published payload (non-array inputs) degrades to empty.
  const inputs: WeekendInput[] = useMemo(() => {
    if (resp.status === "published" && Array.isArray(resp.inputs)) {
      return resp.inputs as WeekendInput[];
    }
    return [];
  }, [resp]);

  const isPublished = inputs.length > 0;

  // Latest edition first (highest version), default the selector there.
  const ordered = useMemo(
    () => [...inputs].sort((a, b) => b.version - a.version),
    [inputs],
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const idx = Math.min(selectedIdx, ordered.length - 1);
  const current = ordered[idx];

  const report: WeeklyReport | null = useMemo(
    () => (current ? generateReport(current) : null),
    [current],
  );

  if (!loaded) {
    return <p className="hint">{t("roundup.notYet")}…</p>;
  }

  if (isPublished && report) {
    return (
      <section className="section roundup-tab">
        <div className="roundup-controls">
          <label className="edition-select">
            <span>{t("roundup.edition")}</span>
            <select
              value={idx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
            >
              {ordered.map((w, i) => (
                <option key={`${w.edition_key}-v${w.version}`} value={i}>
                  {w.edition_label ?? w.edition_key} · {w.weekend_label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <RoundupView report={report} />
      </section>
    );
  }

  // No published edition → honest empty state (cadence + upcoming races).
  return <EmptyRoundup />;
}

// ---------------------------------------------------------------------------
// EmptyRoundup — shown when no roundup edition is published. Renders the
// cadence message always, plus the real upcoming graded stakes from /api/live
// when that snapshot loads. A failed /api/live fetch degrades to cadence-only
// (no fabricated content, no inaccurate "none registered" message).
// ---------------------------------------------------------------------------

type LiveState =
  | { kind: "loading" }
  | { kind: "ok"; races: LiveRace[] }
  | { kind: "failed" };

function EmptyRoundup() {
  const { t, tFmt, lang } = useI18n();
  const [live, setLive] = useState<LiveState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchLiveSnapshot()
      .then((snap) => {
        if (!cancelled) setLive({ kind: "ok", races: snap.races ?? [] });
      })
      .catch(() => {
        if (!cancelled) setLive({ kind: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const upcoming = useMemo(
    () => (live.kind === "ok" ? pickGradedUpcoming(live.races, new Date()) : []),
    [live],
  );

  function dateLabel(date: string): string {
    if (!date) return "";
    const normalized = /^\d{8}$/.test(date)
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
      : date;
    const parsed = new Date(`${normalized}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return date;
    return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
      month: "short",
      day: "numeric",
      weekday: "short",
    }).format(parsed);
  }

  return (
    <section className="section roundup-tab roundup-empty">
      <h3>{t("roundup.emptyTitle")}</h3>
      <p className="hint">{t("roundup.emptyCadence")}</p>

      {live.kind === "loading" && (
        <p className="hint">{t("roundup.notYet")}…</p>
      )}

      {live.kind === "ok" && (
        <>
          <h4>{t("roundup.upcoming")}</h4>
          {upcoming.length === 0 ? (
            <p className="hint">{t("roundup.noUpcoming")}</p>
          ) : (
            <ul className="roundup-upcoming">
              {upcoming.map((r) => {
                const grade = (r.grade_label || "").toUpperCase();
                const runnerCount = r.runners?.length || 0;
                return (
                  <li
                    key={`${r.race_id ?? r.date ?? ""}-${r.race_no}`}
                    className="roundup-upcoming-row"
                  >
                    <span className={`grade-chip grade-${grade}`}>{grade}</span>
                    <span className="roundup-upcoming-name">
                      {r.name || `R${r.race_no}`}
                    </span>
                    <span className="roundup-upcoming-meta">
                      {r.venue && <>{r.venue} · </>}
                      {r.date && <>{dateLabel(r.date)}</>}
                      {r.post_time && <> · {r.post_time}</>}
                    </span>
                    {runnerCount > 0 ? (
                      <span className="roundup-upcoming-meta">
                        {tFmt("race.runnersCount", { count: runnerCount })}
                      </span>
                    ) : (
                      <span className="entries-pending-chip">
                        {t("race.entriesPending")}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
