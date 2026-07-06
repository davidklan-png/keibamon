// Routine capture-outage recovery — insert lake-sourced race results into the
// `race_results` archive so the next 5-minute settle sweep (workers/social/
// src/sweep.ts) can settle any stranded OPEN tickets via the #15 fallback pass.
//
// History + motivation. This script began as a one-shot patch for the 2026-06-
// 28 capture outage: 20 tickets stranded open because /api/live had already
// rotated to the next weekend's card before the producer re-published the
// results, and the sweep could only settle against /api/live. Three of those
// tickets (kb-mqwyu29w / u4ms / ueff) had no settle_result_hash at all and
// were patched directly via this script's predecessor — see
// docs/prompts/backfill-stuck-june28-tickets.md for the incident shape.
//
// #15 (docs/prompts/sweep-results-archive.md) made that workaround structural:
// the sweep now maintains a `race_results` archive of every result block it
// sees, plus a fallback pass that joins OPEN tickets to that archive. So the
// recovery path for a future capture outage is no longer "patch ticket rows"
// (which duplicates settlement logic and bypasses the R3 hash bookkeeping) —
// it's "insert the missing result rows into race_results and let the next
// sweep settle them through the same code path as everything else."
//
// Settlement logic then lives in exactly one place: workers/social/src/settle.ts
// (the resolver) + sweep.ts (the driver). This script only feeds inputs.
//
// Input shape. A JSON object mapping race_key → RaceResult, exactly what
// tools/jravan/backfill_20260628_results.py emits when it pulls results from
// the lake. See `RaceResult` in workers/social/src/settle.ts for the shape;
// see sweep.ts::raceKeyOf for how race_key is built (date|venue|race_no|name).
//
// Safety:
//   - DRY RUN by default: prints each INSERT it WOULD execute, with the
//     computed hash, without touching D1. Pass --apply to write.
//   - Hash-gated upsert (mirrors archiveResults() in sweep.ts): if
//     race_results already has this race_key with the SAME hash, the row is
//     a no-op. If the hash differs, the row is updated (R3 re-settlement path
//     handles the correction on the next sweep). Either way, idempotent.
//   - source is always 'backfill' — distinct from the sweep's own 'sweep'
//     source so an operator reading the table can tell archive rows that
//     came from the recovery importer vs. the steady-state sweep.
//   - Reads + writes via `wrangler d1 execute --remote` (reuses the Mac's
//     existing wrangler auth — no separate API token handling here). Never
//     prints CF_* secrets.
//
// Runbook (capture outage → stranded tickets):
//   1. On the Mac, build the results JSON from the lake:
//        python3 tools/jravan/backfill_20260628_results.py > /tmp/results.json
//      (adjust the script or write a sibling for the new outage's dates —
//      it's a template, not a perpetual tool)
//   2. DRY RUN:
//        cd workers/social
//        npx tsx scripts/backfill-stuck-tickets.ts --results /tmp/results.json
//   3. Eyeball the printed INSERTs (race_keys, hashes, source='backfill').
//   4. APPLY:
//        npx tsx scripts/backfill-stuck-tickets.ts --results /tmp/results.json --apply
//   5. Wait ≤ 5 min for the next settle-sweep cron tick. Verify via:
//        npx wrangler d1 execute keibamon_social --remote --command \
//          "SELECT id, state, settle_result_hash FROM tickets \
//           WHERE race_key IN ('<key>', ...) ORDER BY id"
//      Open tickets should flip to won/miss/refunded; settle_result_hash
//      should now be populated. If they don't, check the Worker tail for
//      `settleSweep: ... [archive]` log lines.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { hashResult, type RaceResult } from "../src/settle";

const DB_NAME = "keibamon_social";

function parseArgs(argv: string[]) {
  const apply = argv.includes("--apply");
  const idx = argv.indexOf("--results");
  const resultsPath =
    idx >= 0 && argv[idx + 1] ? argv[idx + 1] : "/tmp/backfill_results.json";
  return { apply, resultsPath };
}

/** Shell out to `wrangler d1 execute --remote` (no --json; output to stdio). */
function d1Exec(sql: string): void {
  execFileSync(
    "npx",
    ["wrangler", "d1", "execute", DB_NAME, "--remote", "--command", sql],
    { encoding: "utf-8", stdio: "inherit" },
  );
}

/** Single-quote a SQL string literal (escape embedded single quotes). */
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

  const raceKeys = Object.keys(resultsByRaceKey);
  if (raceKeys.length === 0) {
    console.log("No results in input file; nothing to do.");
    return;
  }

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const raceKey of raceKeys) {
    const result = resultsByRaceKey[raceKey];
    const hash = await hashResult(result);
    const resultJson = JSON.stringify(result);
    const now = Date.now();

    // Hash-gated upsert — mirrors archiveResults() in sweep.ts. ON CONFLICT
    // updates result_json/result_hash/source/archived_at ONLY when the hash
    // differs, so re-running this script with the same input is a no-op.
    const sql =
      `INSERT INTO race_results (race_key, result_json, result_hash, source, archived_at)\n` +
      `VALUES (${sqlQuote(raceKey)}, ${sqlQuote(resultJson)}, ${sqlQuote(hash)}, 'backfill', ${now})\n` +
      `ON CONFLICT(race_key) DO UPDATE\n` +
      `  SET result_json = excluded.result_json,\n` +
      `      result_hash = excluded.result_hash,\n` +
      `      source = excluded.source,\n` +
      `      archived_at = excluded.archived_at\n` +
      `  WHERE race_results.result_hash != excluded.result_hash`;

    console.log(`--- ${raceKey} ---`);
    console.log(`  hash: ${hash}`);
    console.log(`  source: backfill`);

    if (apply) {
      try {
        d1Exec(sql);
        console.log("  inserted/updated.");
        // We can't tell from wrangler's stdout whether it was an INSERT vs an
        // UPDATE vs a no-op (the changes count isn't reliably parsed), so we
        // count attempted writes. Re-running with the same input is safe.
        inserted++;
      } catch (e) {
        console.error(`  FAILED: ${(e as Error).message}`);
        process.exitCode = 1;
      }
    } else {
      console.log(`  SQL:\n${sql}`);
      skipped++;
    }
    console.log("");
  }

  if (apply) {
    console.log(
      `Done. ${inserted} race(s) upserted into race_results (source='backfill').\n` +
        `The next settle-sweep cron tick (≤ 5 min) will settle any OPEN tickets\n` +
        `for these races via the fallback pass. Verify with:\n` +
        `  npx wrangler d1 execute ${DB_NAME} --remote --command \\\n` +
        `    "SELECT id, state, settle_result_hash FROM tickets WHERE race_key IN (...)"`,
    );
  } else {
    console.log(
      `Dry run complete. ${skipped} race(s) would be upserted. Re-run with --apply to write.`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
