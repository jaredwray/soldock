#!/bin/bash
# Installs workspace dependencies in Claude Code cloud sessions so `pnpm verify`
# (lint, typecheck, tests, plan check, license check) works from the first turn.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"
pnpm install --prefer-offline
