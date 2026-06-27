// ============================================================================
// TicketStudio — ADR-0011 Phase 3b shared modal.
//
// Encapsulates the structural-ticket surface so both the live RaceScreen and
// the Roundup bridge mount the SAME view set: SetFamilyView (unordered box
// family) + FormationView (ordered box family) + WheelView (axis-anchored
// wheels, only when an anchor mark exists) + FillGuide (the fill card, mounted
// as a second layer when a row is tapped).
//
// Guardrail: every view renders the user's OWN marked selection. The builder
// helpers (buildBoxTicket / buildFormationTicket / buildWheelTicket) take the
// set / axis / positions as parameters and make no selection of their own.
// TicketStudio derives `anchorUma` + `opponents` from the caller-supplied
// `markedSet` + `anchorUma`; it never picks an axis.
// ============================================================================
import { useState } from "react";
import { useI18n } from "../i18n";
import type { Runner } from "../lib/fairvalue";
import { SetFamilyView } from "./SetFamilyView";
import { FormationView } from "./FormationView";
import { WheelView } from "./WheelView";
import { FillGuide } from "./FillGuide";
import type { Ticket } from "../lib/types";

export interface TicketStudioProps {
  /** Include-marked umas (anchor / like / priceHorse) for the active race. */
  markedSet: string[];
  /** The anchor uma (drives WheelView axis). null when no anchor → wheel omitted. */
  anchorUma: string | null;
  /** Full field — market + grid context. */
  runners: Runner[];
  /** De-vigged win probabilities keyed by uma. */
  p: Record<string, number>;
  /** Stable list of all umas in the race. */
  allUmas: string[];
  /** Per-point stake. */
  unitStake: number;
  /** Modal header (e.g. "Box these 4 horses"). */
  title: string;
  /** Close handler — caller unmounts the studio. */
  onClose: () => void;
}

export function TicketStudio(props: TicketStudioProps) {
  const { t } = useI18n();
  const { markedSet, anchorUma, runners, p, allUmas, unitStake, title, onClose } = props;
  // FillGuide second layer: null = list view; a Ticket = fill card for that ticket.
  const [fillTicket, setFillTicket] = useState<Ticket | null>(null);

  // Opponents = the marked set minus the axis. Empty when no anchor.
  const opponents = anchorUma ? markedSet.filter((u) => u !== anchorUma) : [];

  return (
    <div className="kbm-modal" role="dialog" aria-modal="true">
      <div className="kbm-modal-card">
        <header className="kbm-modal-head">
          <strong>{title}</strong>
          <button
            className="btn ghost form-close"
            onClick={() => {
              setFillTicket(null);
              onClose();
            }}
            aria-label={t("form.close")}
          >
            ×
          </button>
        </header>

        {fillTicket ? (
          <FillGuide
            ticket={fillTicket}
            runners={runners}
            unitStake={unitStake}
          />
        ) : (
          <div className="kbm-modal-body">
            <SetFamilyView
              set={markedSet}
              runners={runners}
              p={p}
              allUmas={allUmas}
              unitStake={unitStake}
              onSelectTicket={(tk) => setFillTicket(tk)}
            />
            <FormationView
              set={markedSet}
              runners={runners}
              p={p}
              allUmas={allUmas}
              unitStake={unitStake}
              onSelectTicket={(tk) => setFillTicket(tk)}
            />
            {anchorUma && opponents.length >= 1 && (
              <WheelView
                axis={anchorUma}
                opponents={opponents}
                runners={runners}
                p={p}
                allUmas={allUmas}
                unitStake={unitStake}
                onSelectTicket={(tk) => setFillTicket(tk)}
              />
            )}
          </div>
        )}

        {fillTicket && (
          <button
            className="btn ghost"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => setFillTicket(null)}
          >
            {t("explain.back")}
          </button>
        )}
      </div>
    </div>
  );
}
