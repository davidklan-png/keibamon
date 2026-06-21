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

// ===========================================================================
// ADR-0007: "My Tickets" — a committed bet wraps a recommender Ticket with
// lifecycle + identity. Phase 0 persists to localStorage; Phase 2 moves this
// server-side (Clerk user + social D1). Live odds/result are re-matched from
// /api/live by RaceSnapshot.raceKey.
// ===========================================================================
export type CommittedState = "open" | "won" | "miss";

/** Frozen at commit time; live fields refreshed by matching raceKey in /api/live. */
export interface RaceSnapshot {
  raceKey: string; // date|venue|race_no|name (App.tsx keyFor)
  grade: string; // "G1" (may be empty)
  nameEn: string;
  nameJa: string;
  venueEn: string;
  venueJa: string;
  raceNo: number;
  dateEn: string; // localized display strings
  dateJa: string;
  post: string; // "15:40"
  runners: { num: number; en: string; ja: string; odds: number }[];
}

/** A community owner other than the signed-in user (Phase 3: from the social graph). */
export interface TicketOwner {
  en: string;
  ja: string;
  color: string;
  initial: string;
  initialJa: string;
}

/**
 * Phase 3: the server-side flat user shape returned alongside tickets in the
 * feed and on the profile endpoint. NEVER carries clerk_user_id / email /
 * age_verified — those stay on the Worker.
 */
export interface PublicUser {
  id: string;
  handle: string | null;
  display_name: string | null;
  avatar: string | null;
}

/** Phase 3 palette used by ownerFromUser — stable per user.id hash. */
const OWNER_COLORS = ["#FF6A6A", "#2D8CF0", "#E59A14", "#15A862", "#9B59B6", "#1ABC9C"];

/**
 * Phase 3 (Decision 9): client-side derivation of a TicketOwner from a flat
 * PublicUser. Keeps the owner shape compatible with Phase 0/2 hardcoded owners
 * (`Rin/リン`) and avoids duplicating i18n-aware fields in the DB.
 *
 * The color is picked by a deterministic hash of `user.id` so a given user
 * always renders with the same swatch (stable across feeds/devices).
 */
export function ownerFromUser(user: PublicUser): TicketOwner {
  const display = user.display_name || user.handle || "player";
  const initial = display.charAt(0).toUpperCase() || "?";
  // Latin / kana are both single-codepoint at char(0); for CJK we fall back
  // to the same char (it renders fine in the avatar circle).
  const initialJa = initial;
  let hash = 0;
  for (let i = 0; i < user.id.length; i++) {
    hash = (hash * 31 + user.id.charCodeAt(i)) | 0;
  }
  const color = OWNER_COLORS[Math.abs(hash) % OWNER_COLORS.length];
  return { en: display, ja: display, color, initial, initialJa };
}

export interface CommittedTicket {
  id: string; // "kb-" + base36 timestamp
  serial: string; // "KB-XXXXXX" (display only)
  ticket: Ticket; // the recommender output (type, lines, cost, avgPayout, unit…)
  unit: number; // chosen stake per line
  mood: MoodKey; // snapshot of moodKey(ticket) at commit
  state: CommittedState;
  payoutBase: number; // "if it hits" estimate at commit
  returned?: number; // settled payout (won)
  race: RaceSnapshot;
  owner: "you" | TicketOwner;
  claps: number;
  /** Phase 3: server-side cheers count (authoritative when present). */
  cheers?: number;
  /** Phase 3: did the signed-in viewer cheer this ticket? */
  cheeredByMe?: boolean;
  /** Phase 3: flat owner object from the social Worker (feed/profile path). */
  ownerUser?: PublicUser;
  createdAt: number;
}
