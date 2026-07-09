// Client-side ticket id generation.
//
// Historically this was `"kb-" + Date.now().toString(36)` inlined at each call
// site. That made ids GUESSABLE: a `kb-` + base36 timestamp is a small search
// space an attacker could brute-force, and combined with the pre-fix
// insertTicket (which checked only `state`, not `user_id`, on the upsert) a
// guessed OPEN id let another user silently overwrite a victim's ticket
// payload. `crypto.randomUUID()` gives 122 bits of entropy — unguessable — and
// the server now rejects cross-user upserts regardless (defense in depth).
//
// `created_at` (not the id) is the ordering column everywhere; nothing parses
// structure out of the id, so the format is free to be opaque. The `kb-`
// prefix is retained because the 0002 migration comment documents it.
export function newTicketId(): string {
  return `kb-${crypto.randomUUID()}`;
}
