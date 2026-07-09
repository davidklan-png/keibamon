import { describe, it, expect } from "vitest";
import { newTicketId } from "./ticketId";

describe("newTicketId", () => {
  it("keeps the kb- prefix and is a UUID v4 (high-entropy, unguessable)", () => {
    const id = newTicketId();
    // UUIDv4: 8-4-4-4-12 hex. The kb- prefix is the documented client marker.
    expect(id).toMatch(/^kb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("is unique across many rapid calls (timestamp-derived ids would collide within a ms)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(newTicketId());
    expect(ids.size).toBe(5000);
  });
});
