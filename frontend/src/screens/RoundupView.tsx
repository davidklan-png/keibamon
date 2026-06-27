// ============================================================================
// RoundupView — weekend graded-stakes research report (Reference → Roundup).
//
// Renders a WeeklyReport produced by the deterministic generator
// (lib/weeklyReport.ts). Pure presentational — takes the already-generated
// report. ReferenceScreen owns fetching + edition selection + generation.
//
// Framing: this is RESEARCH, not betting advice. The not-advice reminder is
// always visible; every ticket note carries an explicit Risk line. Copy comes
// from the generator (guardrail-tested) and the i18n dictionary (also
// guardrail-tested). Nothing here instructs a wager.
// ============================================================================
import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type {
  WeeklyReport,
  WeekendInput,
  RaceInput,
  RaceDeepDive,
  ContenderRef,
  TicketNote,
  WatchlistEntry,
  RacePick,
} from "../lib/weeklyReport";
import { effectiveOdds } from "../lib/weeklyReport";
import type { ImpressionMap } from "../lib/impressions";
import { getImpression, impressionsByRace } from "../lib/impressions";
import { normalizeName } from "../lib/normalizeName";
import { winProbs, type Runner } from "../lib/fairvalue";
import { HorseDrillView } from "./HorseDrillView";
import { TicketStudio } from "./TicketStudio";

export interface RoundupViewProps {
  report: WeeklyReport;
  /** ADR-0011 Phase 3b: the source edition (WeekendInput) so the per-race
   * bridge can build Runner[] + de-vigged probs from the real runner field +
   * odds. Optional — when absent, the "build tickets" bridge is omitted (the
   * report still renders; only the structural surface is hidden). */
  edition?: WeekendInput;
  /** ADR-0011 Phase 2: the impression store + setter, threaded through to the
   * contender drill-down. Marks made here share the same spine as the live-card
   * FormPanel — a mark on either surface shows on the other. */
  impressions: ImpressionMap;
  onSetImpressions: (next: ImpressionMap) => void;
  oddsSnapshotAt: string | null;
}

export function RoundupView(props: RoundupViewProps) {
  const { report, edition, impressions, onSetImpressions, oddsSnapshotAt } = props;
  const { t, tFmt } = useI18n();
  // Tiny freshness stamp — "as of HH:MM JST" sourced from the odds snapshot
  // (the producer's capture time), falling back to the publish instant when
  // the odds aren't open yet (e.g. the Friday edition pre-pool). Visible in
  // the subtitle so users can tell at a glance how current the odds are.
  const asOfIso =
    report.freshness.odds_snapshot_at ?? report.freshness.published_at;
  const asOfStamp = asOfIso ? tFmt("roundup.asOf", { time: jstHHMM(asOfIso) }) : null;
  return (
    <section className="section roundup">
      <div className="section-title">
        <h2>
          {t("roundup.title")} · {report.weekend_label}
        </h2>
        <small>
          {report.edition_label}
          {asOfStamp && <> · {asOfStamp}</>}
        </small>
      </div>

      <FreshnessBlock report={report} />

      <div className="roundup-headline">
        <h3>{t("roundup.headline")}</h3>
        <p>{report.weekend_headline}</p>
      </div>

      <GlanceTable report={report} />

      {report.deep_dives.map((d) => (
        <RaceDeepDiveBlock
          key={d.race_id}
          dive={d}
          edition={edition}
          impressions={impressions}
          onSetImpressions={onSetImpressions}
          oddsSnapshotAt={oddsSnapshotAt}
        />
      ))}

      <ThemesBlock themes={report.weekend_themes} />
      <WatchlistBlock entries={report.watchlist} />
      <TicketLensBlock lens={report.ticket_lens} />
    </section>
  );
}

// ---------------------------------------------------------------------------

