# Takarazuka Kinen 2026 — odds capture target

GI, Hanshin 11R, turf 2200 m, Sunday June 14 2026, post time 15:40 JST.
netkeiba race id: `202609030411`. Internal race id: `r-2026-0614-hanshin-11`.

The 18 announced runners are listed in `entries.csv` with their netkeiba
horse ids (`nk-<id>`, linkable as `https://db.netkeiba.com/horse/<id>`),
jockey and trainer ids, and carried weights. Horse names, numbers, and
gates are published with the draw (usually Friday) — fill in
`horse_number`, `gate`, and `horse_name` then, and re-import. Odds capture
does **not** depend on this: snapshots are keyed by horse number and join
to entries later.

## Runbook

1. Import the race card (any time):

   ```bash
   curl -X POST http://127.0.0.1:8000/api/imports/csv \
     -H "Content-Type: application/json" \
     -d '{"path": "examples/takarazuka_kinen_2026"}'
   ```

2. Saturday — connectivity check (single capture, exits immediately):

   ```bash
   python3 -m keibamon_core.polling \
     --race-id r-2026-0614-hanshin-11 \
     --netkeiba-race-id 202609030411 \
     --post-time 2026-06-14T15:40:00+09:00 \
     --once
   ```

3. Sunday morning (JST) — start the capture session and leave it running.
   The machine must stay awake until ~15:50 JST:

   ```bash
   python3 -m keibamon_core.polling \
     --race-id r-2026-0614-hanshin-11 \
     --netkeiba-race-id 202609030411 \
     --post-time 2026-06-14T15:40:00+09:00
   ```

   Cadence: every 15 min (>3 h out) tightening to every minute in the final
   10 minutes; stops 10 minutes after post. Roughly 60-70 requests for a
   full race-day session. Every raw payload is archived to
   `data/raw/odds_netkeiba/202609030411/` before parsing, so a parser bug
   can never lose data.

4. After the race — update `entries.csv` with horse numbers, add a
   `results.csv`, re-import, and the gold features will pick up the full
   odds curve:

   ```bash
   python3 - <<'EOF'
   from keibamon_core.lake import duckdb_relation
   print(duckdb_relation("data/normalized/odds_snapshots.parquet")
         .query("o", """
           select horse_number, count(*) snapshots,
                  min(win_odds) low, max(win_odds) high,
                  first(win_odds order by available_at) open,
                  last(win_odds order by available_at) close
           from o group by horse_number order by close
         """))
   EOF
   ```
