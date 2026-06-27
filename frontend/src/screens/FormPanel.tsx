// ============================================================================
// Form/Context Panel — Milestone 4 lookup (ADR-0011 Phase 2 refactor).
//
// Recreational CONTEXT to shape a user's intuition about a runner. NOT a tip,
// edge claim, or betting advice. The horse/jockey/marks body + the fetch
// logic now live in HorseDrillView.tsx (the shared primitive); this file keeps:
//
//   - FormPanelView  — the PURE presentational test seam. Prop shape UNCHANGED
//                      so FormPanel.test.tsx stays green. Renders the modal
//                      chrome (header + close) + delegates the body to
//                      <HorseContent /> (byte-identical output).
//   - FormPanel      — the fetch-owning wrapper used by RaceScreen /
//                      ExplainScreen. New prop shape (ADR-0011 Phase 2):
//                      takes the impression STORE + the runner's current odds
//                      and renders modal chrome + <HorseDrillView />.
//   - toOutcome      — the 404-vs-no_history dispatch, kept here so
//                      FormPanel.test.tsx's semantic gate stays green.
//
// Guardrails (checked by guardrails.test.ts + FormPanel.test.ts):
//   - No "guaranteed / sure thing / lock / beat the market" language.
//   - "anchor" is the user's intuition MARK, never the betting sense of "lock".
//   - The context note "Form context — not betting advice." is always visible.
// ============================================================================
import { useI18n } from "../i18n";
import type { IntuitionState } from "../lib/types";
import type { ImpressionMap } from "../lib/impressions";
import type { HorseFormCard, JockeyFormCard } from "../api";
import { HorseContent, HorseDrillView } from "./HorseDrillView";

// ---------------------------------------------------------------------------
// Pure view — rendered by both the fetch-owning wrapper and the tests.
// Prop shape is UNCHANGED from the pre-Phase-2 design; only the internal body
// delegation changed (HorseContext/JockeyContext/IntuitionMarks → HorseContent).
// The horse content output is byte-identical (same fields, same i18n keys).
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
  /**
   * Current intuition mark for this horse (ADR-0011 Phase 1: replaces the old
   * IntuitionState prop). null when the horse has no stored impression.
   * Extracted from the Impression by the parent (RaceScreen / ExplainScreen)
   * so this PURE view stays decoupled from the store's value shape.
   */
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
  const { t } = useI18n();
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

      <HorseContent
        horse={horse}
        jockey={jockey}
        jockeyId={jockeyId ?? null}
        jockeyName={jockeyName ?? null}
        intuition={intuition}
        onIntuition={onIntuition}
        loading={loading}
        err={err}
        comingSoon={comingSoon}
        onRetry={onRetry}
        onReturnToTickets={onReturnToTickets}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Fetch-owning wrapper used by RaceScreen / ExplainScreen in the live app.
//
// ADR-0011 Phase 2: the wrapper now takes the impression STORE + the runner's
// current odds + snapshot heartbeat, and delegates the body (fetch + store
// read/write + drift chip) to <HorseDrillView />. The wrapper keeps only the
// modal-frame states that it uniquely owns (the close button + the framing
// chrome). HorseDrillView owns the fetch on mount.
// ---------------------------------------------------------------------------

export interface FormPanelProps {
  raceId: string;
  horse: {
    umaban: number;
    name: string;
    jockeyId?: string | null;
    jockeyName?: string | null;
  };
  /** Live win odds at the caller's "now"; feeds the drift chip. */
  currentOdds?: number | null;
  /** Optional PIT anchor (ISO). When absent the backend uses now-UTC. */
  asOf?: string;
  /** The full impression store (App-level state). */
  impressions: ImpressionMap;
  /** App-level setter — HorseDrillView writes marks through this. */
  onSetImpressions: (next: ImpressionMap) => void;
  /** Snapshot heartbeat, stamped into each mark at mark time. */
  oddsSnapshotAt?: string | null;
  onClose: () => void;
  /** Optional "Back to tickets" affordance (closes panel + routes to tickets). */
  onReturnToTickets?: () => void;
}

export function FormPanel(props: FormPanelProps) {
  const { t } = useI18n();
  const {
    raceId,
    horse,
    currentOdds,
    asOf,
    impressions,
    onSetImpressions,
    oddsSnapshotAt,
    onClose,
    onReturnToTickets,
  } = props;

  return (
    <section className="section form-panel" aria-label={t("form.title")}>
      <header className="form-head">
        <div>
          <h2>
            {t("form.title")} · {horse.name}
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

      <HorseDrillView
        raceId={raceId}
        horse={horse}
        currentOdds={currentOdds}
        asOf={asOf}
        impressions={impressions}
        onSetImpressions={onSetImpressions}
        oddsSnapshotAt={oddsSnapshotAt}
        onReturnToTickets={onReturnToTickets}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// toOutcome — the 404-vs-no_history dispatch. Kept on this file so
// FormPanel.test.tsx's semantic gate (`import { toOutcome } from "./FormPanel"`)
// stays green. HorseDrillView imports this for its own fetch.
// ---------------------------------------------------------------------------

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
