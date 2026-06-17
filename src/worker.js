// Keibamon Cloudflare Worker.
//
// Serves the static splash assets (./splash, incl. live.html) and adds one
// dynamic route, /api/live, that returns the current race-day snapshot from the
// keibamon-live D1 database. The live dashboard page (splash/live.html) fetches
// /api/live every 45s. Static assets take precedence; the Worker only runs for
// paths that aren't files, so / and /live.html are served directly by assets.
//
// Bindings (see wrangler.jsonc): DB = keibamon-live D1; ASSETS = ./splash.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/helper") {
      return env.ASSETS.fetch(new Request(new URL("/helper.html", url), request));
    }

    if (url.pathname === "/live") {
      return env.ASSETS.fetch(new Request(new URL("/live.html", url), request));
    }

    if (url.pathname === "/api/live") {
      const headers = {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      };
      try {
        const row = await env.DB
          .prepare("SELECT payload FROM live_snapshot WHERE key = 'hanshin'")
          .first();
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
