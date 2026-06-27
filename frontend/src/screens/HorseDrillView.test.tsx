// ============================================================================
// HorseDrillView tests (ADR-0011 Phase 2 — shared drill primitive).
//
// What this pins:
//   - The form fetch fires on mount (lazy-fetch-on-expand gate) and
//     transitions loading → ok → no_history correctly.
//   - A mark tap writes through onSetImpressions with the odds context stamped
//     at mark time (umaban + currentOdds + oddsSnapshotAt).
//   - The drift chip renders when currentOdds differs from the stored
//     odds_when_marked (>0.1), and is hidden when they match.
//   - The rendered output stays guardrail-clean (no "guaranteed / sure thing /
//     lock / beat the market").
//
// jsdom environment: HorseDrillView owns the fetch in useEffect, so the
// interaction tests need a real DOM + effect flush (act). The presentational
// inner (HorseContent) is separately pinned by FormPanel.test.tsx.
// ============================================================================
// @vitest-environment jsdom
// React 19 act() needs this flag set to recognize the test environment.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { setLang } from "../i18n";
import {
  fetchHorseForm,
  fetchJockeyForm,
  type HorseFormCard,
  type JockeyFormCard,
} from "../api";
import { HorseDrillView, HorseContent } from "./HorseDrillView";
import type { ImpressionMap } from "../lib/impressions";
import { setImpression } from "../lib/impressions";

// Mock the api layer — HorseDrillView's fetch lives in useEffect, so the mocks
// control the loading → ok → no_history transitions deterministically.
vi.mock("../api", () => ({
  fetchHorseForm: vi.fn(),
  fetchJockeyForm: vi.fn(),
  FormFetchError: class extends Error {},
}));

const fetchHorseFormMock = fetchHorseForm as unknown as ReturnType<typeof vi.fn>;
const fetchJockeyFormMock = fetchJockeyForm as unknown as ReturnType<typeof vi.fn>;

const HORSE_OK: HorseFormCard = {
  status: "ok",
  horse_name: "Test Horse",
  as_of: null,
  career: { starts: 12, wins: 4, top3: 8, win_pct: 0.33, top3_pct: 0.66 },
  recent_finishes: [
    {
      available_at: "2026-05-04T00:00:00Z",
      race_date: "2026-05-04",
      racecourse: "Tokyo",
      surface: "turf",
      distance_m: 2000,
      going: "good",
      grade_label: "G2",
      field_size: 14,
      finish_position: 2,
      margin: "3/4",
      last_3f_seconds: 33.8,
      win_odds: 4.6,
      popularity: 2,
      style_signal: "presser",
    },
  ],
  by_surface: { turf: { starts: 10, wins: 4, top3: 7, win_pct: 0.4, top3_pct: 0.7 } },
  by_distance_band: {
    mile: { starts: 5, wins: 2, top3: 3, win_pct: 0.4, top3_pct: 0.6 },
  },
  style_profile: { presser: 4 },
  market_vs_result: { avg_beat_market: 0.2, note: "tends to outrun odds" },
};

const JOCKEY_OK: JockeyFormCard = {
  status: "ok",
  jockey_id: "05218",
  as_of: null,
  career: { starts: 100, wins: 30, top3: 55, win_pct: 0.3, top3_pct: 0.55 },
  combos: {
    by_horse: [{ horse_name: "Test Horse", starts: 6, wins: 3 }],
    by_trainer: [],
  },
};

const HORSE_NO_HISTORY: HorseFormCard = { status: "no_history", horse_name: "Nobody" };

// --- render helper (React 19 createRoot + act) ---
function render(el: React.ReactElement): {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(el);
  });
  return { container, root, unmount: () => act(() => root.unmount()) };
}

const BANNED = [
  /\bguaranteed\b/i,
  /\bsure thing\b/i,
  /\block\b/i,
  /\bbeat the market\b/i,
];

