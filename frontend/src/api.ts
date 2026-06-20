/** Tiny fetcher for the existing /api/live snapshot. No external deps. */

export interface LiveRunner {
  umaban: number;
  name?: string | null;
  /** Live pari-mutuel win odds; null/absent until the pool opens. */
  win_odds?: number | null;
  /** Estimated odds shown while there is no live price (ADR-0006). */
  win_odds_est?: number | null;
  /** True iff win_odds is a real live price (not an estimate). */
  odds_is_live?: boolean;
}

/** Race lifecycle the app renders against (ADR-0006). */
export type RaceStatus = "registered" | "open" | "result";

export interface LiveRace {
  race_no: number;
  name?: string | null;
  post_time?: string | null;
  venue?: string | null;
  status?: RaceStatus;
  runners?: LiveRunner[];
}

export interface LiveSnapshot {
  meta?: { status?: string; message?: string; updated_at?: string };
  races?: LiveRace[];
}

export async function fetchLiveSnapshot(): Promise<LiveSnapshot> {
  const res = await fetch("/api/live", { cache: "no-store" });
  if (!res.ok) throw new Error(`live snapshot HTTP ${res.status}`);
  return (await res.json()) as LiveSnapshot;
}

const SEED_NAMES = [
  "Market Star",
  "Rail Runner",
  "Late Kick",
  "Turf Logic",
  "Deep Closer",
  "Gold Tempo",
  "Quiet Form",
  "Wide Draw",
  "Storm Line",
  "Pocket Trip",
  "Green Signal",
  "Long Fuse",
  "Fast Return",
  "Night Odds",
  "Sharp Bend",
  "Final Call",
  "Lucky Gate",
  "Blue Turn",
];

/** Manual-entry seed matching helper.html's pattern. */
export function seedManualRunners(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    uma: String(i + 1),
    name: SEED_NAMES[i] ?? null,
    odds: Number((2.1 + i * 1.35 + (i % 3) * 0.7).toFixed(1)),
  }));
}
