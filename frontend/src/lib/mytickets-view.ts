// ============================================================================
// My Tickets — view-model helpers (ADR-0007 Phase 5 extraction).
// Pure functions + statics lifted out of App.tsx so the screen components stay
// small. No closures over React state; everything takes its inputs explicitly.
// ============================================================================
import type {
  MoodKey,
  CommittedState,
  CommittedTicket,
  PersonalityId,
  RaceSnapshot,
} from "./types";
import type { BetType, Runner } from "./fairvalue";
import type { LiveSnapshot, LiveRace } from "../api";
import { storageKeyFor } from "../auth/storageKey";

export type MtView = "feed" | "new" | "detail" | "profile";
export type DriftDir = "firm" | "drift" | "steady";

export const MT_MOOD_COLOR: Record<MoodKey, string> = {
  safer: "var(--turf)",
  balanced: "var(--sky)",
  spicier: "var(--coral)",
};

export const MT_VIBES: { mood: MoodKey; pid: PersonalityId }[] = [
  { mood: "safer", pid: "safe" },
  { mood: "balanced", pid: "balanced" },
  { mood: "spicier", pid: "longshot" },
];

export function mtStateColor(s: CommittedState): string {
  return s === "open"
    ? "var(--turf)"
    : s === "won"
      ? "var(--gold-amber)"
      : s === "refunded"
        ? "var(--soft)"
        : "var(--miss)";
}

/** Phase 3 — deterministic avatar color from a string (handle/display name). */
export const AVATAR_COLORS = ["#FF6A6A", "#2D8CF0", "#E59A14", "#15A862", "#9B59B6", "#1ABC9C"];
export function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

export function mtSep(type: BetType): string {
  return type === "exacta" || type === "trifecta" ? " › " : " – ";
}

export function mtRaceKey(race: LiveRace, fallbackDate?: string): string {
  const date = race.date ?? fallbackDate ?? "";
  return `${date}|${race.venue ?? ""}|${race.race_no}|${race.name ?? ""}`;
}

export function mtFmtDate(date: string, lang: "en" | "ja"): string {
  if (!date) return "";
  const normalized = /^\d{8}$/.test(date)
    ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`
    : date;
  const parsed = new Date(`${normalized}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return new Intl.DateTimeFormat(lang === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(parsed);
}

/** ADR-0006: a race is "open" once any runner carries a live (non-estimated) price. */
export function raceHasLiveOdds(race: LiveRace): boolean {
  if (race.status) return race.status === "open" || race.status === "result";
  return (race.runners || []).some((r) => (r.win_odds || 0) > 0);
}

export function mtPickFeature(snap: LiveSnapshot | null): LiveRace | null {
  const races = (snap?.races || []).filter((r) => (r.runners || []).length > 0);
  if (races.length === 0) return null;
  const open = races.filter((r) => raceHasLiveOdds(r));
  const pool = open.length > 0 ? open : races;
  return (
    pool.find((r) => /g1|takarazuka/i.test(r.name || "")) ||
    pool[pool.length - 1]
  );
}

export function mtRunnersOf(race: LiveRace): Runner[] {
  return (race.runners || []).map((r) => ({
    uma: String(r.umaban),
    name: r.name ?? null,
    odds: (r.win_odds ?? r.win_odds_est ?? 0) as number,
    // Pass through 枠 (bracket) so the manual-ticket-builder can price
    // 枠連 (bracket_quinella) over the live field. null/absent when the
    // entries scrape hasn't published the draw yet — the builder simply
    // disables the 枠連 bet-type chip in that case.
    gate: (r.gate ?? null) as number | null,
  }));
}

/**
 * Freeze a race into a RaceSnapshot at commit time. Extracted here so the
 * TicketsScreen "Place" CTA and the MyTickets "commit" path share one
 * definition (ADR-0007 race-first loop). `fallbackDate` is the snapshot's
 * meta.date, used when the race row doesn't carry its own date.
 */
export function snapshotRace(race: LiveRace, fallbackDate?: string): RaceSnapshot {
  const date = race.date ?? fallbackDate ?? "";
  return {
    raceKey: mtRaceKey(race, fallbackDate),
    grade: race.grade_label ?? "",
    nameEn: race.name ?? "",
    nameJa: race.name ?? "",
    venueEn: race.venue ?? "",
    venueJa: race.venue ?? "",
    raceNo: race.race_no,
    dateEn: mtFmtDate(date, "en"),
    dateJa: mtFmtDate(date, "ja"),
    post: race.post_time ?? "",
    runners: (race.runners || []).map((r) => ({
      num: r.umaban,
      en: r.name ?? "",
      ja: r.name ?? "",
      odds: (r.win_odds ?? r.win_odds_est ?? 0) as number,
    })),
  };
}

export function mtLoadStored(lang: string, userId: string | null): CommittedTicket[] {
  try {
    // ADR-0007 Phase 1 — namespaced per Clerk user when signed in. Signed-out
    // falls back to the Phase 0 sample key so the pre-auth visual still has
    // something to show. Phase 2 will replace this with the social D1.
    const raw = localStorage.getItem(storageKeyFor(lang, userId));
    const parsed = raw ? (JSON.parse(raw) as CommittedTicket[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