describe("HorseDrillView — fetch + store + drift", () => {
  beforeEach(() => {
    setLang("en");
    fetchHorseFormMock.mockReset();
    fetchJockeyFormMock.mockReset();
  });
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fires fetchHorseForm on mount (lazy-fetch-on-expand gate)", () => {
    fetchHorseFormMock.mockReturnValue(new Promise(() => {})); // never resolves
    fetchJockeyFormMock.mockResolvedValue(JOCKEY_OK);
    const { unmount } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 1, name: "Test Horse", jockeyId: "05218" }}
        impressions={{}}
        onSetImpressions={() => {}}
      />,
    );
    expect(fetchHorseFormMock).toHaveBeenCalledTimes(1);
    expect(fetchHorseFormMock).toHaveBeenCalledWith("Test Horse", undefined);
    // Jockey fetch only fires when a jockeyId is supplied.
    expect(fetchJockeyFormMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("does NOT fetch the jockey when jockeyId is absent (Roundup path)", () => {
    fetchHorseFormMock.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 3, name: "No Jockey Horse" }}
        impressions={{}}
        onSetImpressions={() => {}}
      />,
    );
    expect(fetchHorseFormMock).toHaveBeenCalledTimes(1);
    expect(fetchJockeyFormMock).not.toHaveBeenCalled();
    unmount();
  });

  it("transitions loading → ok and renders the career line", async () => {
    fetchHorseFormMock.mockResolvedValue(HORSE_OK);
    fetchJockeyFormMock.mockResolvedValue(JOCKEY_OK);
    const { container } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 1, name: "Test Horse", jockeyId: "05218" }}
        impressions={{}}
        onSetImpressions={() => {}}
      />,
    );
    // Loading hint renders first.
    expect(container.textContent).toContain("…");
    // Flush the resolved promises.
    await act(async () => {
      await Promise.resolve();
    });
    // Career line renders after the fetch resolves.
    expect(container.textContent).toContain("12 starts");
    expect(container.textContent).toContain("Tokyo");
  });

  it("transitions to the no_history copy when the horse has no recorded starts", async () => {
    fetchHorseFormMock.mockResolvedValue(HORSE_NO_HISTORY);
    fetchJockeyFormMock.mockResolvedValue({
      status: "no_history",
      jockey_id: "05218",
    });
    const { container } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 1, name: "Nobody", jockeyId: "05218" }}
        impressions={{}}
        onSetImpressions={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toMatch(/no past form on record for this horse/i);
  });

  it("writes a mark through onSetImpressions with odds context stamped", async () => {
    fetchHorseFormMock.mockResolvedValue(HORSE_OK);
    fetchJockeyFormMock.mockResolvedValue(JOCKEY_OK);
    let store: ImpressionMap = {};
    const onSet = (next: ImpressionMap) => {
      store = next;
    };
    const { container } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 7, name: "Test Horse", jockeyId: "05218" }}
        currentOdds={5.4}
        oddsSnapshotAt="2026-06-27T10:00:00Z"
        impressions={store}
        onSetImpressions={onSet}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    // Tap the "Like" mark button.
    const likeBtn = Array.from(container.querySelectorAll("button.intuition-mark")).find(
      (b) => b.textContent === "Like",
    ) as HTMLButtonElement | undefined;
    expect(likeBtn, "Like mark button rendered").toBeTruthy();
    act(() => {
      likeBtn!.click();
    });
    // The store now carries an entry keyed on (race-1, normalized "Test Horse")
    // with umaban + odds context stamped at mark time.
    const entries = Object.entries(store);
    expect(entries.length).toBe(1);
    const [key, impression] = entries[0];
    expect(key.startsWith("race-1|")).toBe(true);
    expect(impression.mark).toBe("like");
    expect(impression.umaban).toBe(7);
    expect(impression.odds_when_marked).toBe(5.4);
    expect(impression.odds_snapshot_at).toBe("2026-06-27T10:00:00Z");
  });

  it("renders the drift chip when currentOdds differs from odds_when_marked", async () => {
    fetchHorseFormMock.mockResolvedValue(HORSE_OK);
    fetchJockeyFormMock.mockResolvedValue(JOCKEY_OK);
    // Pre-seed a mark made at 8.0x; current odds is 4.5x → shorter.
    const store = setImpression({}, "race-1", "Test Horse", {
      mark: "like",
      umaban: 1,
      odds_when_marked: 8.0,
      odds_snapshot_at: "2026-06-27T08:00:00Z",
    });
    const { container } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 1, name: "Test Horse" }}
        currentOdds={4.5}
        impressions={store}
        onSetImpressions={() => {}}
      />,
    );
    // Flush the mount-time fetch so its state update lands inside act.
    await act(async () => {
      await Promise.resolve();
    });
    // Drift chip renders: liked-at 8.0 vs now 4.5, shorter (▲).
    const chip = container.querySelector(".drift-chip");
    expect(chip, "drift chip rendered").toBeTruthy();
    expect(chip!.textContent).toContain("8.0");
    expect(chip!.textContent).toContain("4.5");
    expect(chip!.textContent).toContain("▲"); // shorter
  });

  it("hides the drift chip when currentOdds matches odds_when_marked (within 0.1)", async () => {
    fetchHorseFormMock.mockResolvedValue(HORSE_OK);
    fetchJockeyFormMock.mockResolvedValue(JOCKEY_OK);
    const store = setImpression({}, "race-1", "Test Horse", {
      mark: "like",
      umaban: 1,
      odds_when_marked: 5.0,
      odds_snapshot_at: null,
    });
    const { container } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 1, name: "Test Horse" }}
        currentOdds={5.05} // within 0.1 → no chip
        impressions={store}
        onSetImpressions={() => {}}
      />,
    );
    // Flush the mount-time fetch so its state update lands inside act.
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.querySelector(".drift-chip")).toBeNull();
  });

  it("contains no banned honesty words in the rendered output", async () => {
    fetchHorseFormMock.mockResolvedValue(HORSE_OK);
    fetchJockeyFormMock.mockResolvedValue(JOCKEY_OK);
    const store = setImpression({}, "race-1", "Test Horse", {
      mark: "anchor",
      umaban: 1,
      odds_when_marked: 6.0,
      odds_snapshot_at: null,
    });
    const { container } = render(
      <HorseDrillView
        raceId="race-1"
        horse={{ umaban: 1, name: "Test Horse", jockeyId: "05218" }}
        currentOdds={9.0}
        impressions={store}
        onSetImpressions={() => {}}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    const html = container.innerHTML;
    for (const re of BANNED) expect(html).not.toMatch(re);
  });
});

