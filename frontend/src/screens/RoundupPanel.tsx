// ============================================================================
// RoundupPanel — the weekend roundup, extracted from ReferenceScreen for
// Session 3b (ADR-0015). The two-lane funnel converges on the Races
// destination: the Research lane now renders THIS panel inline in the browse
// shell, sharing the App header + bottom tab bar + impression spine with the
// live-card builder.
//
// Owns the data work (was RoundupTab inside ReferenceScreen): fetch the
// published WeekendInput editions from /api/weekly-report, edition-select,
// deterministically generate the WeeklyReport, and render <RoundupView> for a
// published edition or <EmptyRoundup> when none is out yet.
//
// Pure-presentational w.r.t. shell: takes the impression store + setter (so
// marks made in the roundup drill-down land on the same spine as marks made on
// the live card) and returns <section>s. NO <main>, NO header, NO Footer — the
// caller's shell provides those.
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
  resolveEditionLabel,
  resolveWeekendLabel,
  type WeekendInput,
  type WeeklyReport,
} from "../lib/weeklyReport";
import { pickGradedUpcoming } from "../lib/upcoming";
import type { ImpressionMap } from "../lib/impressions";
import { RoundupView } from "./RoundupView";

export interface RoundupPanelProps {
  /** ADR-0011 Phase 2: the impression store + setter, threaded through to the
   * Roundup contender drill-down so marks made there share the same spine as
   * marks made on the live-card FormPanel. */
  impressions: ImpressionMap;
  onSetImpressions: (next: ImpressionMap) => void;
  oddsSnapshotAt: string | null;
}

export function RoundupPanel({
  impressions,
  onSetImpressions,
  oddsSnapshotAt,
}: RoundupPanelProps) {
  const { t, lang } = useI18n();
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

  // ADR-0020: generation is locale-aware. `lang` is a memo dependency so a
  // language toggle re-renders the already-loaded report in the new locale
  // immediately — no refetch, no page reload.
  const report: WeeklyReport | null = useMemo(
    () => (current ? generateReport(current, { locale: lang }) : null),
    [current, lang],
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
                  {(w.edition_label != null
                    ? resolveEditionLabel(w, lang)
                    : w.edition_key)}{" "}
                  · {resolveWeekendLabel(w, lang)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <RoundupView
          report={report}
          edition={current}
          impressions={impressions}
          onSetImpressions={onSetImpressions}
          oddsSnapshotAt={oddsSnapshotAt}
        />
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
