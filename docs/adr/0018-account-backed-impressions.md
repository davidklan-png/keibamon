# ADR-0018: Account-backed impression marks

- **Status:** Accepted
- **Date:** 2026-07-02
- **Surface:** Frontend (auth/impressionsSync.ts, App.tsx) + Worker (social/src/index.ts + migration 0006)
- **Companion:** `docs/ux-audit-netkeiba.md` (§4 — the "save your marks" promise), `docs/ux-implementation-plan.md` (Session 5b); builds on [ADR-0011](0011-research-and-ticket-restructure.md), [ADR-0013](0013-signed-out-my-tickets-empty-state.md), [ADR-0016](0016-inline-runner-marks.md)

## Summary

The signed-out My Tickets empty state (ADR-0013) promises "sign in to save your marks." Until this ADR, that promise was a lie: impression marks lived only in localStorage (`kbm.impressions.v1`) and signing in did nothing to them. This ADR makes the promise true and gives marks cross-device continuity. When a user signs in, their local marks union with the server's (last-writer-wins on `formed_at`); while signed in, every change is debounced-PUT to the server; signing out leaves local marks untouched (device-local research continues).

## Decision

**A new `user_impressions` table in the social D1** (migration `0006_user_impressions.sql`). Schema mirrors the client `ImpressionMap` 1:1:

```
user_impressions(
  user_id TEXT REFERENCES users(id),
  comp_key TEXT,                          -- `${race_id}|${horse_key}` from the client store
  mark TEXT,                              -- 'like' | 'distrust' | 'priceHorse' | 'avoid' | 'anchor'
  umaban INTEGER,
  odds_when_marked REAL,
  odds_snapshot_at TEXT,
  formed_at INTEGER NOT NULL,             -- ms epoch; client-stamped; the LWW tiebreaker
  updated_at INTEGER NOT NULL,            -- ms epoch; server-stamped on each PUT
  PRIMARY KEY (user_id, comp_key)
)
```

`comp_key` is treated as opaque server-side (the key shape is the existing `${race_id}|${normalizeName(horse_name)}` from `lib/impressions.ts`). The PRIMARY KEY enforces "at most one mark per (user, horse-in-a-race)" without extra app code.

**Two new endpoints, mirroring the existing `/api/social/me` auth pattern (Clerk JWT via `verifyToken` + `ensureCaller` upsert):**

