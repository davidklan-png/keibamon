// ====================== HANDLE PROMPT (Phase 3) + REPORT MODAL (Phase 4) ====
// Extracted from MyTickets' inner renderHandlePrompt / renderReportModal
// (2026-07-08 split — behavior preserving; state comes through MtCtx).
import React from "react";
import type { MtCtx } from "./ctx";

export function HandlePromptModal({ ctx }: { ctx: MtCtx }) {
  const {
    t,
    handlePromptOpen,
    setHandlePromptOpen,
    handleDraft,
    setHandleDraft,
    handleError,
    setHandleError,
    handleSetting,
    saveHandle,
  } = ctx;
  if (!handlePromptOpen) return null;
  return (
    <div className="mt-modal-overlay" onClick={() => setHandlePromptOpen(false)}>
      <div className="mt-modal" onClick={(e) => e.stopPropagation()}>
        <div className="mt-modal-title">{t("mine.setHandleTitle")}</div>
        <p className="mt-modal-hint">{t("mine.setHandleHint")}</p>
        <input
          className="mt-modal-input"
          type="text"
          value={handleDraft}
          placeholder={t("mine.setHandlePlaceholder")}
          onChange={(e) => {
            setHandleDraft(e.target.value);
            setHandleError(null);
          }}
          autoFocus
          maxLength={32}
        />
        {handleError && <div className="mt-modal-error">{handleError}</div>}
        <button
          className="mt-modal-cta"
          onClick={() => void saveHandle()}
          disabled={handleSetting || !handleDraft.trim()}
        >
          {handleSetting ? "…" : t("mine.setHandleCta")}
        </button>
      </div>
    </div>
  );
}

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
