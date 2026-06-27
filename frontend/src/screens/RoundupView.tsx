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
import { useState } from "react";
import { useI18n } from "../i18n";
import type {
  WeeklyReport,
  RaceDeepDive,
  ContenderRef,
  TicketNote,
  WatchlistEntry,
  RacePick,
} from "../lib/weeklyReport";

export function RoundupView({ report }: { report: WeeklyReport }) {
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
        <RaceDeepDiveBlock key={d.race_id} dive={d} />
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

function RaceDeepDiveBlock({ dive }: { dive: RaceDeepDive }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
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

          <ContenderGroupsBlock groups={dive.contender_groups} />

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
}: {
  groups: RaceDeepDive["contender_groups"];
}) {
  const { t } = useI18n();
  const block = (label: string, refs: ContenderRef[]) => (
    <div className="contender-group" key={label}>
      <h6>{label}</h6>
      {refs.length === 0 ? (
        <p className="hint">—</p>
      ) : (
        <ul>
          {refs.map((r) => (
            <li key={r.horse_number}>
              <span className="contender-name">
                No.{r.horse_number} {r.horse_name}
              </span>
              {r.win_odds != null && (
                <span className="contender-odds">~{r.win_odds.toFixed(1)}</span>
              )}
              <span className="contender-reason">{r.reason}</span>
            </li>
          ))}
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