- `GET /api/social/me/impressions` → `{ impressions: Row[] }` — the caller's full map.
- `PUT /api/social/me/impressions` (body: `{ impressions: ImpressionMap }`) → `{ ok: true }` — **transactional full-replace** via a D1 `batch([DELETE, ...INSERTs])`. Full-replace (not per-key upsert) is the deliberate choice: it makes a locally-cleared mark propagate server-side without tombstones. The map is small (a season's worth of marks is hundreds of entries), so the N-row INSERT is cheap and bounded (validated at ≤5000 rows per PUT).

Validation rejects: empty/non-object body (`bad_body`), non-`IntuitionKind` mark (`bad_mark`), empty `comp_key` (`bad_comp_key`), non-numeric `formed_at` (`bad_formed_at`). Auth branching mirrors every other `/me/*` route: missing/invalid Bearer → 401; non-GET/PUT → 405.

**A new client module `frontend/src/auth/impressionsSync.ts` carries three pieces:**

1. **Pure LWW merge** (`mergeImpressions(local, server) → ImpressionMap`). For each `comp_key` in the union, keep the entry with the larger `formed_at`. **Ties prefer the LOCAL entry** — the user's device is the source of truth for "what they just did", and a tie means the server clock and client clock agreed on the same millisecond (rare; the local write is the more recent intent). The function is pure (no I/O, no React) so the LWW contract is pinned in isolation.

2. **Thin I/O wrappers** (`getMyImpressions`, `putMyImpressions`) using the same authed-fetch pattern as `socialClient.ts` — typed result (`{ ok: true, data } | { ok: false, err: SocialError }`), no UI surface for failures.

3. **A `useImpressionsSync(impressions, setImpressions, auth)` React hook** — the only wiring `App.tsx` needs. It is **observer-only**:
   - **On sign-in transition** (false → true): `GET → mergeImpressions(local, server) → setImpressions(merged) → PUT merged`. One-time per session; re-runs after a sign-out/sign-in cycle. The merge result replaces App's state so the UI immediately reflects the cross-device union.
   - **While signed in**: a debounced (2s) best-effort PUT of the full map on every `impressions` change. Mirrors the `ticketQueue` offline-tolerance pattern: failure = silent retry on next change, **no UI error surface**.
   - **On sign-out**: nothing — local marks are NOT wiped (device-local research stays put, matching the current product behavior since ADR-0011 Phase 1).

The hook does NOT fork the store. The `RunnerMark` / `HorseDrillView` write paths (`setImpression` → `setImpressions` → save-effect → localStorage) are untouched. Sync is purely an observer of the impressions state.

## Scope boundary (what this ADR does NOT do)

- **The store shape is unchanged.** `ImpressionMap` is still `Record<comp_key, Impression>`; `kbm.impressions.v1` localStorage remains the canonical signed-out store and the offline cache when signed in.
- **The write paths are unchanged.** `setImpression` / `clearImpression` / `clearRace` from `lib/impressions.ts` are not modified; `RunnerMark.tsx` and `HorseDrillView`'s IntuitionMarks chips call them exactly as before.
- **No per-key tombstones.** A cleared mark is a missing row server-side, not a `mark=null` row. Full-replace at PUT propagates clears atomically without a tombstone column or a CRDT.
- **No multi-device realtime push.** The hook syncs on sign-in (one-shot GET+merge) and on local change (debounced PUT). It does NOT poll the server while signed in — a mark made on device A does not appear on device B until device B's next sign-in. A future Phase could add a polling GET (the 45s social-feed pattern is the template); this ADR deliberately ships the minimum that fulfills the ADR-0013 promise.
- **No retry queue.** A failed PUT is silently retried on the next change. This differs from `ticketQueue` (which holds a localStorage backlog) — the difference is intentional: ticket POSTs are one-shot non-idempotent commits that must not be lost, while impressions PUTs are idempotent full-replaces where the next change naturally re-surfaces the full state.

## The pre-sign-in-clear edge case (accepted, documented)

If a user clears a mark locally **before** signing in, and that same mark still exists server-side (because it was previously synced from another device), the LWW merge at sign-in will resurrect it. The behavior falls out of the union semantics: the server's entry has a `formed_at` and the local map no longer has the key at all, so the union keeps it.

**Why we accept this:** the edge requires a specific multi-device sequence (sync from device A, clear on device B without signing in, then sign in on device B) that's rare in practice for a single-device research flow. The full-replace PUT immediately after the merge makes the *next* clear stick. The alternative (tracking per-key clears with timestamps) is a CRDT and is more machinery than the promise warrants.

The ADR-0013 "sign in to save your marks" promise is fulfilled: every mark visible to the user after sign-in is durably server-backed. The edge is about *which* marks are visible, not whether they're saved.

## Consequences

- The ADR-0013 promise becomes true: signing in saves your marks and surfaces marks made on other devices.
- `selectedRace` / `raceId` / `impressions` state in `App.tsx` is now load-bearing for the sync hook. The hook is observer-only — it reads + writes `setImpressions`, but the write happens exactly once per sign-in (the merge) and is a pure function of the inputs.
- The migration adds one table + one index to the social D1. The deploy package (run by David on mac-dev, per the repo convention that remote deploy is gated):
  - `cd workers/social && npx wrangler d1 migrations apply keibamon_social --remote`
  - `cd workers/social && npx wrangler deploy`
  - The migration is forward-only (CREATE TABLE IF NOT EXISTS); no data backfill is needed since the table starts empty and fills on the user's next sign-in.
- The client sends the FULL local map on every PUT while signed in. This is fine for a research tool (maps stay small — hundreds of entries per season at <200 bytes each = ~100KB max), but it does mean a single mark toggle resends the whole map. The debounce (2s) coalesces a marking burst into one PUT. A future optimization could switch to per-key PATCH/DELETE if volume ever justified it; for now full-replace wins on simplicity.
- `useImpressionsSync` lives in `App.tsx`'s render path and is therefore untested at the component level (per the ADR-0015 carve-out — `App.tsx` carries ~10 `useEffect` hooks and a fetch-on-mount and is excluded from the snapshot pattern by `app.snapshot.test.ts`). The contract is pinned instead by:
  - `auth/impressionsSync.test.ts` (20 tests) — pure LWW merge semantics, `rowsToMap` conversion edge cases, fetch wrapper behavior (success/network/http/no-token/body-malformed).
  - `workers/social/test/impressions.test.ts` (15 tests) — auth branching (401 GET/PUT, 405 POST), GET empty, PUT roundtrip, full-replace semantics (PUT A then PUT B → only B), PUT-empty clears, validation (bad_mark/bad_body/bad_formed_at/bad_comp_key), ownership isolation (A's marks invisible to B), NULL-field acceptance.
- No new i18n strings — the sync is invisible to the user (no toast on success, no error on failure). The existing ADR-0013 "sign in to save your marks" copy is now accurate where before it was aspirational.
- No Playwright visual baseline drift — sync is behavior-only; nothing visible changes on any captured surface.
