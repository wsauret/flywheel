#!/usr/bin/env bash
#
# TUI Pipeline E2E Test
#
# Tests the full /plan -> /work -> /review chain in the actual TUI via tmux.
# Uses real API calls; takes several minutes.
#
# Usage:
#   ./tests/e2e/tui-pipeline.sh              # run and monitor
#   ./tests/e2e/tui-pipeline.sh --attach     # run and attach to watch live
#
# Prerequisites: tmux, valid API key (ANTHROPIC_API_KEY etc.)
#
# To kill a running test:
#   pkill -f tui-pipeline.sh; tmux kill-session -t flywheel-e2e
#

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
SESSION="flywheel-e2e"
LOG_FILE="$SCRIPT_DIR/tui-pipeline.log"
TIMEOUT_SECONDS=1800  # 30 min — plan (~6m) + work (~2m) + review (~8m) + buffer
POLL_INTERVAL=10

# Model selection: haiku is fast/cheap but may not follow the multi-step plan
# workflow reliably (skips steps, ignores completion markers). Sonnet is the
# recommended minimum for reliable pipeline testing.
# Claude Code accepts short aliases: "haiku", "sonnet", "opus".
export FLYWHEEL_MODEL="${FLYWHEEL_MODEL:-sonnet}"

FEATURE_DESC="/plan create a typescript utility function in tests/sandbox/cron-parser.ts that converts a 5-field cron expression into a human readable string like every Monday at 3pm and add unit tests in tests/sandbox/cron-parser.test.ts"

# ── Helpers ──

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG_FILE"; }

capture() { tmux capture-pane -t "$SESSION" -p 2>/dev/null || echo ""; }

detect_state() {
  local screen="$1"

  if echo "$screen" | grep -q "no server running\|session not found"; then
    echo "CRASHED"; return
  fi

  if echo "$screen" | grep -q "Type a / command\|/work.*Run a plan"; then
    echo "LAUNCHER"; return
  fi

  local wf="" status="" step=""

  # The footer shows the stage: "plan • Step N/M" or the plan path for work
  if echo "$screen" | grep -q "plan •"; then wf="plan"
  elif echo "$screen" | grep -q "review •"; then wf="review"
  elif echo "$screen" | grep -q "docs/plans/\|work •"; then wf="work"
  fi

  if echo "$screen" | grep -q "Completed"; then status="completed"
  elif echo "$screen" | grep -q "[Rr]unning"; then status="running"
  elif echo "$screen" | grep -q "Workflow idle"; then status="idle"
  fi

  step=$(echo "$screen" | grep -o "Step [0-9]*/[0-9]*" | head -1 || true)

  if [ -n "$wf" ] && [ -n "$status" ]; then
    echo "${wf}:${status}${step:+ ($step)}"
  elif [ -n "$status" ]; then
    echo "unknown:${status}"
  else
    echo "UNKNOWN"
  fi
}

cleanup() {
  tmux kill-session -t "$SESSION" 2>/dev/null || true
  rm -rf "$PROJECT_DIR/tests/sandbox" 2>/dev/null || true
}

trap cleanup EXIT

# ── Main ──

: > "$LOG_FILE"

log "=== TUI Pipeline E2E Test ==="
log "Project: $PROJECT_DIR"
log "Timeout: ${TIMEOUT_SECONDS}s"
log ""

tmux kill-session -t "$SESSION" 2>/dev/null || true
sleep 0.5

log "Starting TUI..."
tmux new-session -d -s "$SESSION" -x 120 -y 40 \
  "cd $PROJECT_DIR && bin/flywheel"
sleep 3

screen=$(capture)
state=$(detect_state "$screen")
if [ "$state" != "LAUNCHER" ]; then
  log "FAIL: Expected LAUNCHER, got: $state"
  echo "$screen" >> "$LOG_FILE"
  exit 1
fi
log "Launcher ready."

log "Sending: $FEATURE_DESC"
tmux send-keys -t "$SESSION" "$FEATURE_DESC" Enter
sleep 5

# Optionally attach
if [ "${1:-}" = "--attach" ]; then
  log "(Attaching — detach with Ctrl+B D to let the test continue)"
  tmux attach-session -t "$SESSION"
fi

# ── Poll ──

start_time=$(date +%s)
prev_state=""
seen_plan=0
seen_work=0
seen_review=0

while true; do
  elapsed=$(( $(date +%s) - start_time ))

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    log "TIMEOUT after ${elapsed}s. Last: $prev_state. Seen: plan=$seen_plan work=$seen_work review=$seen_review"
    capture >> "$LOG_FILE"
    exit 1
  fi

  screen=$(capture)
  state=$(detect_state "$screen")

  if [ "$state" != "$prev_state" ]; then
    log "State: $state (${elapsed}s)"
    prev_state="$state"

    case "$state" in
      plan:*)   seen_plan=1 ;;
      work:*)   seen_work=1 ;;
      review:*) seen_review=1 ;;
    esac
  fi

  case "$state" in
    CRASHED)
      log "FAIL: TUI crashed"
      exit 1
      ;;
    *:idle|*:completed)
      if [ "$seen_plan" -eq 1 ] && [ "$seen_work" -eq 1 ] && [ "$seen_review" -eq 1 ]; then
        log ""
        log "=== PASS: Full pipeline completed (plan -> work -> review) ==="
        log "Stages: plan=$seen_plan work=$seen_work review=$seen_review"
        log "Time: ${elapsed}s"
        exit 0
      else
        log ""
        log "=== FAIL: Pipeline stalled at idle before completing all stages ==="
        log "Stages: plan=$seen_plan work=$seen_work review=$seen_review"
        capture >> "$LOG_FILE"
        exit 1
      fi
      ;;
  esac

  sleep "$POLL_INTERVAL"
done
