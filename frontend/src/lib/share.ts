// ADR-0007 Phase 3 — ticket-card share export.
//
// Uses html-to-image's toPng (pure JS, browser-only; ~12 KB gzipped) to raster
// the ticket card DOM, then prefers the Web Share API (mobile) and falls back
// to a download link (desktop).
//
// DISCLAIMER GATE: by default the exported PNG MUST contain the not-betting-
// advice micro-line — the caller passes the ticket card node and we assert a
// descendant matches [data-not-advice]. If absent, we throw MissingNotAdvice:
// better to fail loudly than silently ship an advice-less card.
//
// Opt-out (ticket-detail-ux, 2026-07-12): the My Tickets detail card is
// intentionally clean — the footer disclaimer + barcode were removed by locked
// decision (the age-gate acknowledgment is now the guardrail touchpoint, not a
// per-card micro-line). That path passes { requireNotAdvice: false }. The
// FillGuide "fill card" still carries its own [data-not-advice] micro-line and
// keeps the default (true), so its guardrail is unchanged.

import { toPng } from "html-to-image";

export type ShareOutcome = { kind: "shared" } | { kind: "downloaded" } | { kind: "none" };

/** Thrown when the export target lacks the [data-not-advice] marker. */
export class MissingNotAdvice extends Error {
  constructor() {
    super("exportTicketCard: node is missing the [data-not-advice] micro-line");
    this.name = "MissingNotAdvice";
  }
}

const FILENAME = "keibamon-ticket.png";

export interface ExportOptions {
  /**
   * Enforce the [data-not-advice] disclaimer gate (default true). The detail
   * card opts out — it's a clean card by design; FillGuide keeps the default.
   */
  requireNotAdvice?: boolean;
}

/**
 * Export a ticket-card DOM node as a PNG.
 *
 * @param node  the card root. By default must contain a child matching
 *              [data-not-advice]; pass { requireNotAdvice: false } for the
 *              intentionally-clean detail card.
 * @param opts  export options (disclaimer gate).
 */
export async function exportTicketCard(
  node: HTMLElement,
  opts: ExportOptions = {},
): Promise<ShareOutcome> {
  const requireNotAdvice = opts.requireNotAdvice !== false;
  // Pre-export assertion. FillGuide's footer carries data-not-advice on the
  // micro-line span; if a future refactor drops it, we fail here rather than
  // ship an advice-less card. The detail card opts out (clean by design).
  if (requireNotAdvice && !node.querySelector('[data-not-advice]')) {
    throw new MissingNotAdvice();
  }

  const blob: Blob = await toPng(node, { cacheBust: true, pixelRatio: 2 }).then(
    (dataUrl: string) => fetch(dataUrl).then((r) => r.blob()),
  );

  // Web Share API with file payload — iOS Safari + Android Chrome.
  const file = new File([blob], FILENAME, { type: "image/png" });
  const nav = navigator as Navigator & {
    canShare?: (data?: { files?: File[] }) => boolean;
    share?: (data?: { files?: File[] }) => Promise<void>;
  };
  if (typeof nav.canShare === "function" && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return { kind: "shared" };
    } catch {
      // User cancelled, or share failed — fall through to download.
    }
  }

  // Download fallback.
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = FILENAME;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { kind: "downloaded" };
  } catch {
    return { kind: "none" };
  }
}
