#!/bin/bash
# Wrapper script for AI Daily Digest.
# Called by launchd; adds stale-process cleanup, hard watchdog timeout, and bounded retries.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="${DIGEST_NPX_BIN:-$(command -v npx)}"

# Disable Node 21's Happy Eyeballs. Its 250ms per-attempt timeout is shorter
# than the Nairobi→Seattle RTT to Google endpoints, causing spurious ETIMEDOUTs
# on oauth2.googleapis.com and Substack-hosted RSS feeds.
export NODE_OPTIONS="--no-network-family-autoselection"
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

# When launchd wakes the Mac to fire this job, the WiFi adapter / mDNSResponder
# is often not ready yet. Source fetches issued in the first ~5s after wake
# return getaddrinfo ENOTFOUND instantly because there's no resolver to query.
# Block here until basic connectivity + DNS for our critical hosts works,
# capped at 180s. If the cap is hit, proceed anyway — the run will fail loudly
# and surface in the failure notification.
wait_for_network() {
  local elapsed=0
  local max_wait=180
  while [[ $elapsed -lt $max_wait ]]; do
    if curl -sS --max-time 5 -o /dev/null https://1.1.1.1 2>/dev/null \
       && nslookup api.anthropic.com >/dev/null 2>&1 \
       && nslookup oauth2.googleapis.com >/dev/null 2>&1; then
      if [[ $elapsed -gt 0 ]]; then
        echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Network ready after ${elapsed}s"
      fi
      return 0
    fi
    if [[ $elapsed -eq 0 ]]; then
      echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Waiting for network/DNS to be ready..."
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] WARN: network not ready after ${max_wait}s, attempting anyway"
  return 1
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
  wait_for_network || true

  # Capture exit code into a variable BEFORE the if-test.
  # Bash sets $? to 0 after `fi` when the if-branch didn't execute, which
  # would silently mask all failures from launchd if we relied on `$?` here.
  set +e
  run_attempt
  ATTEMPT_EXIT=$?
  set -e

  if [[ $ATTEMPT_EXIT -eq 0 ]]; then
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Digest attempt $attempt succeeded"
    exit 0
  fi

  LAST_EXIT=$ATTEMPT_EXIT
  echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Digest attempt $attempt failed with exit code $LAST_EXIT"

  if [[ "$attempt" -lt "$MAX_ATTEMPTS" ]]; then
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] Sleeping $RETRY_DELAY_SECONDS seconds before retry"
    sleep "$RETRY_DELAY_SECONDS"
  fi
done

# All attempts exhausted — notify the user so failures stop being silent.
echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] All $MAX_ATTEMPTS attempts failed (last exit: $LAST_EXIT); sending failure notification"
"$NODE_BIN" tsx scripts/notify-failure.ts "All $MAX_ATTEMPTS digest attempts failed (last exit: $LAST_EXIT)" \
  || echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] WARN: failure notification also failed; check ${HOME}/Library/Logs/ai-daily-digest.log"

exit "$LAST_EXIT"
