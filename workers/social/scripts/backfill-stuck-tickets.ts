// Backfill fix (part 2 of 2) — resolve the three orphaned June 28 tickets
// against the results `tools/jravan/backfill_20260628_results.py` fetched,
// and write the settlement to D1.
//
// Background: kb-mqwyu29w, kb-mqwyu4ms, kb-mqwyueff never went through any
// settle path (settle_result_hash is NULL on all three, unlike every other
// ticket on the same two races). `/api/live` no longer carries their race day
// at all, so the normal client-poll / cron-sweep paths can never reach them
// again. This script is the one-time manual equivalent of what the sweep
// would have done, using the SAME resolver (`../src/settle`) so the math is
// identical to production settlement — nothing bespoke.
//
// Safety:
//   - Hardcoded to exactly these 3 ticket ids. Not a general-purpose tool —
//     if you need to backfill different tickets, copy this file, don't widen
//     the constant below.
//   - Refuses to touch a ticket whose current state isn't 'open' (mirrors the
//     `WHERE state = 'open'` guard in patchTicketState / the sweep's own
//     first-settlement path). A ticket that somehow already settled between
//     the investigation and now is left alone.
//   - DRY RUN by default: prints the computed outcome + the exact UPDATE SQL
//     without executing it. Pass --apply to actually run it via `wrangler d1
//     execute --remote`.
//   - Reads via `wrangler d1 execute --remote --json` (reuses the Mac's
//     existing wrangler auth — no separate API token handling in this
//     script).
//
// Usage (from workers/social/):
//   npx tsx scripts/backfill-stuck-tickets.ts \
//     --results /tmp/backfill_20260628_results.json
//   npx tsx scripts/backfill-stuck-tickets.ts \
//     --results /tmp/backfill_20260628_results.json --apply

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  resolveTicket,
  topPlacings,
  hashResult,
  type RaceResult,
  type ResolveTicket,
} from "../src/settle";

const DB_NAME = "keibamon_social";

/** The three orphaned tickets. See the investigation writeup for how these
 * were identified (settle_result_hash NULL while sibling tickets on the same
 * exact races settled fine). */
const TARGET_TICKET_IDS = ["kb-mqwyu29w", "kb-mqwyu4ms", "kb-mqwyueff"] as const;

interface TicketRow {
  id: string;
  race_key: string;
  payload: string;
  state: string;
}

interface TicketPayload {
  ticket?: { type?: string; lines?: { combo: string[] }[]; avgPayout?: number };
  unit?: number;
}

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const idx = argv.indexOf("--results");
  const resultsPath =
    idx >= 0 && argv[idx + 1] ? argv[idx + 1] : "/tmp/backfill_20260628_results.json";
  return { apply, resultsPath };
}

/** Shell out to `wrangler d1 execute --remote --json` and parse the one result set. */
function d1Query(sql: string): Record<string, unknown>[] {
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, "--remote", "--json", "--command", sql],
    { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 },
  );
  // wrangler prints one or more `{results, success, meta}` objects (one per
  // statement) as a JSON array.
  const parsed = JSON.parse(out) as { results?: Record<string, unknown>[] }[];
  return parsed[0]?.results ?? [];
}

function d1Exec(sql: string): void {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, "--remote", "--command", sql],
    { encoding: "utf-8", stdio: "inherit" },
  );
}

function sqlQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

async function main() {
  const { apply, resultsPath } = parseArgs(process.argv.slice(2));
  console.log(`Mode: ${apply ? "APPLY (will write to D1)" : "DRY RUN (no writes)"}`);
  console.log(`Results file: ${resultsPath}\n`);

  const resultsByRaceKey = JSON.parse(readFileSync(resultsPath, "utf-8")) as Record<
    string,
    RaceResult
  >;

  const idList = TARGET_TICKET_IDS.map((id) => sqlQuote(id)).join(", ");
  const rows = d1Query(
    `SELECT id, race_key, payload, state FROM tickets WHERE id IN (${idList})`,
  ) as unknown as TicketRow[];

  if (rows.length !== TARGET_TICKET_IDS.length) {
    const found = new Set(rows.map((r) => r.id));
    const missing = TARGET_TICKET_IDS.filter((id) => !found.has(id));
    console.error(`ERROR: expected ${TARGET_TICKET_IDS.length} tickets, found ${rows.length}.`);
    console.error(`Missing: ${missing.join(", ")}`);
    process.exit(1);
  }

  for (const row of rows) {
    console.log(`--- ${row.id} ---`);
    console.log(`  race_key: ${row.race_key}`);
    console.log(`  current state: ${row.state}`);

    if (row.state !== "open") {
      console.log(`  SKIP — already settled (state=${row.state}); leaving untouched.\n`);
      continue;
    }

    const result = resultsByRaceKey[row.race_key];
    if (!result) {
      console.log(`  SKIP — no result found in ${resultsPath} for this race_key.\n`);
      continue;
    }

    let payload: TicketPayload;
    try {
      payload = JSON.parse(row.payload) as TicketPayload;
    } catch {
      console.log(`  SKIP — malformed payload JSON, needs human triage.\n`);
      continue;
    }
    const ticket = payload.ticket;
    if (!ticket || !ticket.type || !Array.isArray(ticket.lines)) {
      console.log(`  SKIP — payload missing ticket.type/lines.\n`);
      continue;
    }
    const unit = typeof payload.unit === "number" && payload.unit > 0 ? payload.unit : 100;
    const resolveInput: ResolveTicket = {
      type: ticket.type as ResolveTicket["type"],
      lines: ticket.lines,
      avgPayout: typeof ticket.avgPayout === "number" ? ticket.avgPayout : 0,
    };

    const outcome = resolveTicket(resolveInput, unit, result);
    if (outcome.state === "open") {
      console.log(`  SKIP — resolver says this result still isn't official enough to settle.\n`);
      continue;
    }
    const placings = topPlacings(result);
    const hash = await hashResult(result);
    const newReturned = outcome.state === "won" ? outcome.returned : null;

    console.log(`  computed outcome: ${outcome.state}${outcome.state === "won" ? ` (¥${outcome.returned})` : ""}`);
    console.log(`  placings: ${JSON.stringify(placings)}`);
    console.log(`  result hash: ${hash}`);

    const placingsJson = placings ? JSON.stringify(placings) : null;
    const sql =
      `UPDATE tickets SET state = ${sqlQuote(outcome.state)}, ` +
      `returned = ${newReturned === null ? "NULL" : newReturned}, ` +
      `settle_result_hash = ${sqlQuote(hash)}, ` +
      `placings = ${placingsJson === null ? "NULL" : sqlQuote(placingsJson)} ` +
      `WHERE id = ${sqlQuote(row.id)} AND state = 'open'`;
    console.log(`  SQL: ${sql}`);

    if (apply) {
      console.log("  Applying...");
      d1Exec(sql);
      console.log("  Done.");
    }
    console.log("");
  }

  if (!apply) {
    console.log("Dry run complete. Re-run with --apply to write these changes to D1.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