describe("HorseContent — presentational inner (SSR-safe)", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("renders the career line for an ok horse card", () => {
    // HorseContent is purely presentational — renderToStaticMarkup exercises it
    // without jsdom, confirming the inner block stays server-safe.
    const { renderToStaticMarkup } = require("react-dom/server");
    const html = renderToStaticMarkup(
      <HorseContent
        horse={HORSE_OK}
        jockey={JOCKEY_OK}
        jockeyId="05218"
        jockeyName="J. Rider"
        intuition={null}
        onIntuition={() => {}}
        loading={false}
        err=""
        comingSoon={false}
        onRetry={() => {}}
      />,
    );
    expect(html).toContain("12 starts");
    expect(html).toContain("Tokyo");
    expect(html).toContain("J. Rider");
  });

  it("renders no_history copy when the horse card is absent", () => {
    const { renderToStaticMarkup } = require("react-dom/server");
    const html = renderToStaticMarkup(
      <HorseContent
        horse={null}
        jockey={null}
        jockeyId="05218"
        jockeyName={null}
        intuition={null}
        onIntuition={() => {}}
        loading={false}
        err=""
        comingSoon={false}
        onRetry={() => {}}
      />,
    );
    expect(html).toMatch(/no past form on record for this horse/i);
  });
});
