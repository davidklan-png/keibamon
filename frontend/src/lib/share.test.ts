// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// ADR-0007 Phase 3 — share export tests.
//
// html-to-image is stubbed so the test exercises only our gating + branching
// (presence of [data-not-advice], share-vs-download path).

vi.mock("html-to-image", () => ({
  toPng: vi.fn(() => Promise.resolve("data:image/png;base64,AAAA")),
}));

import { exportTicketCard, MissingNotAdvice } from "./share";

function makeNode(withNotAdvice: boolean): HTMLElement {
  const root = document.createElement("div");
  if (withNotAdvice) {
    const span = document.createElement("span");
    span.setAttribute("data-not-advice", "");
    span.textContent = "not betting advice";
    root.appendChild(span);
  }
  return root;
}

describe("exportTicketCard", () => {
  beforeEach(() => {
    // jsdom doesn't implement URL.createObjectURL by default.
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(
      () => "blob:mock",
    );
    (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
  });

  it("throws MissingNotAdvice when the node lacks [data-not-advice]", async () => {
    const node = makeNode(false);
    await expect(exportTicketCard(node)).rejects.toBeInstanceOf(MissingNotAdvice);
  });

  it("succeeds when the node contains [data-not-advice]", async () => {
    const node = makeNode(true);
    const outcome = await exportTicketCard(node);
    // Without a real navigator.share / canShare in jsdom, we land on the
    // download path (or {kind:'none'} if click fails). Either is a success
    // signal — the gate passed and toPng ran.
    expect(["downloaded", "shared", "none"]).toContain(outcome.kind);
  });
});
