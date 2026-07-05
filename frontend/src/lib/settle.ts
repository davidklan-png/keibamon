// ADR-0007 Phase 4 — frontend re-export shim.
//
// The canonical resolver lives at `workers/social/src/settle.ts` so the
// Worker's cron sweep imports it directly. This file re-exports the same
// symbols so existing call sites (`App.tsx`, `api.ts`, `settle.test.ts`)
// keep working without touching their imports.
//
// Vite + tsc both resolve the cross-directory relative import; the worker
// module is pure (no Cloudflare bindings, no I/O) so it builds cleanly inside
// the frontend bundle. The frontend's richer `Ticket` type (lib/types.ts) is
// structurally compatible with the worker's minimal `ResolveTicket` — only
// `type`, `lines[].combo`, and `avgPayout` are read.

export {
  resolveTicket,
  lineHits,
  isEmptyResult,
  expandPlacings,
  topPlacings,
  type BetType,
  type RaceResult,
  type SettleResult,
  type ResolveTicket,
} from "../../../workers/social/src/settle";
