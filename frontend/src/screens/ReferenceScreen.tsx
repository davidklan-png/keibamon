// ============================================================================
// ReferenceScreen — top-level Reference surface (ADR-style full-screen view).
//
// Two tabs: Glossary (bilingual reference) + Weekend roundup (deterministic
// graded-stakes research report). The report is generated client-side from a
// WeekendInput; that input comes from /api/weekly-report when a published
// edition exists in D1, otherwise from the bundled SAMPLE_ARCHIVE. Either way
// generation is deterministic and testable.
//
// Framing: research only, never betting advice. The not-advice reminder is
// always visible (footer + roundup reminder line).
// ============================================================================
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { fetchWeeklyReport, type WeeklyReportResponse } from "../api";
import {
  generateReport,
  type WeekendInput,
  type WeeklyReport,
} from "../lib/weeklyReport";
import { SAMPLE_ARCHIVE } from "../data/sampleWeekend";
import { GlossaryView } from "./GlossaryView";
import { RoundupView } from "./RoundupView";
import { Footer } from "../components/Footer";

type Tab = "glossary" | "roundup";

function isWeekendInputArray(x: unknown): x is WeekendInput[] {
  if (!Array.isArray(x)) return false;
  return x.every(
    (r) =>
      r && typeof r === "object" && "edition_key" in r && "races" in r && "published_at" in r,
  );
}

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
// Roundup tab — owns the worker fetch + edition selection + generation.
// ---------------------------------------------------------------------------

function RoundupTab() {
  const { t } = useI18n();
  const [resp, setResp] = useState<WeeklyReportResponse>({ status: "sample" });
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

  // Resolve the available editions. Prefer published D1 inputs; otherwise the
  // bundled sample archive. Guard against a malformed published payload.
  const inputs: WeekendInput[] = useMemo(() => {
    if (resp.status === "published" && isWeekendInputArray(resp.inputs)) {
      return resp.inputs;
    }
    return SAMPLE_ARCHIVE;
  }, [resp]);

  const isSample =
    resp.status !== "published" ||
    !isWeekendInputArray(resp.inputs);

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
  if (!report || ordered.length === 0) {
    return <p className="hint">{t("roundup.notYet")}</p>;
  }

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
                {w.edition_label ?? w.edition_key} · v{w.version} · {w.weekend_label}
              </option>
            ))}
          </select>
        </label>
        {isSample && (
          <span className="sample-pill" title={t("reference.sampleNote")}>
            {t("reference.sampleBadge")}
          </span>
        )}
      </div>
      {isSample && <p className="hint">{t("reference.sampleNote")}</p>}

      <RoundupView report={report} />
    </section>
  );
}
