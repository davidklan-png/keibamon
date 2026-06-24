// ============================================================================
// Race Screen — extracted from App.tsx (ADR-0007 Phase 5).
// Behavior-preserving move; no logic changes. Lists the live card, lets the
// user pick a race, seeds runners, and offers standard/refine CTAs.
// ============================================================================
import { useState } from "react";
import { useI18n } from "../i18n";
import type { Runner } from "../lib/fairvalue";
import type { IntuitionState } from "../lib/types";
import type { LiveSnapshot, LiveRace } from "../api";
import { raceHasLiveOdds } from "../lib/mytickets-view";
import { fmt } from "../lib/format";
import { FormPanel } from "./FormPanel";

export interface RaceScreenProps {
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
  /** Per-uma intuition marks (Milestone 4 form panel). */
  intuition: Record<string, IntuitionState>;
  /** Set or clear an intuition mark from the form panel. */
  onIntuition: (uma: string, next: IntuitionState) => void;
}

export function RaceScreen(props: RaceScreenProps) {
  const { t, tFmt, lang } = useI18n();
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
    intuition,
    onIntuition,
  } = props;

  // Milestone 4: which runner's form panel is open. null = closed.
  const [openUma, setOpenUma] = useState<string | null>(null);
  const openRunner = openUma ? runners.find((r) => r.uma === openUma) ?? null : null;

  // ADR-0006: list every registered race, not just ones with live odds.
  const cardRaces = (snap?.races || []).filter(
    (r) => (r.runners || []).length > 0,
  );
  const fallbackDate = snap?.meta?.date ?? "";
  const dateFor = (race: LiveRace) => race.date ?? fallbackDate;
  const keyFor = (race: LiveRace) =>
    `${dateFor(race)}|${race.venue ?? ""}|${race.race_no}|${race.name ?? ""}`;
  const dateOptions = Array.from(new Set(cardRaces.map(dateFor)));
  const activeDate = dateOptions.includes(selectedRaceDate)
    ? selectedRaceDate
    : dateOptions[0] || "";
  const racesForDate = cardRaces.filter((r) => dateFor(r) === activeDate);
  const activeRaceKey = racesForDate.some((r) => keyFor(r) === selectedRaceKey)
    ? selectedRaceKey
    : racesForDate.length > 0
      ? keyFor(racesForDate[0])
      : "";
  const popularRaces = [...racesForDate]
    .sort((a, b) => popularScore(b) - popularScore(a))
    .slice(0, Math.min(4, racesForDate.length));
  const racesByVenue = racesForDate.reduce<Map<string, LiveRace[]>>((acc, r) => {
    const venue = r.venue || "-";
    const list = acc.get(venue) || [];
    list.push(r);
    acc.set(venue, list);
    return acc;
  }, new Map());
  const pending = raceStatus === "registered";

  function dateLabel(date: string): string {
    if (!date) return t("race.raceDay");
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

  function statusLabel(race: LiveRace): string {
    const status = race.status ?? (raceHasLiveOdds(race) ? "open" : "registered");
    if (status === "result") return t("race.statusResult");
    if (status === "open") return t("race.statusOpen");
    return t("race.statusRegistered");
  }

  function popularScore(race: LiveRace): number {
    const name = race.name || "";
    const grade = (race.grade_label || "").toUpperCase();
    const gradeLike =
      /(g1|g2|g3|gⅠ|gⅡ|gⅢ|gi|gii|giii|ＧⅠ|ＧⅡ|ＧⅢ|重賞|ステークス|カップ|杯|賞|記念|derby|oaks|cup|stakes|kinen|sho|hai|takarazuka|arima|yasuda|tenno|japan cup)/i.test(
        name,
      );
    return (
      (grade === "G1" ? 300 : grade === "G2" ? 240 : grade === "G3" ? 220 : 0) +
      (gradeLike ? 100 : 0) +
      (race.race_no >= 10 ? 30 : 0) +
      (raceHasLiveOdds(race) ? 10 : 0) +
      Math.min(race.race_no, 12)
    );
  }

  function raceTitle(race: LiveRace): string {
    return race.name || `Race ${race.race_no}`;
  }

  function RaceMeta({ race }: { race: LiveRace }) {
    return (
      <span className="race-meta">
        {race.venue || "-"} · R{race.race_no} ·{" "}
        {tFmt("race.runnersCount", { count: race.runners?.length || 0 })}
      </span>
    );
  }

  return (
    <>
      <section className="section">
        <div className="section-title">
          <h2>{t("race.title")}</h2>
          <small>{t("race.hint")}</small>
        </div>
        {cardRaces.length > 0 ? (
          <div className="race-selector">
            <div className="selector-block">
              <div className="selector-label">{t("race.date")}</div>
              <div className="date-chips" role="listbox" aria-label={t("race.date")}>
                {dateOptions.map((date) => {
                  const firstForDate = [...cardRaces]
                    .filter((r) => dateFor(r) === date)
                    .sort((a, b) => popularScore(b) - popularScore(a))[0];
                  return (
                    <button
                      key={date || "race-day"}
                      className={`date-chip ${activeDate === date ? "on" : ""}`}
                      onClick={() => {
                        if (firstForDate) onApplyRace(firstForDate, fallbackDate);
                      }}
                      role="option"
                      aria-selected={activeDate === date}
                    >
                      {dateLabel(date)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="selector-block">
              <div className="selector-label">{t("race.popular")}</div>
              <div className="popular-races">
                {popularRaces.map((r) => {
                  const selected = keyFor(r) === activeRaceKey;
                  return (
                    <button
                      key={keyFor(r)}
                      className={`race-card ${selected ? "on" : ""}`}
                      onClick={() => onApplyRace(r, fallbackDate)}
                    >
                      <span className="race-card-top">
                        <span>R{r.race_no}</span>
                        <span>{statusLabel(r)}</span>
                      </span>
                      <strong>{raceTitle(r)}</strong>
                      <RaceMeta race={r} />
                    </button>
                  );
                })}
              </div>
            </div>

            <details className="all-races">
              <summary>{t("race.allRaces")}</summary>
              <div className="venue-groups">
                {Array.from(racesByVenue.entries()).map(([venue, races]) => (
                  <div className="venue-group" key={venue}>
                    <div className="venue-name">{venue}</div>
                    <div className="race-list">
                      {[...races]
                        .sort((a, b) => a.race_no - b.race_no)
                        .map((r) => (
                          <button
                            key={keyFor(r)}
                            className={`race-row ${keyFor(r) === activeRaceKey ? "on" : ""}`}
                            onClick={() => onApplyRace(r, fallbackDate)}
                          >
                            <span className="race-row-no">R{r.race_no}</span>
                            <span className="race-row-name">{raceTitle(r)}</span>
                            <span className="race-row-status">{statusLabel(r)}</span>
                          </button>
                        ))}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          </div>
        ) : (
          <p className="empty live-empty">{t("race.noLive")}</p>
        )}
        <div className="grid-2 race-actions">
          <div className="selected-race">
            <span>{t("race.selected")}</span>
            <strong>{raceLabel}</strong>
          </div>
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
            {t("race.liveUnavailable")}
          </p>
        )}
      </section>

      {pending && (
        <p className="pending-banner">{t("race.pendingBanner")}</p>
      )}

      <section className={`section ${pending ? "is-pending" : ""}`}>
        <div className="section-title">
          <h2>{t("race.runners")}</h2>
          <small>
            {t("race.oddsLabel")}
            {runners.length > 0 && ` · ${t("form.tapHint")}`}
          </small>
        </div>
        {runners.length === 0 ? (
          <p className="empty">{t("tickets.noRunners")}</p>
        ) : (
          <>
            {openRunner && (
              <FormPanel
                horseName={openRunner.name || `#${openRunner.uma}`}
                jockeyId={openRunner.jockey_id ?? null}
                jockeyName={openRunner.jockey_name ?? null}
                intuition={intuition[openRunner.uma] ?? null}
                onIntuition={(next) => onIntuition(openRunner.uma, next)}
                onClose={() => setOpenUma(null)}
              />
            )}
            <div className="runners">
              {runners.map((r) => {
                const isOpen = openUma === r.uma;
                return (
                  <button
                    key={r.uma}
                    type="button"
                    className={`runner runner-tappable ${isOpen ? "on" : ""}`}
                    onClick={() => setOpenUma(isOpen ? null : r.uma)}
                    aria-pressed={isOpen}
                  >
                    <span className="uma">{r.uma}</span>
                    <span>
                      <span className="nm">{r.name || `#${r.uma}`}</span>
                      <span className="odds-line">
                        <span className="odds-value">{fmt(r.odds, 1)}</span>
                        {pending && <span className="pc">{t("race.estOdds")}</span>}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
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
