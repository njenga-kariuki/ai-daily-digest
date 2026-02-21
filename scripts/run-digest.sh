#!/bin/bash
# Wrapper script for AI Daily Digest.
# Called by launchd; adds stale-process cleanup, hard watchdog timeout, and bounded retries.

set -euo pipefail

REPO_DIR="/path/to/local-project"
NODE_BIN="/path/to/local-project"
MAX_ATTEMPTS=3
RETRY_DELAY_SECONDS=180
WATCHDOG_SECONDS=3300 # 55 minutes

cleanup_stale_processes() {
  # Kill any stale digest processes from previous runs.
  pkill -f "tsx src/index.ts" 2>/dev/null && sleep 2 || true

  # Kill orphaned Chromium/Chrome from Puppeteer.
  pkill -f "Chromium.*--headless" 2>/dev/null || true
  pkill -f "chrome.*--headless" 2>/dev/null || true
}

run_attempt() {
  "$NODE_BIN" tsx src/index.ts --run-now &
  MAIN_PID=$!

  (
    sleep "$WATCHDOG_SECONDS"
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Watchdog: timeout reached, killing digest (PID $MAIN_PID)"
    kill -9 "$MAIN_PID" 2>/dev/null || true
    pkill -9 -f "Chromium.*--headless" 2>/dev/null || true
    pkill -9 -f "chrome.*--headless" 2>/dev/null || true
  ) &
  WATCHDOG_PID=$!

  set +e
  wait "$MAIN_PID" 2>/dev/null
  EXIT_CODE=$?
  set -e

  kill "$WATCHDOG_PID" 2>/dev/null || true
  wait "$WATCHDOG_PID" 2>/dev/null || true

  return "$EXIT_CODE"
}

cd "$REPO_DIR"

LAST_EXIT=1
for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Digest attempt $attempt/$MAX_ATTEMPTS starting"
  cleanup_stale_processes

  if run_attempt; then
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Digest attempt $attempt succeeded"
    exit 0
  fi

  LAST_EXIT=$?
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Digest attempt $attempt failed with exit code $LAST_EXIT"

  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Sleeping $RETRY_DELAY_SECONDS seconds before retry"
    sleep "$RETRY_DELAY_SECONDS"
  fi
done

exit "$LAST_EXIT"
