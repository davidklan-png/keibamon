#!/bin/bash
# Weekly lake refresh — netkeiba is the sole feed since JV-Link retired
# (subscription expired 2026-07-13). Scrape the trailing 7 days so every
# Sat/Sun/holiday card lands; non-race days no-op after one polite GET and
# re-scrapes are deduped by _last_hash.txt. Bronze + silver write in one pass.
# ponytail: BSD `date -v` — mac-dev only; port to GNU date if this ever runs on Linux
set -u
cd "$(dirname "$0")/.." || exit 1
for i in 1 2 3 4 5 6 7; do
  D=$(date -v-${i}d +%Y%m%d)
  echo "=== $D ==="
  PYTHONPATH=src ./venv64/bin/python tools/scrape_ingest.py --date "$D" \
    || echo "WARN: $D ingest failed (continuing)"
done
