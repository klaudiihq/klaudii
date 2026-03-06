#!/usr/bin/env bash
# Shepherd — periodic Klaudii monitoring script.
#
# Two modes:
#   bin/shepherd.sh          — runs lib/shepherd.js directly (fast, no Claude needed)
#   bin/shepherd.sh --claude  — launches a Claude instance with lib/shepherd-prompt.md
#
# Cron example (every 5 minutes):
#   */5 * * * * /Volumes/Fast/bryantinsley/repos/klaudii/bin/shepherd.sh >> /tmp/shepherd.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Ensure Klaudii server is reachable
if ! curl -sf http://localhost:9876/api/health > /dev/null 2>&1; then
  echo "[shepherd] Klaudii server not reachable at http://localhost:9876 — skipping run"
  exit 0
fi

if [[ "${1:-}" == "--claude" ]]; then
  # Claude-based mode: spawn an ephemeral Claude to act as Shepherd
  cd "$PROJECT_DIR"
  unset CLAUDECODE 2>/dev/null || true
  exec claude -p --dangerously-skip-permissions < "$PROJECT_DIR/lib/shepherd-prompt.md"
else
  # Direct mode: run the Node.js shepherd script
  cd "$PROJECT_DIR"
  exec node "$PROJECT_DIR/lib/shepherd.js"
fi
