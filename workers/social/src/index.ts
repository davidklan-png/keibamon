// ADR-0007 — keibamon-social Worker entry point.
//
// Identity (Phase 1) + per-user ticket persistence (Phase 2) + social graph
// (Phase 3: follows, cheers, public profiles, feed, friends-on-race) + block/
// report + cron settle sweep (Phase 4) + account-backed impressions (ADR-0018).
// ISOLATED from the racing Worker:
//   - separate D1 (keibamon_social) — NEVER references keibamon-live
//   - separate origin (Phase 1: *.workers.dev subdomain; custom domain later)
//   - routes live under /api/social/*. /api/live stays on the racing Worker;
//     this Worker returns 404 for everything else.
//
// Module map (mechanical split of the former single-file Worker, 2026-07-08 —
// no behavior change; see docs/codebase-review-2026-07-08.md #5):
//   core.ts        — Env + row types, shared constants, CORS/json helpers
//   auth.ts        — Clerk JWT verification (jose/JWKS), users upsert, ensureCaller
//   tickets.ts     — Phase 2 ticket persistence (parse/insert/decode/patch)
//   social.ts      — Phase 3 social + Phase 4 block/report primitives, feed/profile
//   impressions.ts — ADR-0018 impressions data layer
//   routes.ts      — router + all HTTP handlers
//   settle.ts / sweep.ts — Phase 4 cron settle sweep (predate the split)

import { corsHeaders } from "./core";
import { router } from "./routes";
import { settleSweep } from "./sweep";

// Re-exports kept for compatibility: tests import `{ type Env }` from here,
// and patchTicketState is the documented client-PATCH counterpart of the
// sweep's applySweepSettlement (see sweep.ts).
export type { Env } from "./core";
export { patchTicketState } from "./tickets";

import type { Env } from "./core";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(env, origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    return router(request, env, cors);
  },

  // ADR-0007 Phase 4: cron settle sweep. Trigger every 5 min UTC (see
  // wrangler.jsonc `triggers.crons`). The sweep fetches /api/live from the
  // racing Worker via LIVE_BASE and settles OPEN tickets whose race has
  // reached `status === 'result'`. ctx.waitUntil keeps the request alive
  // past the response so the cron doesn't cut the sweep short.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(settleSweep(env));
  },
};
