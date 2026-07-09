// ====================== MANUAL BUILDER ======================
// Extracted from MyTickets' inner renderManual (2026-07-08 split — behavior
// preserving; commitManual stays in the container and arrives through MtCtx).
import React from "react";
import { ManualTicketBuilder, type ManualTicketInitial } from "../ManualTicketBuilder";
import type { MtCtx } from "./ctx";

export function ManualView({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    setView,
    manualEditId,
    tickets,
    feature,
    featRunners,
    runnersForTicket,
    unit,
    setUnit,
    commitManual,
  } = ctx;
  // Edit-in-place: when manualEditId is set, prefill the builder from that
  // existing OPEN ticket and reuse its id on Register (POST upserts on
  // conflict when state='open' → Step 1's edit-in-place path). When null,
  // the builder is the create-from-scratch flow with a fresh id.
  const editTk = manualEditId
    ? tickets.find((x) => x.id === manualEditId) ?? null
    : null;
  const initial: ManualTicketInitial | undefined = editTk
    ? {
        id: editTk.id,
        type: editTk.ticket.type,
        lines: editTk.ticket.lines.map((l) => l.combo),
        unit: editTk.unit,
        structure: editTk.ticket.structure,
        structurePayload: editTk.ticket.structurePayload,
      }
    : undefined;
  // Editing must stay pinned to the ticket's own race. `featRunners` tracks
  // whichever race the app currently highlights as "featured", which is a
  // different race as soon as more than one is live — that mismatch is what
  // truncated the picker to the featured race's (smaller) field instead of
  // the ticket's real one. New tickets have no race of their own yet, so
  // they still build against the featured race.
  const builderRunners = editTk ? runnersForTicket(editTk) : featRunners;
  return (
    <>
      <div className="mt-back-head">
        <button className="mt-back" onClick={() => setView("new")}>
          ‹
        </button>
        <div className="mt-back-title">
          {editTk ? t("manual.editTitle") : t("manual.title")}
        </div>
      </div>
      {feature ? (
        <ManualTicketBuilder
          runners={builderRunners}
          unit={unit}
          onUnitChange={setUnit}
          initial={initial}
          onRegister={(built) => commitManual(built.ticket, built.id)}
          onCancel={() => setView("new")}
        />
      ) : (
        <p className="empty">{t("race.noLive")}</p>
      )}
    </>
  );
}
