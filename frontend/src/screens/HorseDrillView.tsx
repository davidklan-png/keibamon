// ============================================================================
// HorseDrillView — the shared horse drill-down primitive (ADR-0011 Phase 2).
//
// The same horse form/context view + the same mark vocabulary is reachable from
// (a) the live-card RaceScreen modal (via FormPanel), (b) the Roundup contender
// list (inline), and (c) any future embed. Two co-located exports:
//
//   - HorseDrillView  — the self-contained container. Owns the form fetch on
//                       mount (the lazy-fetch-on-expand gate), reads/writes the
//                       impression store directly, renders HorseContent + the
//                       odds-drift chip. Renders NO chrome — the caller decides
//                       framing (modal, inline, etc.).
//
//   - HorseContent    — the presentational inner. Renders the loading / error /
//                       coming-soon / ok states (career block + jockey block +
//                       intuition marks). Used internally by HorseDrillView AND
//                       by FormPanelView (so the FormPanel test seam keeps its
//                       current prop shape + byte-identical output). Calls
//                       useI18n() itself — no closure through the parent.
//
// Recreational CONTEXT to shape a user's intuition about a runner. NOT a tip,
// edge claim, or betting advice. The drift chip is factual (marked-at vs now);
// it never recommends a wager. Copy stays guardrail-clean.
// ============================================================================
import { useEffect, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import { fmt } from "../lib/format";
import {
  fetchHorseForm,
  fetchJockeyForm,
  type FormSplit,
  type HorseFormCard,
  type JockeyFormCard,
} from "../api";
import type { IntuitionKind, IntuitionState } from "../lib/types";
import type { ImpressionMap } from "../lib/impressions";
import { getImpression, setImpression } from "../lib/impressions";
import { toOutcome, type FormOutcome } from "./FormPanel";

const INTUITION_KINDS: IntuitionKind[] = [
  "like",
  "distrust",
  "priceHorse",
  "avoid",
  "anchor",
];

// ---------------------------------------------------------------------------
// HorseContent — presentational inner. Shared by FormPanelView (test seam) and
// HorseDrillView (container). Renders loading/error/coming-soon/ok states. No
// chrome — the caller owns the header + framing.
// ---------------------------------------------------------------------------

export interface HorseContentProps {
  horse: HorseFormCard | null;
  jockey: JockeyFormCard | null;
  jockeyId: string | null;
  jockeyName: string | null;
  /** Current intuition mark for this horse (null = no stored impression). */
  intuition: IntuitionState;
  onIntuition: (next: IntuitionState) => void;
  loading: boolean;
  err: string;
  comingSoon: boolean;
  onRetry: () => void;
  /** Optional "Back to tickets" affordance (closes the drill + routes). */
  onReturnToTickets?: () => void;
}

export function HorseContent(props: HorseContentProps) {
  const { t, tFmt, lang } = useI18n();
  const {
    horse,
    jockey,
    jockeyId,
    jockeyName,
    intuition,
    onIntuition,
    loading,
    err,
    comingSoon,
    onRetry,
    onReturnToTickets,
  } = props;

  if (loading) {
    return <p className="hint">…</p>;
  }

  if (err) {
    return (
      <div className="form-error">
        <p className="hint" style={{ color: "var(--warn)" }}>
          {err}
        </p>
        <button className="btn" onClick={onRetry}>
          {t("form.retry")}
        </button>
      </div>
    );
  }

  if (comingSoon) {
    return (
      <div className="form-block form-coming-soon">
        <h3>{t("form.comingSoonTitle")}</h3>
        <p className="hint">{t("form.comingSoonBody")}</p>
      </div>
    );
  }

  return (
    <>
      <HorseCareerBlock horse={horse} />
      <JockeyBlock jockey={jockey} jockeyId={jockeyId} jockeyName={jockeyName} />
      <IntuitionMarks
        intuition={intuition}
        onIntuition={onIntuition}
        onReturnToTickets={onReturnToTickets}
      />
    </>
  );

  // --- inner blocks (close over t/tFmt/lang from this render scope) ---

  function HorseCareerBlock({ horse }: { horse: HorseFormCard | null }) {
    if (!horse || horse.status !== "ok" || !horse.career) {
      return <p className="empty">{t("form.horseNoHistory")}</p>;
    }
    const c = horse.career;
    return (
      <div className="form-block">
        <h3>{t("form.career")}</h3>
        <p className="form-line">
          {tFmt("form.starts", { n: c.starts })} ·{" "}
          {tFmt("form.record", {
            wins: c.wins,
            top3: c.top3,
            win: fmtPct(c.win_pct),
            top3Pct: fmtPct(c.top3_pct),
          })}
        </p>

        {horse.recent_finishes && horse.recent_finishes.length > 0 && (
          <>
            <h4>{t("form.recentTitle")}</h4>
            <ul className="form-recent">
              {horse.recent_finishes.slice(0, 6).map((f, i) => (
                <li key={i} className="form-recent-row">
                  <span className="fr-date">
                    {fmtDate(f.race_date || f.available_at, lang)}
                  </span>
                  <span className="fr-course">{f.racecourse ?? "-"}</span>
                  <span className="fr-pos">#{f.finish_position ?? "-"}</span>
                  <span className="fr-odds">{fmt(f.win_odds ?? undefined, 1)}x</span>
                  <span className="fr-surf">{f.surface ?? ""}</span>
                  <span className="fr-dist">
                    {f.distance_m ? `${f.distance_m}m` : ""}
                  </span>
                  <span className="fr-style">{f.style_signal ?? ""}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        <h4 className="form-section-head">
          {t("form.splitsTitle")}
          <span className="hint form-section-sub">
            · {t("form.splitsSubtitle")}
          </span>
        </h4>
        <div className="form-chips">{renderSplitChips(horse)}</div>

        {horse.style_profile && Object.keys(horse.style_profile).length > 0 && (
          <>
            <h4>{t("form.styleTitle")}</h4>
            <div className="form-chips">
              {Object.entries(horse.style_profile)
                .sort((a, b) => b[1] - a[1])
                .map(([k, n]) => (
                  <span key={k} className="combo-chip">
                    {k} · {n}
                  </span>
                ))}
            </div>
            <p className="hint">{t("form.styleNote")}</p>
          </>
        )}

        <h4>{t("form.marketTitle")}</h4>
        <p className="form-line">{marketNote(horse)}</p>
      </div>
    );
  }

  function renderSplitChips(horse: HorseFormCard): ReactNode {
    const chips: ReactNode[] = [];
    const surface = horse.by_surface || {};
    for (const [k, s] of Object.entries(surface)) {
      chips.push(
        <SplitChip key={`s-${k}`} label={`${t("form.surface")} ${k}`} split={s} />,
      );
    }
    const dist = horse.by_distance_band || {};
    for (const [k, s] of Object.entries(dist)) {
      chips.push(
        <SplitChip key={`d-${k}`} label={`${t("form.distance")} ${k}`} split={s} />,
      );
    }
    if (horse.by_wet) {
      chips.push(
        <SplitChip key="wet" label={`${t("form.wet")}`} split={horse.by_wet.wet} />,
        <SplitChip key="dry" label={`${t("form.dry")}`} split={horse.by_wet.dry} />,
      );
    }
    return chips;
  }

  function marketNote(horse: HorseFormCard): string {
    const m = horse.market_vs_result;
    if (!m) return t("form.marketNote.neutral");
    if (m.note === "tends to outrun odds" || m.note === "tends to outran odds") {
      return t("form.marketNote.outrun");
    }
    if (m.note === "tends to run to odds") {
      return t("form.marketNote.runsToOdds");
    }
    return t("form.marketNote.neutral");
  }

  function JockeyBlock({
    jockey,
    jockeyId,
    jockeyName,
  }: {
    jockey: JockeyFormCard | null;
    jockeyId: string | null;
    jockeyName: string | null;
  }) {
    if (!jockeyId) {
      return (
        <div className="form-block">
          <h3>{t("form.jockeyTitle")}</h3>
          <p className="hint">{t("form.jockeyNoId")}</p>
        </div>
      );
    }
    if (!jockey || jockey.status !== "ok" || !jockey.career) {
      return (
        <div className="form-block">
          <h3>{t("form.jockeyTitle")}</h3>
          <p className="empty">{t("form.jockeyNoHistory")}</p>
        </div>
      );
    }
    const c = jockey.career;
    return (
      <div className="form-block">
        <h3>
          {t("form.jockeyTitle")}
          {jockeyName ? ` · ${jockeyName}` : ""}
        </h3>
        <p className="form-line">
          {tFmt("form.starts", { n: c.starts })} ·{" "}
          {tFmt("form.record", {
            wins: c.wins,
            top3: c.top3,
            win: fmtPct(c.win_pct),
            top3Pct: fmtPct(c.top3_pct),
          })}
        </p>

        {jockey.combos && jockey.combos.by_horse.length > 0 && (
          <>
            <h4 className="form-section-head">
              {t("form.jockeyCombos")}
              <span className="hint form-section-sub">
                · {t("form.combosSubtitle")}
              </span>
            </h4>
            <div className="form-chips">
              {jockey.combos.by_horse.slice(0, 5).map((h, i) => (
                <span key={i} className="combo-chip">
                  {h.horse_name ?? h.horse_name_key ?? "?"} ·{" "}
                  {tFmt("form.recordChip", {
                    wins: h.wins,
                    starts: h.starts,
                  })}
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  function IntuitionMarks({
    intuition,
    onIntuition,
    onReturnToTickets,
  }: {
    intuition: IntuitionState;
    onIntuition: (next: IntuitionState) => void;
    onReturnToTickets?: () => void;
  }) {
    return (
      <div className="form-block form-intuition">
        <h4>{t("form.intuitionTitle")}</h4>
        <div className="form-chips">
          {INTUITION_KINDS.map((k) => {
            const on = intuition === k;
            return (
              <button
                key={k}
                className={`combo-chip intuition-mark ${on ? "on" : ""}`}
                aria-pressed={on}
                onClick={() => onIntuition(on ? null : k)}
              >
                {t(`form.intuition.${k}`)}
              </button>
            );
          })}
        </div>
        <p className="hint">{t("form.intuitionHint")}</p>
        {onReturnToTickets && (
          <button
            className="btn ghost form-back-tickets"
            onClick={onReturnToTickets}
          >
            ← {t("form.backToTickets")}
          </button>
        )}
      </div>
    );
  }
}

// ---------------------------------------------------------------------------
// HorseDrillView — the self-contained container. Owns the fetch (lazy on
// mount), reads/writes the impression store, renders HorseContent + drift chip.
// No chrome — the caller frames it (modal header, inline border, etc.).
// ---------------------------------------------------------------------------

export interface HorseDrillViewProps {
  raceId: string;
  horse: {
    umaban: number;
    name: string;
    jockeyId?: string | null;
    jockeyName?: string | null;
  };
  /** Live win odds at the caller's "now"; used for the drift chip. */
  currentOdds?: number | null;
  /** Optional PIT anchor (ISO). When absent the backend uses now-UTC. */
  asOf?: string;
  /** The full impression store (App-level state). */
  impressions: ImpressionMap;
  /** App-level setter — HorseDrillView writes marks through this. */
  onSetImpressions: (next: ImpressionMap) => void;
  /** Snapshot heartbeat, stamped into the impression at mark time. */
  oddsSnapshotAt?: string | null;
  /** Optional "Back to tickets" affordance (passed through to HorseContent). */
  onReturnToTickets?: () => void;
}

export function HorseDrillView(props: HorseDrillViewProps) {
  const { t } = useI18n();
  const { raceId, horse, currentOdds, asOf, impressions, onSetImpressions, oddsSnapshotAt, onReturnToTickets } = props;
  const [horseCard, setHorseCard] = useState<HorseFormCard | null>(null);
  const [jockeyCard, setJockeyCard] = useState<JockeyFormCard | null>(null);
  const [err, setErr] = useState<string>("");
  const [comingSoon, setComingSoon] = useState(false);
  const [loading, setLoading] = useState(true);

  function load() {
    let cancelled = false;
    setLoading(true);
    setErr("");
    setComingSoon(false);
    setHorseCard(null);
    setJockeyCard(null);

    // Each attempted fetch resolves to an Outcome (see FormPanel.toOutcome):
    //   - ok        → status:"ok" body, render the card
    //   - missing   → status:"no_history" body, the entity genuinely has no
    //                 recorded starts (or no jockey id to look up)
    //   - error     → network/HTTP failure (incl 404 since the routes are now
    //                 wired into the racing Worker); warrants a Retry
    const horseP = toOutcome(fetchHorseForm(horse.name, asOf));
    const jockeyP: Promise<FormOutcome<JockeyFormCard | null>> = horse.jockeyId
      ? toOutcome(fetchJockeyForm(horse.jockeyId, asOf))
      : Promise.resolve({ kind: "ok", card: null });

    Promise.all([horseP, jockeyP])
      .then(([h, j]) => {
        if (cancelled) return;
        if (h.kind === "error" || j.kind === "error") {
          setErr(t("form.loadError"));
          return;
        }
        // The both-missing case used to route to "Coming this weekend". It no
        // longer does — the form endpoints are live, so a no_history body is
        // the genuinely-empty state. `comingSoon` stays reserved for a future
        // deliberate gate.
        setHorseCard(h.kind === "ok" ? h.card : null);
        setJockeyCard(j.kind === "ok" ? j.card : null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }

  useEffect(() => {
    const cleanup = load();
    return cleanup;
    // Re-fetch only when the entity or PIT anchor changes — NOT on lang flip
    // (data is language-invariant; copy is re-read on every render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [horse.name, horse.jockeyId, asOf]);

  // Read the store directly — the lookup happens inside the primitive.
  const impression = getImpression(impressions, raceId, horse.name);

  return (
    <>
      <HorseContent
        horse={horseCard}
        jockey={jockeyCard}
        jockeyId={horse.jockeyId ?? null}
        jockeyName={horse.jockeyName ?? null}
        intuition={impression?.mark ?? null}
        onIntuition={(next) =>
          onSetImpressions(
            setImpression(impressions, raceId, horse.name, {
              mark: next,
              umaban: horse.umaban,
              odds_when_marked: currentOdds ?? null,
              odds_snapshot_at: oddsSnapshotAt ?? null,
            }),
          )
        }
        loading={loading}
        err={err}
        comingSoon={comingSoon}
        onRetry={load}
        onReturnToTickets={onReturnToTickets}
      />
      <DriftChip
        oddsWhenMarked={impression?.odds_when_marked ?? null}
        currentOdds={currentOdds ?? null}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Drift chip — factual odds-drift indicator. Renders only when the horse has a
// stored impression with odds_when_marked AND a current odds value, AND the two
// differ by more than 0.1. Describes the change; never recommends a wager.
// ---------------------------------------------------------------------------

function DriftChip({
  oddsWhenMarked,
  currentOdds,
}: {
  oddsWhenMarked: number | null;
  currentOdds: number | null;
}) {
  const { t } = useI18n();
  if (oddsWhenMarked == null || currentOdds == null) return null;
  if (Math.abs(currentOdds - oddsWhenMarked) <= 0.1) return null;
  const shorter = currentOdds < oddsWhenMarked;
  const arrow = shorter ? "▲" : "▼";
  const label = shorter ? t("drift.shorter") : t("drift.longer");
  return (
    <p className="drift-chip-line">
      <span className="combo-chip drift-chip" title={label}>
        {t("drift.likedAt")} {oddsWhenMarked.toFixed(1)}× · {t("drift.nowAt")}{" "}
        {currentOdds.toFixed(1)}× {arrow}
      </span>
    </p>
  );
}

// --- pure helpers (moved from FormPanel.tsx) ----------------------------

function fmtPct(p: number | null | undefined): string {
  if (p == null || !isFinite(p)) return "-";
  // win_pct comes in as a 0..1 fraction from the backend.
  return Math.round(p * 100).toString();
}

function fmtDate(s: string | null | undefined, lang: "ja" | "en"): string {
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return String(s);
  return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
  }).format(d);
}

function SplitChip({ label, split }: { label: string; split: FormSplit }) {
  const { tFmt } = useI18n();
  if (!split || !split.starts) return null;
  return (
    <span className="combo-chip">
      {label}:{" "}
      {tFmt("form.recordChip", { wins: split.wins, starts: split.starts })}
    </span>
  );
}
