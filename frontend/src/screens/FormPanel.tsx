// ============================================================================
// Form/Context Panel — Milestone 4 lookup.
//
// Recreational CONTEXT to shape a user's intuition about a runner. NOT a tip,
// edge claim, or betting advice. Copy stays descriptive (career, splits, a
// market-vs-result note, a running-style PROXY). The backend reads pre-built
// PIT-correct marts; the panel only renders what it gets back.
//
// Two exports:
//   - FormPanel       — owns the fetch state, delegates to FormPanelView.
//   - FormPanelView   — PURE presentational. Takes already-loaded cards so it
//                       can be server-rendered in tests without useEffect.
//
// Guardrails (checked by guardrails.test.ts + FormPanel.test.ts):
//   - No "guaranteed / sure thing / lock / beat the market" language.
//   - "anchor" is the user's intuition MARK, never the betting sense of "lock".
//   - The context note "Form context — not betting advice." is always visible.
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

const INTUITION_KINDS: IntuitionKind[] = [
  "like",
  "distrust",
  "priceHorse",
  "avoid",
  "anchor",
];

// ---------------------------------------------------------------------------
// Pure view — rendered by both the fetch-owning wrapper and the tests.
// ---------------------------------------------------------------------------

export interface FormPanelViewProps {
  horseName: string;
  jockeyId?: string | null;
  jockeyName?: string | null;
  loading: boolean;
  err: string;
  /**
   * Reserved for a deliberate feature gate (e.g. an env flag that turns the
   * form panel off in a given deploy). The natural empty state — a known
   * entity with no recorded starts — now renders the no_history copy below,
   * NOT this block. Kept so a future flag can reach it without re-plumbing
   * the view; load() no longer sets it from the both-missing case.
   */
  comingSoon: boolean;
  horse: HorseFormCard | null;
  jockey: JockeyFormCard | null;
  intuition: IntuitionState;
  onIntuition: (next: IntuitionState) => void;
  onClose: () => void;
  onRetry: () => void;
  /**
   * Optional "Back to tickets" affordance in the intuition block — closes the
   * panel AND routes to the Tickets step so the research→tickets return path
   * is explicit. Absent on the test render and when the panel is opened
   * outside the race→tickets loop.
   */
  onReturnToTickets?: () => void;
}

