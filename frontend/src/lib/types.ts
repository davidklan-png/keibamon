import type { BetType, ValueTag } from "./fairvalue";

export type PersonalityId =
  | "safe"
  | "balanced"
  | "longshot"
  | "fan"
  | "antiChalk";

export type IntuitionKind =
  | "like"
  | "distrust"
  | "priceHorse"
  | "avoid"
  | "anchor";

/** Per-horse intuition state. At most one of these per horse (mutually exclusive). */
export type IntuitionState = IntuitionKind | null;

export type Complexity = "auto" | "two" | "three" | "straight";
export type Flavor = "mixed" | "chalk" | "value";

export interface StyleState {
  personality: PersonalityId;
  budget: number;
  unit: number;
  complexity: Complexity;
  flavor: Flavor;
}

/** A single candidate line inside a ticket (one combination). */
export interface TicketLine {
  combo: string[];
  prob: number;
  fairOdds: number;
  payout: number; // est. payout at the user's unit stake
  tag: ValueTag;
}

export interface Ticket {
  id: string;
  type: BetType;
  lines: TicketLine[];
  hitProb: number;
  cost: number;
  expectedReturn: number; // Σ p * payout across lines
  avgPayout: number;
  core: string[]; // distinct umas in the ticket
  tag: ValueTag;
  unit: number;
  variance: "high" | "low";
  /** Plain-language rationale phrases, already localized upstream. */
  rationaleKeys: string[];
}

export interface RecommendInput {
  /** Stable list of all umas in the race (de-vig keys). */
  allUmas: string[];
  /** De-vigged win probabilities keyed by uma. */
  p: Record<string, number>;
  /** Style chosen on the Style screen. */
  style: StyleState;
  /** Intuition tags keyed by uma (null = no tag). */
  intuition: Record<string, IntuitionState>;
}

export const DEFAULT_STYLE: StyleState = {
  personality: "balanced",
  budget: 1200,
  unit: 100,
  complexity: "auto",
  flavor: "mixed",
};

/**
 * ADR-0005 Phase 2: personality is the single "how you want to play" control on
 * the default path. Flavor and complexity are DERIVED from it via this preset so
 * a casual user never reconciles two knobs that can contradict. The raw knobs
 * still exist behind an Advanced disclosure (power users can override after).
 * The engine (`recommender.ts`) is unchanged — it still reads style.flavor /
 * style.complexity; we just stop asking the user to set them directly.
 */
export const PERSONALITY_PRESET: Record<
  PersonalityId,
  { flavor: Flavor; complexity: Complexity }
> = {
  safe: { flavor: "chalk", complexity: "two" },
  balanced: { flavor: "mixed", complexity: "auto" },
  longshot: { flavor: "value", complexity: "three" },
  fan: { flavor: "mixed", complexity: "auto" },
  antiChalk: { flavor: "value", complexity: "two" },
};

/** Select a personality and apply its derived flavor/complexity preset. */
export function applyPersonality(
  style: StyleState,
  id: PersonalityId,
): StyleState {
  return { ...style, personality: id, ...PERSONALITY_PRESET[id] };
}

/**
 * ADR-0005 Phase 3: the default ticket card carries ONE plain mood label instead
 * of the variance + value-tag badges. Derived from the ticket's own properties
 * so it stays honest (no fixed Safe/Balanced/Spicy buckets the engine can't
 * guarantee).
 */
export type MoodKey = "safer" | "balanced" | "spicier";

export function moodKey(t: Ticket): MoodKey {
  if (t.variance === "low") return "safer";
  if (t.variance === "high" && t.tag === "value") return "spicier";
  return "balanced";
}
