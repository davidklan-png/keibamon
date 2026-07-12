/**
 * Build the friend-invite deep-link URL. Pure + unit-tested; callers pass the
 * runtime origin + vite base.
 *
 * The racing app is served at the vite base path (`/app/`, exposed as
 * `import.meta.env.BASE_URL`), NOT the site root — so an invite must land at
 * `<origin>/app/?friend=<handle>`. Links built from `origin` alone land on the
 * splash page and never reach the app's invite resolver (useInvite reads
 * `window.location.search`). The splash worker also forwards `/?friend=` →
 * `/app/?friend=` as a safety net for links already in the wild.
 *
 * `baseUrl` always carries a trailing slash (vite guarantees `"/app/"`), so no
 * extra "/" is inserted before the query string.
 */
export function buildInviteUrl(
  handle: string,
  baseUrl: string,
  origin: string,
): string {
  return `${origin}${baseUrl}?friend=${encodeURIComponent(handle)}`;
}
