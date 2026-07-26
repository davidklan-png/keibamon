#!/usr/bin/env bash
# Run (or regenerate) the Playwright visual suite in the pinned Linux container
# so local + CI rasterize identically. Baselines are -chromium-linux; a bare
# local `npm run test:visual` on a Mac produces -chromium-darwin, which no
# longer exists, so use THIS. node_modules lives in a named volume to avoid the
# macOS Docker bind-mount penalty (npm ci through a bind mount is minutes-slow).
#
#   scripts/test-visual.sh           # run the suite (CI-equivalent)
#   scripts/test-visual.sh --update  # regenerate baselines after an intended UI change
#
# Requires Docker. The image tag must match @playwright/test in
# frontend/package.json (currently 1.61.0-jammy); bump them together.
set -euo pipefail

cd "$(dirname "$0")/.."

UPDATE_ARGS=""
if [[ "${1:-}" == "--update" ]]; then
  UPDATE_ARGS='-- --update-snapshots'
  echo "Regenerating baselines (-chromium-linux)..."
fi

exec docker run --rm \
  -v "$PWD":/work \
  -v kbm-visual-node-modules:/work/frontend/node_modules \
  -w /work/frontend \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  sh -c "npm ci && npm run test:visual $UPDATE_ARGS"
