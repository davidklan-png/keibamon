// Keibamon Cloudflare Worker.
//
// Serves the static splash assets (./splash, incl. live.html) and adds two
// dynamic route groups:
//   - /api/live — the current race-day snapshot from the keibamon-live D1
//     database (the live dashboard fetches this every 45s).
//   - /api/{horses|jockeys|races}/.../form — the Milestone-4 form/context
//     panel, served from the dedicated keibamon_form D1. The handler lives in
//     src/form/ (TypeScript); Wrangler's esbuild resolves the import at build
//     time.
// Static assets take precedence; the Worker only runs for paths that aren't
// files, so / and /live.html are served directly by assets.
//
// Bindings (see wrangler.jsonc):
//   DB     = keibamon-live D1 (live_snapshot table)
//   FORM   = keibamon_form D1 (form_starts table; separate DB so a form
//            rebuild can never risk the live snapshot)
//   ASSETS = ./splash

import { handleFormRoutes } from "./form/index";
import { handleWeeklyReportRoutes } from "./reference/weekly";
import { buildLiveEdition, LIVE_VERSION, snapshotFreshness } from "./reference/buildLiveEdition";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // /app (no trailing slash) → /app/. The racing app shell lives at /app/;
    // without this the assets binding serves blank for the bare path. 308 so
    // the redirect preserves method (GET→GET) and caches permanently.
    if (url.pathname === "/app") {
      const redirect = new URL(url);
      redirect.pathname = "/app/";
      return Response.redirect(redirect.toString(), 308);
    }

    // /?friend=<handle> (splash) → /app/?friend=<handle>. Invite links built
    // before the /app/ base fix land on the splash page and never reach the
    // app's invite resolver (useInvite reads window.location.search). Forward
    // them to the app shell, preserving the param exactly. 307 (temporary) so
    // iteration can't get pinned by a browser permanent-redirect cache.
    // `new URL(url)` keeps search + hash, so only the pathname changes.
    if (url.pathname === "/" && url.searchParams.has("friend")) {
      const redirect = new URL(url);
      redirect.pathname = "/app/";
      return Response.redirect(redirect.toString(), 307);
    }

    if (url.pathname === "/helper") {
      return env.ASSETS.fetch(new Request(new URL("/helper.html", url), request));
    }

    if (url.pathname === "/live") {
      return env.ASSETS.fetch(new Request(new URL("/live.html", url), request));
    }

    // Weekly graded-stakes report (src/reference/). Returns null on non-match
    // so the request falls through. Returns { status: "empty" } when the D1
    // table is absent/empty so the frontend renders the no-data empty state
    // (cadence + real upcoming graded stakes from /api/live).
    const weeklyRes = await handleWeeklyReportRoutes(request, env);
    if (weeklyRes) return weeklyRes;

    // Form panel routes (src/form/). Returns null on non-match so the request
    // falls through to /api/live or the static-assets fallback below.
    const formRes = await handleFormRoutes(request, env);
    if (formRes) return formRes;

    if (url.pathname === "/api/live") {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      };
      try {
        // ADR-0006: the registration feed publishes under key='current' (all
        // registered races across venues for the active day). Fall back to the
        // legacy single-card key='hanshin' so an old publisher still works.
        const requested = url.searchParams.get("key");
        const keys = requested ? [requested] : ["current", "hanshin"];
        let row = null;
        for (const k of keys) {
          row = await env.DB
            .prepare("SELECT payload FROM live_snapshot WHERE key = ?")
            .bind(k)
            .first();
          if (row && row.payload) break;
        }
        if (row && row.payload) {
          return new Response(row.payload, { headers });
        }
        return new Response(
          JSON.stringify({
            meta: { status: "standby", message: "No snapshot published yet." },
            races: [],
          }),
          { headers }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({
            meta: { status: "error", message: String(err && err.message || err) },
            races: [],
          }),
          { status: 500, headers }
        );
      }
    }

    // Everything else: serve from the static-assets binding (splash/).
    return env.ASSETS.fetch(request);
  },

  // -------------------------------------------------------------------------
  // scheduled — ADR-0010 rolling live roundup edition.
  //
  // Every 5 minutes (per wrangler.jsonc triggers.crons), read the latest
  // live_snapshot (key='current'), turn its graded races into a WeekendInput
  // via buildLiveEdition, and UPSERT it as version LIVE_VERSION (90) under
  // the weekend's edition_key. The single rolling row joins the same edition
  // as the manual Friday/Saturday publishes; the read path's ORDER BY version
  // DESC surfaces it as the latest.
  //
  // STALENESS GUARD — buildLiveEdition refuses to build when the snapshot's
  // heartbeat (meta.published_at) is older than MAX_SNAPSHOT_STALENESS_MS
  // (20min). On a stalled producer the existing v90 row freezes in place
  // rather than being republished with stale odds under a fresh-looking
  // "auto-refreshed" label. The handler emits a console.warn so the stall is
  // visible in wrangler tail; the routine no-graded/off-day no-op stays silent.
  //
  // SAFETY — a scheduled run MUST NEVER throw. Every step is wrapped in
  // try/catch and a no-graded/no-snapshot/malformed/stale case is a no-op
  // (returns without writing). The handler never DELETEs; the only write is
  // the INSERT ... ON CONFLICT UPDATE below, which can only update row
  // (edition_key, LIVE_VERSION) and never touches manual v1/v2/etc. A bad
  // snapshot therefore can't blank existing editions — it simply fails to
  // upsert.
  //
  // `event` is unused (no cron-rerun semantics needed); `ctx` is unused (no
  // waitUntil — work completes inline). Both are required by the Workers
  // scheduled signature. `now` is an optional test-injection knob — the
  // Workers runtime passes exactly 3 args, so production defaults to
  // `new Date()`; tests pass a fixed instant for determinism.
  // -------------------------------------------------------------------------
  async scheduled(event, env, ctx, now = new Date()) {
    try {
      if (!env || !env.DB) return;
      const row = await env.DB
        .prepare("SELECT payload FROM live_snapshot WHERE key = ?")
        .bind("current")
        .first();
      if (!row || !row.payload) return;

      let snapshot;
      try {
        snapshot = JSON.parse(row.payload);
      } catch {
        // Malformed payload in the snapshot table — no-op, don't crash.
        return;
      }

      const live = buildLiveEdition(snapshot, now);
      if (!live) {
        // Distinguish "stalled producer" (snapshot heartbeat older than
        // MAX_SNAPSHOT_STALENESS_MS) from the routine no-graded/off-day no-op.
        // Both freeze the existing v90 row in place; only staleness is a
        // health signal worth surfacing via wrangler tail.
        if (snapshotFreshness(snapshot, now) === "stale") {
          console.warn(
            "scheduled live-edition skipped: snapshot stale (producer stalled?)",
          );
        }
        return;
      }

      const payload = JSON.stringify(live);
      // UPSERT the rolling row. ON CONFLICT(edition_key, version) requires the
      // PRIMARY KEY from migrations/keibamon-live/0002_weekly_report.sql. The
      // manual v1/v2 rows have different versions and are left untouched.
      await env.DB
        .prepare(
          `INSERT INTO weekly_report (edition_key, version, payload, published_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(edition_key, version) DO UPDATE SET
             payload = excluded.payload,
             published_at = excluded.published_at`,
        )
        .bind(live.edition_key, LIVE_VERSION, payload, live.published_at)
        .run();
    } catch (err) {
      // Last-resort swallow — a transient D1 error, a schema drift, anything.
      // Observability picks it up via wrangler tail; users see the prior tick.
      console.error("scheduled live-edition publish failed", err);
    }
  },
};
