// ADR-0007 Phase 2 — offline commit queue.
//
// The UI writes optimistically to local state + cache when the user commits a
// ticket. If the POST to the social Worker fails (offline, 5xx, etc.), the
// CommittedTicket is appended to this queue. On the next signed-in load, the
// queue is flushed BEFORE the GET so the freshly-loaded feed already reflects
// the recovered commit. PATCH (settle / claps) is best-effort and idempotent
// — the settle effect retries on the next /api/live poll, so failed PATCHes
// do not need to live here.
//
// The queue is namespaced per Clerk user id so two accounts on one device
// don't cross-pollinate. Capacity is bounded so a runaway client cannot grow
// the row unbounded; oldest entries are dropped first (FIFO eviction).

import type { CommittedTicket } from "../lib/types";

const MAX_PENDING = 50;

/** localStorage key for a user's pending commits. */
export function pendingKey(userId: string): string {
  return `kbm.pending.${userId}`;
}

interface StoredQueue {
  v: 1;
  items: CommittedTicket[];
}

function safeRead(userId: string | null): StoredQueue | null {
  if (!userId) return null;
  try {
    const raw = localStorage.getItem(pendingKey(userId));
    if (!raw) return { v: 1, items: [] };
    const parsed = JSON.parse(raw) as Partial<StoredQueue>;
    if (!parsed || !Array.isArray(parsed.items)) return { v: 1, items: [] };
    return { v: 1, items: parsed.items };
  } catch {
    return { v: 1, items: [] };
  }
}

function safeWrite(userId: string | null, items: CommittedTicket[]): void {
  if (!userId) return;
  try {
    localStorage.setItem(pendingKey(userId), JSON.stringify({ v: 1, items } as StoredQueue));
  } catch {
    /* quota / private mode — drops silently; the next load re-tries from cache */
  }
}

/** Snapshot of the queue (defensive copy). Empty when signed out. */
export function loadPending(userId: string | null): CommittedTicket[] {
  return safeRead(userId)?.items.slice() ?? [];
}

/** Append a pending commit. Evicts oldest entries beyond MAX_PENDING. */
export function pushPending(userId: string | null, ticket: CommittedTicket): void {
  const q = safeRead(userId);
  if (!q) return;
  // De-dupe by id in case the same commit is queued twice (e.g. double-tap).
  const filtered = q.items.filter((t) => t.id !== ticket.id);
  filtered.push(ticket);
  // FIFO-evict the oldest when over capacity.
  const overflow = filtered.length - MAX_PENDING;
  const items = overflow > 0 ? filtered.slice(overflow) : filtered;
  safeWrite(userId, items);
}

/** Remove every queued entry (called after a successful flush). */
export function clearPending(userId: string | null): void {
  safeWrite(userId, []);
}
