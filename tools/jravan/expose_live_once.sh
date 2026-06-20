#!/usr/bin/env bash
# expose_live_once.sh -- one registration-exposure cycle, for cron/launchd.
#
# ADR-0006. NOT a daemon: each invocation fetches once, publishes to D1, exits.
# Scheduled to fire when JRA actually publishes/updates data (see crontab.example):
#   - Friday  : numbered entries + estimated odds for the weekend cards
#   - Sat/Sun : race-day odds, every 2 min during racing hours (JRA's own
#               current-race odds update interval is ~120s, so faster is wasted)
#
# Creds: sourced from ~/.keibamon/cf.env (CF_API_TOKEN / CF_ACCOUNT_ID /
# CF_D1_DATABASE_ID) -- the CLAUDE.md cross-shell trap means we must NOT rely on
# shell-inherited env under cron. Keep that file chmod 600.
set -euo pipefail

REPO="${KEIBAMON_REPO:-$HOME/projects/personal/Keibamon}"
CREDS="${KEIBAMON_CF_ENV:-$HOME/.keibamon/cf.env}"
PY="${KEIBAMON_PY:-$REPO/venv64/bin/python}"
LOG="${KEIBAMON_LOG:-$HOME/.keibamon/expose_live.log}"

mkdir -p "$(dirname "$LOG")"
# shellcheck source=/dev/null
[ -f "$CREDS" ] && source "$CREDS"

cd "$REPO"
PYTHONPATH=src "$PY" tools/jravan/expose_live.py --once --skip-empty "$@" \
  >>"$LOG" 2>&1
