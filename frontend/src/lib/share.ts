// ADR-0007 Phase 3 — ticket-card share export.
//
// Uses html-to-image's toPng (pure JS, browser-only; ~12 KB gzipped) to raster
// the ticket card DOM, then prefers the Web Share API (mobile) and falls back
// to a download link (desktop).
//
// HARD GATE: the exported PNG MUST contain the not-betting-advice micro-line.
// The caller passes the ticket card node; we assert that a descendant matches
// [data-not-advice]. If absent, we throw MissingNotAdvice — better to fail
// loudly than silently ship an advice-less card.

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

/**
 * Export a ticket-card DOM node as a PNG.
 *
 * @param node    the card root (must contain a child matching [data-not-advice])
 * @param _filename unused — kept for the call signature promised by the plan.
 *                   The actual file is named "keibamon-ticket.png" so devices
 *                   that key off filename (iOS share sheet) see the brand.
 */
export async function exportTicketCard(
  node: HTMLElement,
  _filename?: string,
): Promise<ShareOutcome> {
  // Pre-export assertion. The detail card footer carries data-not-advice on
  // the micro-line span; if a future refactor drops it, we fail here rather
  // than ship an advice-less card.
  if (!node.querySelector('[data-not-advice]')) {
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
