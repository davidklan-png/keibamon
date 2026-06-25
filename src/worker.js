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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/helper") {
      return env.ASSETS.fetch(new Request(new URL("/helper.html", url), request));
    }

    if (url.pathname === "/live") {
      return env.ASSETS.fetch(new Request(new URL("/live.html", url), request));
    }

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
};
