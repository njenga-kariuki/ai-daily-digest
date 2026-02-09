#!/bin/bash
# Wrapper script for AI Daily Digest
# Called by launchd — provides self-healing via stale-process cleanup and hard watchdog timeout.

set -euo pipefail

# Kill any stale digest processes from previous runs
pkill -f "tsx src/index.ts" 2>/dev/null && sleep 2 || true

# Kill orphaned Chromium/Chrome from Puppeteer
pkill -f "Chromium.*--headless" 2>/dev/null || true
pkill -f "chrome.*--headless" 2>/dev/null || true

# Run digest with a hard 20-minute wall-clock timeout
cd /path/to/local-project

/path/to/local-project tsx src/index.ts --run-now &
MAIN_PID=$!

# Watchdog: SIGKILL after 20 minutes (1200 seconds)
(
  sleep 1200
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Watchdog: 20-minute timeout reached — killing digest (PID $MAIN_PID)"
  kill -9 $MAIN_PID 2>/dev/null
  pkill -9 -f "Chromium.*--headless" 2>/dev/null || true
  pkill -9 -f "chrome.*--headless" 2>/dev/null || true
) &
WATCHDOG_PID=$!

# Wait for main process
wait $MAIN_PID 2>/dev/null
EXIT_CODE=$?

# Clean up watchdog
kill $WATCHDOG_PID 2>/dev/null || true
wait $WATCHDOG_PID 2>/dev/null || true

exit ${EXIT_CODE:-0}