export function FormPanelView(props: FormPanelViewProps) {
  const { t, tFmt, lang } = useI18n();
  const {
    horseName,
    jockeyId,
    jockeyName,
    loading,
    err,
    comingSoon,
    horse,
    jockey,
    intuition,
    onIntuition,
    onClose,
    onRetry,
    onReturnToTickets,
  } = props;

  return (
    <section className="section form-panel" aria-label={t("form.title")}>
      <header className="form-head">
        <div>
          <h2>
            {t("form.title")} · {horseName}
          </h2>
          <small>{t("form.subtitle")}</small>
        </div>
        <button
          className="btn ghost form-close"
          onClick={onClose}
          aria-label={t("form.close")}
        >
          ×
        </button>
      </header>

      {loading && <p className="hint">…</p>}
      {err && (
        <div className="form-error">
          <p className="hint" style={{ color: "var(--warn)" }}>
            {err}
          </p>
          <button className="btn" onClick={onRetry}>
            {t("form.retry")}
          </button>
        </div>
      )}

      {!loading && !err && comingSoon && (
        <div className="form-block form-coming-soon">
          <h3>{t("form.comingSoonTitle")}</h3>
          <p className="hint">{t("form.comingSoonBody")}</p>
        </div>
      )}

      {!loading && !err && !comingSoon && (
        <>
          <HorseContext horse={horse} />
          <JockeyContext
            jockey={jockey}
            jockeyId={jockeyId ?? null}
            jockeyName={jockeyName ?? null}
          />
          <IntuitionMarks
            intuition={intuition}
            onIntuition={onIntuition}
            onReturnToTickets={onReturnToTickets}
          />
        </>
      )}
    </section>
  );

  // --- subcomponents (close over t/tFmt/lang from the parent render scope) ---

  function HorseContext({ horse }: { horse: HorseFormCard | null }) {
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

        <h4>{t("form.splitsTitle")}</h4>
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

  function JockeyContext({
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
            <h4>{t("form.jockeyCombos")}</h4>
            <div className="form-chips">
              {jockey.combos.by_horse.slice(0, 5).map((h, i) => (
                <span key={i} className="combo-chip">
                  {h.horse_name ?? h.horse_name_key ?? "?"} · {h.starts}-{h.wins}
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
// Fetch-owning wrapper used by RaceScreen / ExplainScreen in the live app.
// ---------------------------------------------------------------------------

export interface FormPanelProps {
  horseName: string;
  jockeyId?: string | null;
  jockeyName?: string | null;
  /** Optional PIT anchor (ISO). When absent the backend uses now-UTC. */
  asOf?: string;
  /** Current intuition mark for this horse (null = none). */
  intuition: IntuitionState;
  /** Set or clear the intuition mark. */
  onIntuition: (next: IntuitionState) => void;
  onClose: () => void;
  /** Optional "Back to tickets" affordance (closes panel + routes to tickets). */
  onReturnToTickets?: () => void;
}

export function FormPanel(props: FormPanelProps) {
  const { t } = useI18n();
  const {
    horseName,
    jockeyId,
    jockeyName,
    asOf,
    intuition,
    onIntuition,
    onClose,
    onReturnToTickets,
  } = props;
  const [horse, setHorse] = useState<HorseFormCard | null>(null);
  const [jockey, setJockey] = useState<JockeyFormCard | null>(null);
  const [err, setErr] = useState<string>("");
  const [comingSoon, setComingSoon] = useState(false);
  const [loading, setLoading] = useState(true);

  function load() {
    let cancelled = false;
    setLoading(true);
    setErr("");
    setComingSoon(false);
    setHorse(null);
    setJockey(null);

    // Each attempted fetch resolves to an Outcome:
    //   - ok        → status:"ok" body, render the card
    //   - missing   → status:"no_history" body, the entity genuinely has no
    //                 recorded starts (or no jockey id to look up)
    //   - error     → network/HTTP failure (incl 404 since the routes are now
    //                 wired into the racing Worker); warrants a Retry
    const horseP = toOutcome(fetchHorseForm(horseName, asOf));
    const jockeyP: Promise<FormOutcome<JockeyFormCard | null>> = jockeyId
      ? toOutcome(fetchJockeyForm(jockeyId, asOf))
      : Promise.resolve({ kind: "ok", card: null });

    Promise.all([horseP, jockeyP])
      .then(([h, j]) => {
        if (cancelled) return;
        if (h.kind === "error" || j.kind === "error") {
          setErr(t("form.loadError"));
          return;
        }
        // The both-missing case used to route to the "Coming this weekend"
        // block. It no longer does — the form endpoints are live, so a
        // no_history body is the genuinely-empty state and the view renders
        // the distinct horseNoHistory / jockeyNoHistory copy. `comingSoon`
        // stays reserved for a deliberate future gate (see FormPanelViewProps).
        setHorse(h.kind === "ok" ? h.card : null);
        setJockey(j.kind === "ok" ? j.card : null);
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
  }, [horseName, jockeyId, asOf]);

  return (
    <FormPanelView
      horseName={horseName}
      jockeyId={jockeyId ?? null}
      jockeyName={jockeyName ?? null}
      loading={loading}
      err={err}
      comingSoon={comingSoon}
      horse={horse}
      jockey={jockey}
      intuition={intuition}
      onIntuition={onIntuition}
      onClose={onClose}
      onRetry={load}
      onReturnToTickets={onReturnToTickets}
    />
  );
}

// --- pure helpers -------------------------------------------------------

/**
 * Outcome of a form fetch:
 *   - ok      — status:"ok" body, with the rich card to render
 *   - missing — status:"no_history" body, the entity has no recorded starts
 *   - error   — any fetch failure (network, non-2xx incl 404 since the routes
 *               are wired into the racing Worker now); warrants a Retry
 *
 * Exported so the semantic gate (FormPanel.test.tsx) can pin the three arms
 * without spinning up jsdom: this function is the entire 404-vs-no_history
 * dispatch and the surface area where regressions would hide.
 */
export type FormOutcome<T> =
  | { kind: "ok"; card: T }
  | { kind: "missing" }
  | { kind: "error" };

export function toOutcome<T extends { status: "ok" | "no_history" }>(
  p: Promise<T>,
): Promise<FormOutcome<T>> {
  return p.then(
    (card) =>
      card.status === "no_history"
        ? { kind: "missing" as const }
        : { kind: "ok" as const, card },
    () => ({ kind: "error" as const }),
  );
}

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
  if (!split || !split.starts) return null;
  return (
    <span className="combo-chip">
      {label}: {split.starts}-{split.wins}
    </span>
  );
}
