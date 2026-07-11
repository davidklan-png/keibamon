// ====================== REPORT MODAL (Phase 4) =============================
// Extracted from MyTickets' inner renderReportModal (2026-07-08 split —
// behavior preserving; state comes through MtCtx).
//
// Social UX Fixes (Phase B): the HandlePromptModal that used to live here was
// removed — it was vestigial (rendered but never opened) and is superseded by
// the single shared <HandleSetup /> onboarding step mounted by the App shell.
// Exactly one handle-setup UI exists in the codebase now.
import React from "react";
import type { MtCtx } from "./ctx";

export function ReportModal({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    reportTarget,
    setReportTarget,
    reportReason,
    setReportReason,
    reportSending,
    sendReport,
  } = ctx;
  if (!reportTarget) return null;
  return (
    <div className="mt-modal-overlay" onClick={() => !reportSending && setReportTarget(null)}>
      <div className="mt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mt-modal-title">{t("profile.report")}</div>
        <p className="mt-modal-hint">{t("profile.reportReason")}</p>
        <textarea
          className="mt-modal-input"
          value={reportReason}
          placeholder={t("profile.reportReason")}
          onChange={(e) => setReportReason(e.target.value)}
          autoFocus
          maxLength={500}
          rows={3}
          disabled={reportSending}
        />
        <button
          className="mt-modal-cta"
          onClick={() => sendReport()}
          disabled={reportSending || !reportReason.trim()}
        >
          {reportSending ? "…" : t("profile.report")}
        </button>
      </div>
    </div>
  );
}
