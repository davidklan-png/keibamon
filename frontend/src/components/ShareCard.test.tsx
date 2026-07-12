// @vitest-environment jsdom
//
// ShareCard — Item 4 (own-share-in-feed) + Item 5 (race identity block).
//
// jsdom because the tap-through test clicks the card (createRoot/act). The
// render-contract checks use renderToStaticMarkup (works under jsdom too).
// TicketLines is stubbed so the assertions stay focused on ShareCard's own
// output (the badge, the read-only count, the identity line, the routing).
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { ShareCard, raceMeta } from "./ShareCard";
import type { FeedItem } from "../auth/socialClient";
import type { CommittedTicket } from "../lib/types";

// React's act() needs this flag set to skip its "not configured" warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("./TicketLines", () => ({
  TicketLines: () => React.createElement("div", { "data-testid": "ticket-lines-stub" }),
}));

const RACE = {
  raceKey: "20260621|Tokyo|11|Hanshin Kinen",
  grade: "G1",
  nameEn: "Hanshin Kinen",
  nameJa: "宝塚記念",
  venueEn: "Hanshin",
  venueJa: "阪神",
  raceNo: 11,
  dateEn: "Jun 21",
  dateJa: "6月21日",
  post: "15:40",
  runners: [],
};

function feedItem(over: Partial<FeedItem> = {}): FeedItem {
  return {
    id: "sh-1",
    ticket_id: "tk-1",
    ticket: {
      id: "tk-1",
      serial: "KB-TEST",
      // The bet (recommender output) is NESTED under .ticket — ShareCard reads
      // tk.ticket.type / tk.ticket.cost, with mood/unit/race at the outer level.
      ticket: {
        type: "quinella",
        cost: 600,
        lines: [{ combo: ["1", "2"], prob: 0.5, share: 1, payout: 600 }],
        unit: 200,
        avgPayout: 600,
      },
      unit: 200,
      mood: "balanced",
      state: "open",
      payoutBase: 600,
      race: RACE,
      owner: "you",
      claps: 0,
      createdAt: 0,
    } as unknown as CommittedTicket,
    owner: { id: "u-rin", handle: "rin", display_name: "Rin", avatar: null },
    audience_mode: "all_friends",
    is_own: false,
    is_win: false,
    multiplier: null,
    congrats_count: 0,
    congratulated_by_me: false,
    comment_count: 0,
    created_at: 0,
    ...over,
  };
}

function renderHtml(item: FeedItem) {
  return renderToStaticMarkup(
    <ShareCard
      item={item}
      getToken={() => Promise.resolve("tok")}
      onOpen={() => {}}
      onOpenOwn={() => {}}
      viewerIsOwner={!!item.is_own}
    />,
  );
}

describe("ShareCard — Item 4 own-share badge + read-only congrats", () => {
  beforeEach(() => setLang("en"));

  it("a friend's card shows the @handle, with no 'You' badge", () => {
    const html = renderHtml(feedItem({ is_own: false }));
    expect(html).toContain("@rin");
    expect(html).not.toMatch(/sc-you/);
  });

  it("an own card shows the 'You' badge in place of the @handle", () => {
    const html = renderHtml(feedItem({ is_own: true }));
    expect(html).toMatch(/sc-owner sc-you/);
    expect(html).toContain("You");
    // The @handle is NOT shown for own items.
    expect(html).not.toContain("@rin");
  });

  it("a friend's win card renders the congratulate BUTTON (the toggle control)", () => {
    const html = renderHtml(feedItem({ is_own: false, is_win: true }));
    expect(html).toMatch(/<button[^>]*sc-congrats/);
    expect(html).toContain("Congratulate");
  });

  it("an own win card renders the congrats count read-only — no button, no toggle label", () => {
    const html = renderHtml(feedItem({ is_own: true, is_win: true, congrats_count: 3 }));
    // Read-only span carries the count...
    expect(html).toMatch(/sc-congrats-readonly/);
    expect(html).toContain("👏</span> 3");
    // ...and there is NO congratulate button or visible CTA label on own items
    // (the read-only span's aria-label is the only "Congratulate" text, for AT).
    expect(html).not.toMatch(/<button[^>]*sc-congrats/);
    expect(html).not.toMatch(/sc-congrats-label/);
  });
});

describe("ShareCard — Item 5 race identity block", () => {
  beforeEach(() => setLang("en"));

  it("renders venue · R# · date alongside the race name", () => {
    const html = renderHtml(feedItem());
    expect(html).toContain("Hanshin Kinen"); // race name present
    expect(html).toMatch(/sc-race-meta/);
    expect(html).toContain("Hanshin"); // venue
    expect(html).toContain("R11"); // race number
    expect(html).toContain("Jun 21"); // date
  });

  it("renders the JA venue/date under the JA locale", () => {
    setLang("ja");
    const html = renderHtml(feedItem());
    expect(html).toContain("阪神");
    expect(html).toContain("6月21日");
  });
});

describe("ShareCard — Item 4 tap-through routing", () => {
  beforeEach(() => setLang("en"));

  function mount(item: FeedItem, onOpen: () => void, onOpenOwn: () => void) {
    const root = createRoot(document.body);
    act(() => {
      root.render(
        <ShareCard
          item={item}
          getToken={() => Promise.resolve("tok")}
          onOpen={onOpen}
          onOpenOwn={onOpenOwn}
          viewerIsOwner={!!item.is_own}
        />,
      );
    });
    return root;
  }

  it("an own card routes to onOpenOwn(ticket_id), not the share viewer", () => {
    const onOpen = vi.fn();
    const onOpenOwn = vi.fn();
    const root = mount(feedItem({ is_own: true }), onOpen, onOpenOwn);
    act(() => {
      (document.querySelector(".sc-card") as HTMLElement).click();
    });
    expect(onOpenOwn).toHaveBeenCalledWith("tk-1");
    expect(onOpen).not.toHaveBeenCalled();
    root.unmount();
  });

  it("a friend's card routes to onOpen(share id), not the owner surface", () => {
    const onOpen = vi.fn();
    const onOpenOwn = vi.fn();
    const root = mount(feedItem({ is_own: false }), onOpen, onOpenOwn);
    act(() => {
      (document.querySelector(".sc-card") as HTMLElement).click();
    });
    expect(onOpen).toHaveBeenCalledWith("sh-1");
    expect(onOpenOwn).not.toHaveBeenCalled();
    root.unmount();
  });
});

describe("raceMeta — old-snapshot resilience", () => {
  it("joins venue · R# · date for a full race", () => {
    expect(raceMeta(RACE, false)).toBe("Hanshin · R11 · Jun 21");
    expect(raceMeta(RACE, true)).toBe("阪神 · R11 · 6月21日");
  });

  it("returns '' when the identity fields are absent (old snapshot) — no empty line", () => {
    expect(raceMeta({}, false)).toBe("");
    expect(raceMeta({ raceNo: 5 }, false)).toBe("R5");
    expect(raceMeta({ venueEn: "Tokyo" }, false)).toBe("Tokyo");
  });
});