function tsLabel(value: string | null, fallbackKey: string): string {
  if (!value) return fallbackKey;
  // Show the ISO instant as-is (UTC). Stable + honest about PIT.
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

/**
 * "HH:MM JST" for the tiny freshness stamp. Converts a UTC ISO instant to the
 * JST clock time (UTC+9, no DST). Host-tz-independent — always renders in JST
 * regardless of the viewer's locale, because JRA post times + odds cadence
 * are JST-anchored and readers expect that frame.
 */
function jstHHMM(isoUtc: string | null): string {
  if (!isoUtc) return "";
  const d = new Date(isoUtc);
  if (Number.isNaN(d.getTime())) return "";
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const hh = String(jst.getUTCHours()).padStart(2, "0");
  const mm = String(jst.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} JST`;
}

function FreshnessBlock({ report }: { report: WeeklyReport }) {
  const { t } = useI18n();
  const f = report.freshness;
  const cell = (label: string, v: string | null, pendingKey: string) => (
    <div className={`freshness-cell${v ? "" : " is-pending"}`}>
      <span className="freshness-label">{label}</span>
      <span className="freshness-value">
        {v ? tsLabel(v, pendingKey) : t(pendingKey)}
      </span>
    </div>
  );
  return (
    <div className="freshness">
      <h4>{t("roundup.freshness")}</h4>
      <div className="freshness-grid">
        {cell(t("roundup.publishedAt"), f.published_at, "roundup.pending")}
        {cell(t("roundup.oddsAt"), f.odds_snapshot_at, "roundup.pending")}
        {cell(t("roundup.gateAt"), f.gate_snapshot_at, "roundup.pending")}
        {cell(t("roundup.cardAt"), f.card_snapshot_at, "roundup.pending")}
        {cell(t("roundup.conditionAt"), f.condition_snapshot_at, "roundup.pending")}
      </div>
      <p className="hint freshness-generator">
        {t("roundup.generator")}: {report.generator_version}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function GlanceTable({ report }: { report: WeeklyReport }) {
  const { t } = useI18n();
  return (
    <div className="glance">
      <h3>{t("roundup.glance")}</h3>
      <div className="glance-cards">
        {report.glance.map((g) => (
          <div className="glance-card" key={g.race_id}>
            <div className="glance-card-head">
              <span className={`grade-chip grade-${g.grade}`}>{g.grade}</span>
              <span className="glance-name">{g.name}</span>
            </div>
            <dl>
              <dt>{t("roundup.field")}</dt>
              <dd>{g.field_size}</dd>
              <dt>{t("roundup.postTime")}</dt>
              <dd>{g.post_time}</dd>
              <dt>{t("roundup.favorites")}</dt>
              <dd>{g.top_favorites.join(" · ") || "—"}</dd>
              <dt>{t("roundup.draws")}</dt>
              <dd>{g.notable_draws}</dd>
              <dt>{t("roundup.going")}</dt>
              <dd>{g.going_watch}</dd>
            </dl>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RaceDeepDiveBlock({
  dive,
  edition,
  impressions,
  onSetImpressions,
  oddsSnapshotAt,
}: {
  dive: RaceDeepDive;
  edition?: WeekendInput;
  impressions: ImpressionMap;
  onSetImpressions: (next: ImpressionMap) => void;
  oddsSnapshotAt: string | null;
}) {
  const { t, tFmt } = useI18n();
  const [open, setOpen] = useState(false);
  // ADR-0011 Phase 3b: TicketStudio modal for the research→tickets bridge.
  const [studioOpen, setStudioOpen] = useState(false);

  // Find the matching RaceInput (runner field + odds) for this deep dive.
  const raceInput: RaceInput | undefined = useMemo(
    () => edition?.races.find((r) => r.race_id === dive.race_id),
    [edition, dive.race_id],
  );

  // Build the Runner[] (uma + odds + gate) + de-vigged probs for the studio.
  // Only builds when a raceInput exists; otherwise the bridge CTA is hidden.
  const studioCtx = useMemo(() => {
    if (!raceInput) return null;
    const runners: Runner[] = raceInput.runners.map((r) => ({
      uma: String(r.horse_number),
      name: r.horse_name,
      odds: effectiveOdds(r) ?? 0,
      gate: r.gate,
    }));
    const { p } = winProbs(runners);
    const allUmas = runners.map((r) => r.uma);
    // Derive the marked set + anchor from the impression store for this race.
    // Same logic as RaceScreen: normalizeName(horse_name) → horse_key → mark.
    const byHorseKey = impressionsByRace(impressions, dive.race_id);
    const markedSet: string[] = [];
    let anchorUma: string | null = null;
    for (const r of raceInput.runners) {
      const hk = normalizeName(r.horse_name);
      if (!hk) continue;
      const imp = byHorseKey[hk];
      if (!imp) continue;
      if (
        imp.mark === "anchor" ||
        imp.mark === "like" ||
        imp.mark === "priceHorse"
      ) {
        markedSet.push(String(r.horse_number));
        if (imp.mark === "anchor") anchorUma = String(r.horse_number);
      }
    }
    const hasMarket = runners.some((r) => r.odds > 0);
    return { runners, p, allUmas, markedSet, anchorUma, hasMarket };
  }, [raceInput, impressions, dive.race_id]);

  // Bridge CTA shows only when ≥2 include marks + a market exists.
  const bridgeReady =
    studioCtx !== null &&
    studioCtx.markedSet.length >= 2 &&
    studioCtx.hasMarket;

  return (
    <div className="deepdive">
      <button
        className="deepdive-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`grade-chip grade-${dive.grade}`}>{dive.grade}</span>
        <span className="deepdive-name">
          {dive.name}
          {dive.name_ja ? <span className="ja"> / {dive.name_ja}</span> : null}
        </span>
        <span className="deepdive-caret">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="deepdive-body">
          <SnapshotLine dive={dive} />

          <DeepLine heading={t("roundup.why")}>{dive.why_this_race_matters}</DeepLine>
          <DeepLine heading={t("roundup.market")}>{dive.market_shape}</DeepLine>
          <DeepLine heading={t("roundup.gateImpact")}>{dive.gate_draw_impact}</DeepLine>
          <DeepLine heading={t("roundup.pace")}>{dive.pace_map}</DeepLine>

          <ContenderGroupsBlock
            groups={dive.contender_groups}
            raceId={dive.race_id}
            impressions={impressions}
            onSetImpressions={onSetImpressions}
            oddsSnapshotAt={oddsSnapshotAt}
          />

          {/* ADR-0011 Phase 3b: research→tickets bridge. Builds the structural
              surface (SetFamilyView + FormationView + WheelView + FillGuide)
              from the user's reads on this race. Shown only when ≥2 include
              marks + a market exist; the CTA is the user's selection, not an
              app-chosen axis (guardrail). */}
          {bridgeReady && (
            <button
              className="btn gold"
              style={{ width: "100%", marginTop: 8 }}
              onClick={() => setStudioOpen(true)}
            >
              {tFmt("roundup.buildTickets", { n: studioCtx!.markedSet.length })}
            </button>
          )}

          <div className="deep-line">
            <h5>{t("roundup.trend")}</h5>
            <ul>
              {dive.trend_analysis.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>

          <TicketNotesBlock notes={dive.ticket_notes} />
        </div>
      )}

      {studioOpen && bridgeReady && studioCtx && (
        <TicketStudio
          markedSet={studioCtx.markedSet}
          anchorUma={studioCtx.anchorUma}
          runners={studioCtx.runners}
          p={studioCtx.p}
          allUmas={studioCtx.allUmas}
          unitStake={100}
          title={tFmt("roundup.buildTickets", { n: studioCtx.markedSet.length })}
          onClose={() => setStudioOpen(false)}
        />
      )}
    </div>
  );
}

function SnapshotLine({ dive }: { dive: RaceDeepDive }) {
  const { t } = useI18n();
  const s = dive.snapshot;
  const bits = [
    `${s.distance_m} m`,
    s.surface,
    `${s.field_size} ${t("roundup.field")}`,
    `${t("roundup.postTime")} ${s.post_time}`,
    s.going ? `${t("roundup.going")}: ${s.going}` : null,
    s.weather ? s.weather : null,
    s.has_live_odds ? null : t("roundup.est"),
    s.has_gates ? null : t("roundup.pending"),
  ].filter(Boolean);
  return <p className="deepdive-snapshot">{bits.join(" · ")}</p>;
}

function DeepLine({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="deep-line">
      <h5>{heading}</h5>
      <p>{children}</p>
    </div>
  );
}

function ContenderGroupsBlock({
  groups,
  raceId,
  impressions,
  onSetImpressions,
  oddsSnapshotAt,
}: {
  groups: RaceDeepDive["contender_groups"];
  raceId: string;
  impressions: ImpressionMap;
  onSetImpressions: (next: ImpressionMap) => void;
  oddsSnapshotAt: string | null;
}) {
  const { t } = useI18n();
  // Per-race expand state (mirrors RaceScreen's openUma pattern). Only one
  // contender drill is open at a time per race. null = all collapsed; the
  // mount IS the lazy-fetch gate (collapsed rows never fetch form data).
  const [openUma, setOpenUma] = useState<number | null>(null);

  const block = (label: string, refs: ContenderRef[]) => (
    <div className="contender-group" key={label}>
      <h6>{label}</h6>
      {refs.length === 0 ? (
        <p className="hint">—</p>
      ) : (
        <ul>
          {refs.map((r) => {
            const isOpen = openUma === r.horse_number;
            const mark = getImpression(impressions, raceId, r.horse_name)?.mark;
            return (
              <li key={r.horse_number} className={`contender-row ${isOpen ? "on" : ""}`}>
                <button
                  type="button"
                  className="contender-toggle"
                  aria-expanded={isOpen}
                  onClick={() => setOpenUma(isOpen ? null : r.horse_number)}
                >
                  {mark && (
                    <span className="combo-chip intuition-mark on contender-mark-chip">
                      {t(`form.intuition.${mark}`)}
                    </span>
                  )}
                  <span className="contender-name">
                    No.{r.horse_number} {r.horse_name}
                  </span>
                  {r.win_odds != null && (
                    <span className="contender-odds">~{r.win_odds.toFixed(1)}</span>
                  )}
                  <span className="contender-caret">{isOpen ? "▾" : "▸"}</span>
                </button>
                <span className="contender-reason">{r.reason}</span>
                {/* Mount = lazy fetch gate. Collapsed rows never fetch; the
                    HorseDrillView's useEffect owns the form fetch on mount. */}
                {isOpen && (
                  <div className="contender-drill">
                    <HorseDrillView
                      raceId={raceId}
                      horse={{
                        umaban: r.horse_number,
                        name: r.horse_name,
                      }}
                      currentOdds={r.win_odds}
                      impressions={impressions}
                      onSetImpressions={onSetImpressions}
                      oddsSnapshotAt={oddsSnapshotAt}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
  return (
    <div className="contender-groups">
      <h5>{t("roundup.contenders")}</h5>
      <div className="contender-grid">
        {block(t("roundup.core"), groups.core_contenders)}
        {block(t("roundup.price"), groups.price_horses)}
        {block(t("roundup.fragile"), groups.fragile_favorites)}
        {block(t("roundup.chaos"), groups.chaos_slots)}
      </div>
    </div>
  );
}

function TicketNotesBlock({
  notes,
}: {
  notes: { safeish: TicketNote; balanced: TicketNote; spicy: TicketNote };
}) {
  const { t } = useI18n();
  const card = (label: string, note: TicketNote) => (
    <div className="ticket-note" key={label}>
      <h6>{label}</h6>
      <p className="ticket-shape">{note.shape}</p>
      <p className="ticket-cost">
        <span>{t("roundup.cost")}:</span> {note.cost_window}
      </p>
      <p className="ticket-rationale">
        <span>{t("roundup.rationale")}:</span> {note.rationale}
      </p>
      <p className="ticket-risk">
        <span>{t("roundup.risk")}:</span> {note.risk}
      </p>
    </div>
  );
  return (
    <div className="ticket-notes">
      <h5>{t("roundup.tickets")}</h5>
      <div className="ticket-grid">
        {card(t("roundup.safeish"), notes.safeish)}
        {card(t("roundup.balanced"), notes.balanced)}
        {card(t("roundup.spicy"), notes.spicy)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ThemesBlock({ themes }: { themes: string[] }) {
  const { t } = useI18n();
  return (
    <div className="roundup-themes">
      <h3>{t("roundup.themes")}</h3>
      <ul>
        {themes.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function WatchlistBlock({ entries }: { entries: WatchlistEntry[] }) {
  const { t } = useI18n();
  if (entries.length === 0) return null;
  return (
    <div className="roundup-watchlist">
      <h3>{t("roundup.watchlist")}</h3>
      <ul>
        {entries.map((w, i) => (
          <li key={i}>
            <span className={`signal signal-${w.signal}`}>
              {t(`roundup.signal.${w.signal}`)}
            </span>
            <span className="watchlist-name">
              {w.horse_name} <small>· {w.race_name}</small>
            </span>
            <span className="watchlist-note">{w.note}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TicketLensBlock({ lens }: { lens: WeeklyReport["ticket_lens"] }) {
  const { t } = useI18n();
  const card = (label: string, pick: RacePick | null) => {
    if (!pick) return null;
    return (
      <div className="lens-card" key={label}>
        <h6>{label}</h6>
        <p className="lens-race">
          <span className={`grade-chip grade-${pick.grade}`}>{pick.grade}</span>{" "}
          {pick.name}
        </p>
        <p className="lens-reason">{pick.reason}</p>
      </div>
    );
  };
  return (
    <div className="roundup-lens">
      <h3>{t("roundup.lens")}</h3>
      <div className="lens-grid">
        {card(t("roundup.lensSafeish"), lens.best_for_safeish)}
        {card(t("roundup.lensBalanced"), lens.best_for_balanced)}
        {card(t("roundup.lensLongshot"), lens.best_for_longshot)}
        {card(t("roundup.lensFragile"), lens.most_fragile_favorite)}
        {card(t("roundup.lensSimplify"), lens.best_to_simplify)}
      </div>
    </div>
  );
}
