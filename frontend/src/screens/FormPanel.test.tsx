// ============================================================================
// FormPanel tests (Milestone 4).
//
// What this pins:
//   - The guardrail copy ("Form context — not betting advice.") renders visibly.
//   - A canned horse+jockey card renders the career line, a recent-finishes
//     block, and the jockey block when a jockey_id is supplied.
//   - The no_history branch (status === "no_history") renders the empty copy
//     and never throws.
//   - The honesty guardrails hold: no "guaranteed / sure thing / lock / beat
//     the market" anywhere in the rendered HTML.
//
// Strategy: render the PURE FormPanelView (no useEffect / fetch) with already-
// loaded cards. Same renderToStaticMarkup + vitest pattern as i18n.test.tsx.
// ============================================================================
import { describe, it, expect, beforeEach } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { setLang } from "../i18n";
import { FormPanelView } from "./FormPanel";
import type {
  HorseFormCard,
  JockeyFormCard,
} from "../api";
import type { IntuitionState } from "../lib/types";

const HORSE_CARD_OK: HorseFormCard = {
  status: "ok",
  horse_name: "Danon Decile",
  as_of: null,
  context_note: "Form context, not betting advice.",
  career: { starts: 15, wins: 6, top3: 11, win_pct: 0.4, top3_pct: 0.733 },
  recent_finishes: [
    {
      available_at: "2026-05-04T00:00:00Z",
      race_date: "2026-05-04",
      racecourse: "Tokyo",
      surface: "turf",
      distance_m: 2500,
      going: "good",
      grade_label: "G1",
      field_size: 18,
      finish_position: 1,
      margin: "1",
      last_3f_seconds: 33.4,
      win_odds: 3.2,
      popularity: 1,
      style_signal: "presser",
    },
  ],
  by_surface: {
    turf: { starts: 14, wins: 6, top3: 10, win_pct: 0.43, top3_pct: 0.71 },
  },
  by_distance_band: {
    staying: { starts: 9, wins: 4, top3: 7, win_pct: 0.44, top3_pct: 0.78 },
  },
  by_wet: {
    wet: { starts: 3, wins: 1, top3: 2, win_pct: 0.33, top3_pct: 0.67 },
    dry: { starts: 12, wins: 5, top3: 9, win_pct: 0.42, top3_pct: 0.75 },
  },
  style_profile: { presser: 5, pace_following: 3, deep_closer: 2 },
  style_note: "Running style is a rough proxy from finish + closing split.",
  market_vs_result: { avg_beat_market: 0.47, note: "tends to outrun odds" },
};

const JOCKEY_CARD_OK: JockeyFormCard = {
  status: "ok",
  jockey_id: "05218",
  as_of: null,
  context_note: "Jockey context, not betting advice.",
  career: { starts: 200, wins: 60, top3: 110, win_pct: 0.3, top3_pct: 0.55 },
  by_course: {
    Tokyo: { starts: 80, wins: 28, top3: 45, win_pct: 0.35, top3_pct: 0.56 },
  },
  recent: [],
  combos: {
    by_horse: [
      { horse_name_key: "DanonDecile", horse_name: "Danon Decile", starts: 8, wins: 4 },
    ],
    by_trainer: [{ trainer_id: "tA", starts: 20, wins: 6 }],
  },
};

const HORSE_CARD_NO_HISTORY: HorseFormCard = {
  status: "no_history",
  horse_name: "Nobody",
  as_of: null,
};

const BANNED = [
  /\bguaranteed\b/i,
  /\bsure thing\b/i,
  /\block\b/i,
  /\bbeat the market\b/i,
];

function render(
  horse: HorseFormCard | null,
  jockey: JockeyFormCard | null,
  overrides: {
    jockeyId?: string | null;
    jockeyName?: string | null;
    intuition?: IntuitionState;
    loading?: boolean;
    err?: string;
    comingSoon?: boolean;
  } = {},
): string {
  const noop = () => {};
  // Honor explicit nulls: `??` collapses null → default, so check key presence.
  const has = (k: "jockeyId" | "jockeyName") => k in overrides;
  return renderToStaticMarkup(
    <FormPanelView
      horseName={horse?.horse_name ?? "Danon Decile"}
      jockeyId={has("jockeyId") ? overrides.jockeyId! : "05218"}
      jockeyName={has("jockeyName") ? overrides.jockeyName! : "J. Rider"}
      loading={overrides.loading ?? false}
      err={overrides.err ?? ""}
      comingSoon={overrides.comingSoon ?? false}
      horse={horse}
      jockey={jockey}
      intuition={overrides.intuition ?? null}
      onIntuition={noop}
      onClose={noop}
      onRetry={noop}
    />,
  );
}

describe("FormPanel view", () => {
  beforeEach(() => {
    setLang("en");
  });

  it("renders the guardrail context note + career line for an ok horse card", () => {
    const html = render(HORSE_CARD_OK, JOCKEY_CARD_OK);
    // Visible guardrail banner.
    expect(html).toMatch(/not betting advice/i);
    // Career block surfaced with starts + record.
    expect(html).toContain("Danon Decile");
    expect(html).toContain("15 starts");
    // Recent finishes surfaced.
    expect(html).toContain("Tokyo");
    // Jockey block surfaced (jockey_id present).
    expect(html).toContain("J. Rider");
  });

  it("renders the jockey-no-id copy when jockey_id is absent", () => {
    const html = render(HORSE_CARD_OK, null, {
      jockeyId: null,
      jockeyName: null,
    });
    expect(html).toContain("coming soon");
  });

  it("renders no_history copy when the horse has no recorded starts", () => {
    const html = render(HORSE_CARD_NO_HISTORY, null, {
      jockeyId: null,
      jockeyName: null,
    });
    expect(html).toMatch(/no past form/i);
  });

  it("renders the loading state without throwing", () => {
    const html = render(null, null, { loading: true });
    // Loading renders the context note (always present) + the ellipsis body.
    expect(html).toMatch(/not betting advice/i);
  });

  it("renders the error + retry affordance when fetch failed", () => {
    const html = render(null, null, { err: "Couldn't load form — try again." });
    // The apostrophe is HTML-escaped as &#x27; in server output; assert on the
    // text fragments around it instead.
    expect(html).toContain("load form");
    expect(html).toContain("try again");
    expect(html).toMatch(/retry/i);
  });

  it("degrades to a 'Coming this weekend' message when endpoints 404", () => {
    // Production as of 2026-06-25: the FastAPI form endpoints are dev-only and
    // not wired into the deployed Worker. FormPanel detects the 404 and shows
    // this block instead of the load-error UI — visually present, not
    // interactive, no Retry button.
    const html = render(null, null, { comingSoon: true });
    expect(html).toMatch(/coming this weekend/i);
    // No error/retry affordance in the degraded state.
    expect(html).not.toMatch(/try again/i);
    expect(html).not.toMatch(/retry/i);
    // No career line / horse data rendered.
    expect(html).not.toContain("starts");
    // The guardrail context note is still visible.
    expect(html).toMatch(/not betting advice/i);
  });

  it("contains no banned honesty words in the rendered output", () => {
    const html = render(HORSE_CARD_OK, JOCKEY_CARD_OK, { intuition: "anchor" });
    for (const re of BANNED) expect(html).not.toMatch(re);
  });
});
