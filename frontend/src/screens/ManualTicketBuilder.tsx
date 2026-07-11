// ============================================================================
// ManualTicketBuilder — interactive bet builder for advanced punters.
//
// Tap-to-build UI in the same visual language as FillGuide (number grid for
// box-style bets, bracket grid for 枠連). The user picks a bet type, then
// either a set of umas (1..maxUma) or brackets (1..8), and the builder
// expands the picks into priced TicketLines via lib/manualBuilder.ts. The
// same Ticket shape as the recommender output flows downstream — commit,
// settle, and the existing card / FillGuide renders all work unchanged.
//
// Edit mode: when `initial` is provided (an existing OPEN ticket's type /
// lines / unit), the builder pre-fills the picker with that ticket's
// selections and on Register reuses the same ticket id, hitting the
// backend's edit-in-place path (POST upserts on conflict when state='open').
//
// This component is pure presentational + local-state. It calls back into
// the parent for commit / cancel / odds-refresh — no D1 / Worker / fetch
// logic lives here.
// ============================================================================
import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import { yen } from "../lib/format";
import {
  winProbs,
  type BetType,
  type Runner,
} from "../lib/fairvalue";
import {
  buildManualFormationTicket,
  buildManualTicket,
  finalizeTicket,
  isFullBox,
  K_BY_TYPE,
  MANUAL_BET_TYPES,
  type ManualBuildMode,
  priceLines,
  runnersByBracket,
} from "../lib/manualBuilder";
import type { FormationPayload, Ticket } from "../lib/types";

export interface ManualTicketInitial {
  id?: string;
  type?: BetType;
  lines?: string[][];
  unit?: number;
  structure?: Ticket["structure"];
  structurePayload?: Ticket["structurePayload"];
}

export interface ManualTicketBuilderProps {
  /** Full field for the selected race. Runners may carry `gate` for 枠連. */
  runners: Runner[];
  /** Per-line stake the parent owns (matches the existing New Bet flow). */
  unit: number;
  onUnitChange: (n: number) => void;
  /** When present, opens the builder pre-filled (edit-in-place). */
  initial?: ManualTicketInitial;
  /** Built-ticket callback. Parent decides POST vs PATCH path. */
  onRegister: (built: { ticket: Ticket; id?: string }) => void;
  /** Friend Interactions Phase 3 — Share (opens FriendPicker). Optional. */
  onShare?: (built: { ticket: Ticket; id?: string }) => void;
  onCancel: () => void;
}

const UNITS = [100, 200, 300];
// Stage 6 guardrail: warn before committing a surprise-huge ticket. A full-
// field trifecta FORMATION expands to 18P3 = 4896 priced lines; the user picks
// "1st: all, 2nd: all, 3rd: all" without realizing the cost. 50 lines is past
// any reasonable curated box (a 6-horse trifecta box is C(6,3)=20) and short
// enough to catch the surprise early.
const BIG_LINES = 50;

function isOrderedType(type: BetType): boolean {
  return type === "exacta" || type === "trifecta";
}

function emptyPositions(type: BetType): string[][] {
  const k = isOrderedType(type) ? K_BY_TYPE[type] : 2;
  return Array.from({ length: k }, () => []);
}

function initialFormationPositions(initial?: ManualTicketInitial): string[][] | null {
  if (
    !initial ||
    initial.structure !== "formation" ||
    !initial.structurePayload ||
    !("positions" in initial.structurePayload)
  ) {
    return null;
  }
  const positions = (initial.structurePayload as FormationPayload).positions;
  return positions.map((posSet) => posSet.slice());
}

