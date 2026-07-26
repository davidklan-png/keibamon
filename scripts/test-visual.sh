#!/usr/bin/env bash
# Run (or regenerate) the Playwright visual suite in the pinned Linux container,
# FORCED to linux/amd64 so local + CI rasterize identically.
#
# WHY amd64: mcr.microsoft.com/playwright is a MULTI-ARCH manifest. On Apple
# Silicon a bare `docker run` resolves linux/arm64; GitHub's ubuntu-latest
# runner resolves linux/amd64. Same tag, different-CPU builds of
# freetype/harfbuzz/Chromium. That arch split was a plausible suspect for a
# ~94px cross-run difference an earlier batch reported; it was NOT the cause
# (the 94px was the branch being behind main — .foot-version present in CI's
# merge checkout, absent from branch-only baselines). The --platform linux/amd64
# pin is preventive: same image + same arch locally and in CI keeps the suite
# deterministic run-to-run regardless.
#
# HOW TO REGENERATE BASELINES — CI IS CANONICAL:
#   gh api -X POST repos/davidklan-png/keibamon/actions/workflows/visual.yml/dispatches \
#     -f ref=<branch> -F regenerate=true
# This triggers the regen job in visual.yml, which runs --update-snapshots on
# the NATIVE amd64 CI runner and commits the regenerated -chromium-linux
# baselines back to the branch. CI is the source of truth because a Mac can't
# match it without Rosetta (see LOCAL RUNS below).
#
# LOCAL RUNS (read-only check) REQUIRE ROSETTA. amd64 under Apple Silicon needs
# Docker Desktop → Settings → "Use Rosetta for x86/amd64 emulation" ON. With it
# OFF (the default), Docker uses QEMU and Chromium's headless shell crashes
# (SIGTRAP, "GPU process isn't usable. Goodbye.") — every test fails at browser
# launch. Rosetta is a global toggle that restarts Docker, so on this Mac
# (which runs other containers) CI regen is the default path; a local run is a
# convenience for when Rosetta is already on.
#
# Baselines are -chromium-linux; a bare local `npm run test:visual` on a Mac
# produces -chromium-darwin (and on the wrong arch), so use THIS. node_modules
# lives in a named volume to avoid the macOS Docker bind-mount penalty (npm ci
# through a bind mount is minutes-slow).
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
  echo "Regenerating baselines (-chromium-linux, amd64)..."
fi

exec docker run --rm \
  --platform linux/amd64 \
  -v "$PWD":/work \
  -v kbm-visual-node-modules:/work/frontend/node_modules \
  -w /work/frontend \
  mcr.microsoft.com/playwright:v1.61.0-jammy \
  sh -c "npm ci && npm run test:visual $UPDATE_ARGS"
