// ====================== MANUAL BUILDER ======================
// Extracted from MyTickets' inner renderManual (2026-07-08 split — behavior
// preserving; commitManual stays in the container and arrives through MtCtx).
import React, { useMemo, useState } from "react";
import { ManualTicketBuilder, type ManualTicketInitial } from "../ManualTicketBuilder";
import type { MtCtx } from "./ctx";
import { mtRaceKey, mtRunnersOf, snapshotRace } from "../../lib/mytickets-view";

export function ManualView({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    tFmt,
    setView,
    manualEditId,
    tickets,
    feature,
    races,
    fallbackDate,
    featRunners,
    runnersForTicket,
    unit,
    setUnit,
    commitManual,
    shareManual,
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
  const availableRaces = useMemo(
    () => races.filter((race) => (race.runners || []).length > 0),
    [races],
  );
  const featuredKey = feature ? mtRaceKey(feature, fallbackDate) : "";
  const [selectedRaceKey, setSelectedRaceKey] = useState(featuredKey);
  const selectedRace =
    availableRaces.find((race) => mtRaceKey(race, fallbackDate) === selectedRaceKey) ??
    feature ??
    availableRaces[0] ??
    null;
  const builderRunners = editTk
    ? runnersForTicket(editTk)
    : selectedRace
      ? mtRunnersOf(selectedRace)
      : featRunners;
  const raceSnapshot = editTk?.race ?? (selectedRace ? snapshotRace(selectedRace, fallbackDate) : null);
  const builderKey = editTk?.id ?? (selectedRace ? mtRaceKey(selectedRace, fallbackDate) : "manual-no-race");

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
      {raceSnapshot ? (
        <>
          <section className="mt-manual-race" aria-label={t("manual.raceContext")}>
            <div className="mt-manual-race-topline">
              <span className="mt-manual-race-kicker">{t("manual.raceContext")}</span>
              {editTk ? (
                <span className="mt-manual-race-fixed">{t("manual.raceLocked")}</span>
              ) : (
                <label className="mt-manual-race-select">
                  <span className="sr-only">{t("manual.chooseRace")}</span>
                  <select
                    value={selectedRace ? mtRaceKey(selectedRace, fallbackDate) : ""}
                    onChange={(event) => setSelectedRaceKey(event.target.value)}
                    aria-label={t("manual.chooseRace")}
                  >
                    {availableRaces.map((race) => (
                      <option key={mtRaceKey(race, fallbackDate)} value={mtRaceKey(race, fallbackDate)}>
                        {(race.venue || "")} R{race.race_no} · {race.name || t("race.placeholderRace")}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="mt-manual-race-name">
              {raceSnapshot.venueEn} R{raceSnapshot.raceNo} · {raceSnapshot.nameEn}
            </div>
            <div className="mt-manual-race-meta">
              {raceSnapshot.dateEn && <span>{raceSnapshot.dateEn}</span>}
              {raceSnapshot.grade && <span>{raceSnapshot.grade}</span>}
              {raceSnapshot.post && <span>{t("mine.post")} {raceSnapshot.post}</span>}
              <span>{tFmt("race.runnersCount", { count: raceSnapshot.runners.length })}</span>
            </div>
          </section>
          <ManualTicketBuilder
            key={builderKey}
            runners={builderRunners}
            unit={unit}
            onUnitChange={setUnit}
            initial={initial}
            onRegister={(built) => commitManual(built.ticket, built.id, selectedRace ?? undefined)}
            onShare={(built) => shareManual(built.ticket, selectedRace ?? undefined)}
            onCancel={() => setView("new")}
          />
        </>
      ) : (
        <p className="empty">{t("race.noLive")}</p>
      )}
    </>
  );
}