export function ManualTicketBuilder(props: ManualTicketBuilderProps) {
  const { t, tFmt } = useI18n();
  const { runners, unit, onUnitChange, initial, onRegister, onCancel, onShare } = props;

  // De-vig the win market for this race once per runners change. The builder
  // is opened with a fresh snapshot; the parent's existing 45s poll keeps
  // `runners` (and hence `p`) fresh on every render while the builder is
  // mounted. "Update odds" below is the user-facing way to trigger that
  // refresh now rather than wait for the next poll tick.
  const { p, allUmas } = useMemo(() => {
    const { p } = winProbs(runners);
    return { p, allUmas: runners.map((r) => r.uma) };
  }, [runners]);

  // Bet type — defaults to initial (edit mode) or quinella.
  const [type, setType] = useState<BetType>(initial?.type ?? "quinella");
  const [mode, setMode] = useState<ManualBuildMode>(() =>
    initialFormationPositions(initial) ? "formation" : "box",
  );

  // Two distinct pick states (bracket space vs uma space). Reset the inactive
  // one whenever the user switches number spaces so a later switchback starts
  // clean — keeps the cognitive model simple.
  const [pickedUma, setPickedUma] = useState<Set<string>>(() => {
    if (!initial?.lines || initial.type === "bracket_quinella") return new Set();
    const s = new Set<string>();
    for (const ln of initial.lines) for (const c of ln) s.add(c);
    return s;
  });
  const [pickedBrackets, setPickedBrackets] = useState<Set<number>>(() => {
    if (!initial?.lines || initial.type !== "bracket_quinella") return new Set();
    const s = new Set<number>();
    for (const ln of initial.lines)
      for (const c of ln) {
        const n = Number(c);
        if (Number.isFinite(n)) s.add(n);
      }
    return s;
  });
  const [formationPositions, setFormationPositions] = useState<string[][]>(() => {
    const fromInitial = initialFormationPositions(initial);
    if (fromInitial) return fromInitial;
    return emptyPositions(initial?.type ?? "quinella");
  });

  // ---- Edit-mode lock (ticket-generation-alignment) -----------------------
  // Opening a CURATED ticket — one that is NOT a full combinatorial box, e.g.
  // a recommend() ticket that kept only its top ~10 of 35 trio combos — must
  // not silently regenerate the full box when the user taps Save without
  // changing anything. While locked, the preview is the ticket's ORIGINAL
  // combos re-priced against the CURRENT odds (line set unchanged; prices may
  // drift with the market, which is correct), not a fresh buildManualTicket()
  // over the picked set. The first pick change flips `locked` off for the rest
  // of the session and switches to normal full-box behavior.
  //
  // Never locks for: new tickets (no `initial`), full-box edits (a manually-
  // built box regenerates to itself anyway), or bracket_quinella (always full-
  // box; recommend() never produces it). Changing the unit stake does NOT
  // unlock — it only re-prices, and the line set should be preserved.
  const initialCore = useMemo(() => {
    if (!initial?.lines || initial.type === "bracket_quinella") return [];
    const s = new Set<string>();
    for (const ln of initial.lines) for (const c of ln) s.add(c);
    return Array.from(s);
  }, [initial]);
  const initiallyLocked =
    !!initial?.lines &&
    !!initial.type &&
    initial.type !== "bracket_quinella" &&
    !isFullBox(initial.type, initial.lines, initialCore);
  const [locked, setLocked] = useState(initiallyLocked);
  // Flips on the locked→box transition so the UI can show a one-time "now
  // rebuilding the full box" note. Stays false for tickets that were never
  // locked (new / full-box edits).
  const [unlockedFromLock, setUnlockedFromLock] = useState(false);

  const isBracket = type === "bracket_quinella";
  const canUseFormation = isOrderedType(type);
  const isFormationMode = canUseFormation && mode === "formation";
  const k = K_BY_TYPE[type];
  const hasBrackets = useMemo(() => runnersByBracket(runners) !== null, [runners]);

  // Field for the uma grid: 1..maxUma. Brackets are always 1..8.
  const maxUma = useMemo(
    () =>
      runners.reduce((m, r) => {
        const n = Number(r.uma);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0),
    [runners],
  );
  const umaCells = useMemo(
    () => Array.from({ length: Math.max(maxUma, 1) }, (_, i) => String(i + 1)),
    [maxUma],
  );
  const runnerByUma = useMemo(
    () => new Map(runners.map((runner) => [runner.uma, runner])),
    [runners],
  );
  const bracketCells = ["1", "2", "3", "4", "5", "6", "7", "8"];

  // Build the priced ticket from current picks. While locked (editing a
  // curated ticket before any pick change), re-price the ticket's ORIGINAL
  // combos against the live market instead of regenerating the box — so an
  // unchanged Save comes back out with the same line set (and cost) it went
  // in with. Once unlocked, this is exactly today's buildManualTicket() path.
  const ticket = useMemo(() => {
    if (locked && initial?.lines && initial?.type) {
      const { lines } = priceLines(
        initial.type,
        initial.lines,
        p,
        allUmas,
        unit,
      );
      if (lines.length === 0) return null;
      const priced = finalizeTicket(initial.type, lines, unit, p, allUmas);
      if (initial.structure === "formation" && initial.structurePayload) {
        return {
          ...priced,
          structure: "formation" as const,
          structurePayload: initial.structurePayload,
          unitStake: unit,
        };
      }
      return priced;
    }
    if (isFormationMode) {
      return buildManualFormationTicket(type, formationPositions, p, allUmas, unit);
    }
    return buildManualTicket(
      type,
      pickedUma,
      pickedBrackets,
      runners,
      p,
      allUmas,
      unit,
    );
  }, [
    locked,
    initial,
    isFormationMode,
    type,
    formationPositions,
    pickedUma,
    pickedBrackets,
    runners,
    p,
    allUmas,
    unit,
  ]);

  // Any structural pick change permanently ends locked mode for this session
  // (we don't re-lock if the picks happen to return to the original set —
  // simpler to reason about and test than set-equality tracking on every tap).
  function unlock() {
    if (locked) {
      setLocked(false);
      setUnlockedFromLock(true);
    }
  }
  function toggleUma(u: string) {
    unlock();
    setPickedUma((prev) => {
      const next = new Set(prev);
      if (next.has(u)) next.delete(u);
      else next.add(u);
      return next;
    });
  }
  function toggleBracket(b: number) {
    unlock();
    setPickedBrackets((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  }
  function toggleFormationUma(positionIndex: number, u: string) {
    unlock();
    setFormationPositions((prev) => {
      const next = Array.from({ length: k }, (_, i) => (prev[i] ?? []).slice());
      const posSet = new Set(next[positionIndex] ?? []);
      if (posSet.has(u)) posSet.delete(u);
      else posSet.add(u);
      next[positionIndex] = Array.from(posSet).sort((a, b) => Number(a) - Number(b));
      return next;
    });
  }
  function pickType(next: BetType) {
    if (next === type) return;
    unlock();
    setType(next);
    const nextMode = isOrderedType(next) ? "formation" : "box";
    setMode(nextMode);
    // Clear picks so an old selection in the other number space doesn't
    // leak into the new view (a 3-bracket 枠連 selection shouldn't silently
    // become umas "1"/"2"/"3" if the user flips to quinella).
    setPickedUma(new Set());
    setPickedBrackets(new Set());
    setFormationPositions(emptyPositions(next));
  }
  function pickMode(next: ManualBuildMode) {
    if (next === mode) return;
    unlock();
    setMode(next);
    setPickedUma(new Set());
    setPickedBrackets(new Set());
    setFormationPositions(emptyPositions(type));
  }

  // Validation gate: the user has picked enough for the bet type's k.
  const pickedCount = isBracket ? pickedBrackets.size : pickedUma.size;
  const canRegister =
    ticket !== null &&
    (isFormationMode
      ? formationPositions.length === k &&
        formationPositions.every((posSet) => posSet.length > 0)
      : pickedCount >= k);
  // 枠連 is also gated on the field having bracket data at all —
  // the bet-type chip is disabled when it doesn't, but defend here too.
  const bracketDisabled = isBracket && !hasBrackets;

  function horseCell(u: string, on: boolean, onClick: () => void, ariaPrefix = "") {
    const runner = runnerByUma.get(u);
    const odds = runner?.odds ?? 0;
    const oddsLabel = odds > 0 ? `${odds.toFixed(1)}×` : "—";
    return (
      <button
        key={u}
        type="button"
        role="listitem"
        className={`mt-manual-cell mt-manual-horse${on ? " on" : ""}`}
        onClick={onClick}
        aria-pressed={on}
        aria-label={`${ariaPrefix}${u} · ${t("manual.currentOdds")} ${oddsLabel}${on ? " (selected)" : ""}`}
      >
        <span className="mt-manual-horse-num">{u}</span>
        <span className="mt-manual-horse-odds">{oddsLabel}</span>
      </button>
    );
  }

  return (
    <div className="mt-manual">
      {/* Bet type picker */}
      <div className="mt-manual-section">
        <div className="mt-vibe-label">{t("manual.betType")}</div>
        <div className="mt-manual-types">
          {MANUAL_BET_TYPES.map((bt) => {
            const isOn = bt === type;
            const isDisabled = bt === "bracket_quinella" && !hasBrackets;
            return (
              <button
                key={bt}
                type="button"
                className={`mt-manual-type ${isOn ? "on" : ""}`}
                disabled={isDisabled}
                onClick={() => pickType(bt)}
                aria-pressed={isOn}
              >
                {t(`betType.${bt}`)}
              </button>
            );
          })}
        </div>
        {isBracket && !hasBrackets && (
          <p className="mt-manual-note">{t("manual.noBrackets")}</p>
        )}
      </div>

      {canUseFormation && (
        <div className="mt-manual-section">
          <div className="mt-vibe-label">{t("manual.ticketShape")}</div>
          <div className="mt-manual-modes">
            <button
              type="button"
              className={`mt-manual-mode ${mode === "formation" ? "on" : ""}`}
              onClick={() => pickMode("formation")}
              aria-pressed={mode === "formation"}
            >
              {t("manual.formationMode")}
            </button>
            <button
              type="button"
              className={`mt-manual-mode ${mode === "box" ? "on" : ""}`}
              onClick={() => pickMode("box")}
              aria-pressed={mode === "box"}
            >
              {t("manual.boxMode")}
            </button>
          </div>
        </div>
      )}

      {/* Selection grid */}
      <div className="mt-manual-section">
        {locked && initial?.lines && (
          <p className="mt-manual-locked-hint" data-mt-locked-hint>
            {tFmt("manual.lockedHint", { n: initial.lines.length })}
          </p>
        )}
        {unlockedFromLock && !locked && !isFormationMode && (
          <p className="mt-manual-box-note" data-mt-box-note>
            {t("manual.boxNote")}
          </p>
        )}
        <div className="mt-vibe-label">
          {isFormationMode
            ? t("manual.pickPlacings")
            : isBracket
              ? t("manual.pickBrackets")
              : t("manual.pickHorses")}
          {!locked && !isFormationMode && (
            <span className="mt-manual-pickcount">
              {pickedCount}/{k}
            </span>
          )}
        </div>
        {isFormationMode ? (
          <div className="mt-manual-formation">
            {Array.from({ length: k }, (_, posIndex) => {
              const selected = new Set(formationPositions[posIndex] ?? []);
              const posKey =
                posIndex === 0
                  ? "fillGuide.pos1"
                  : posIndex === 1
                    ? "fillGuide.pos2"
                    : "fillGuide.pos3";
              return (
                <div className="mt-manual-position" key={posIndex}>
                  <div className="mt-manual-position-head">
                    <span>{t(posKey)}</span>
                    <span>{selected.size}</span>
                  </div>
                  <div className="mt-manual-grid" role="list">
                    {umaCells.map((u) =>
                      horseCell(u, selected.has(u), () => toggleFormationUma(posIndex, u), `${t(posKey)} `),
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : isBracket ? (
          <div className="mt-manual-grid" role="list">
            {bracketCells.map((bstr) => {
              const n = Number(bstr);
              const on = pickedBrackets.has(n);
              return (
                <button
                  key={bstr}
                  type="button"
                  role="listitem"
                  className={`mt-manual-cell bracket-${bstr}${on ? " on" : ""}`}
                  onClick={() => toggleBracket(n)}
                  aria-pressed={on}
                  aria-label={bstr + (on ? " (selected)" : "")}
                >
                  {bstr}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="mt-manual-grid" role="list">
            {umaCells.map((u) => horseCell(u, pickedUma.has(u), () => toggleUma(u)))}
          </div>
        )}
      </div>

      {/* Unit picker */}
      <div className="mt-manual-section">
        <div className="mt-unit-label">{t("mine.unit")}</div>
        <div className="mt-units">
          {UNITS.map((v) => (
            <button
              key={v}
              type="button"
              className={`mt-unit ${unit === v ? "on" : ""}`}
              onClick={() => onUnitChange(v)}
            >
              ¥{v}
            </button>
          ))}
        </div>
      </div>

      {/* Live fair-value preview */}
      {ticket && (
        <div className="mt-manual-preview">
          <div className="mt-manual-preview-head">
            <span className="mt-manual-preview-type">
              {t(`betType.${type}`)}
              {isFormationMode ? ` · ${t("manual.formationMode")}` : ""}
            </span>
            <span className="mt-manual-preview-lines">
              {tFmt("manual.linesCount", { n: ticket.lines.length })}
            </span>
          </div>
          <div className="mt-chips mt-manual-preview-chips">
            {ticket.lines.slice(0, 6).map((ln, j) => (
              <span key={j} className="mt-chip">
                {ln.combo.join("-")}
              </span>
            ))}
            {ticket.lines.length > 6 && (
              <span className="mt-chip mt-chip-more">
                +{ticket.lines.length - 6}
              </span>
            )}
          </div>
          <div className="mt-manual-figures">
            <div>
              <div className="mt-metric-label">{t("mine.cost")}</div>
              <div className="mt-metric-cost">{yen(ticket.cost)}</div>
            </div>
            <div>
              <div className="mt-metric-label">{t("mine.ifHits")}</div>
              <div className="mt-metric-pay">{yen(ticket.avgPayout)}</div>
            </div>
            <div>
              <div className="mt-metric-label">{t("manual.hitProb")}</div>
              <div className="mt-metric-pay">
                {(ticket.hitProb * 100).toFixed(1)}%
              </div>
            </div>
          </div>
          {ticket.lines.length >= BIG_LINES && (
            <p className="mt-manual-warn" data-mt-big-warn>
              {tFmt("manual.bigTicketWarn", {
                n: ticket.lines.length,
                cost: yen(ticket.cost),
              })}
            </p>
          )}
        </div>
      )}

      {/* Actions */}
      <div className="mt-manual-actions">
        <button
          type="button"
          className="mt-manual-secondary"
          onClick={onCancel}
        >
          {t("manual.cancel")}
        </button>
      </div>
      <div className="mt-cta-wrap">
        <button
          type="button"
          className="mt-cta"
          disabled={!canRegister || bracketDisabled}
          onClick={() => {
            if (!ticket) return;
            onRegister({ ticket, id: initial?.id });
          }}
        >
          {initial?.id ? t("manual.save") : t("manual.register")}
          {ticket ? ` · ${yen(ticket.cost)}` : ""}
        </button>
        {onShare && (
          <button
            type="button"
            className="btn ghost mt-cta-share"
            disabled={!canRegister || bracketDisabled}
            onClick={() => {
              if (!ticket) return;
              onShare({ ticket, id: initial?.id });
            }}
          >
            {t("share.share")}
          </button>
        )}
      </div>
    </div>
  );
}
