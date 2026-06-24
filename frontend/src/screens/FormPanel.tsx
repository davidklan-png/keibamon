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
  horse: HorseFormCard | null;
  jockey: JockeyFormCard | null;
  intuition: IntuitionState;
  onIntuition: (next: IntuitionState) => void;
  onClose: () => void;
  onRetry: () => void;
}

export function FormPanelView(props: FormPanelViewProps) {
  const { t, tFmt, lang } = useI18n();
  const {
    horseName,
    jockeyId,
    jockeyName,
    loading,
    err,
    horse,
    jockey,
    intuition,
    onIntuition,
    onClose,
    onRetry,
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

      <p className="form-context-note">{t("form.contextNote")}</p>

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

      {!loading && !err && (
        <>
          <HorseContext horse={horse} />
          <JockeyContext
            jockey={jockey}
            jockeyId={jockeyId ?? null}
            jockeyName={jockeyName ?? null}
          />
          <IntuitionMarks intuition={intuition} onIntuition={onIntuition} />
          <p className="hint form-takeout">{t("form.takeoutReminder")}</p>
        </>
      )}
    </section>
  );

  // --- subcomponents (close over t/tFmt/lang from the parent render scope) ---

  function HorseContext({ horse }: { horse: HorseFormCard | null }) {
    if (!horse || horse.status !== "ok" || !horse.career) {
      return <p className="empty">{t("form.noHistory")}</p>;
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
          <p className="empty">{t("form.noHistory")}</p>
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
  }: {
    intuition: IntuitionState;
    onIntuition: (next: IntuitionState) => void;
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
}

export function FormPanel(props: FormPanelProps) {
  const { t } = useI18n();
  const { horseName, jockeyId, jockeyName, asOf, intuition, onIntuition, onClose } = props;
  const [horse, setHorse] = useState<HorseFormCard | null>(null);
  const [jockey, setJockey] = useState<JockeyFormCard | null>(null);
  const [err, setErr] = useState<string>("");
  const [loading, setLoading] = useState(true);

  function load() {
    let cancelled = false;
    setLoading(true);
    setErr("");
    setHorse(null);
    setJockey(null);
    const horseP = fetchHorseForm(horseName, asOf).catch(() => null);
    const jockeyP = jockeyId
      ? fetchJockeyForm(jockeyId, asOf).catch(() => null)
      : Promise.resolve<JockeyFormCard | null>(null);
    Promise.all([horseP, jockeyP])
      .then(([h, j]) => {
        if (cancelled) return;
        if (!h && !j) setErr(t("form.loadError"));
        setHorse(h);
        setJockey(j);
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
      horse={horse}
      jockey={jockey}
      intuition={intuition}
      onIntuition={onIntuition}
      onClose={onClose}
      onRetry={load}
    />
  );
}

// --- pure helpers -------------------------------------------------------

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
