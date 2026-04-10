#!/usr/bin/env bash
#
# TUI Pipeline E2E Test
#
# Tests the full /plan → /work → /review chain in the actual TUI via tmux.
# Uses real API calls; takes several minutes.
#
# Usage:
#   ./tests/e2e/tui-pipeline.sh              # run and monitor
#   ./tests/e2e/tui-pipeline.sh --attach     # run and attach to watch live
#
# Prerequisites: tmux, valid API key (ANTHROPIC_API_KEY etc.)
#
# To kill a running test:
#   pkill -f tui-pipeline.sh; tmux kill-session -t flywheel-uat-*
#

source "$(dirname "$0")/lib/harness.sh"
init_harness "tui-pipeline" "$@"

TIMEOUT_SECONDS=1800  # 30 min
POLL_INTERVAL=10

# Sonnet is the minimum for reliable pipeline testing.
export FLYWHEEL_MODEL="${FLYWHEEL_MODEL:-sonnet}"

FEATURE_DESC='/plan "create a typescript utility function in tests/sandbox/cron-parser.ts that converts a 5-field cron expression into a human readable string like every Monday at 3pm and add unit tests in tests/sandbox/cron-parser.test.ts"'

# Sprint-style state detection adapted for chat-first UX.
detect_state() {
  local screen="$1"

  if echo "$screen" | grep -q "no server running\|session not found"; then
    echo "CRASHED"; return
  fi

  # Chat idle — "Send a message" without workflow indicators
  if echo "$screen" | grep -q "Send a message"; then
    if ! echo "$screen" | grep -q "steer the worker\|Esc to interrupt\|Thinking\|Dispatcher\|Step [0-9].*running"; then
      echo "IDLE"; return
    fi
  fi

  local wf="" status="" step=""

  # Detect workflow stage from output/status indicators
  if echo "$screen" | grep -qi "plan\|planning"; then wf="plan"
  elif echo "$screen" | grep -qi "review\|reviewing"; then wf="review"
  elif echo "$screen" | grep -qi "work\|executing\|WORK"; then wf="work"
  fi

  if echo "$screen" | grep -qi "completed\|done\|✓"; then status="completed"
  elif echo "$screen" | grep -qi "running\|thinking\|generating\|steer"; then status="running"
  elif echo "$screen" | grep -qi "paused\|stopped"; then status="paused"
  fi

  step=$(echo "$screen" | grep -o "Step [0-9]*/[0-9]*" | head -1 || true)
  step=${step:-$(echo "$screen" | grep -o "[0-9]*/[0-9]* steps" | head -1 || true)}

  if [ -n "$wf" ] && [ -n "$status" ]; then
    echo "${wf}:${status}${step:+ ($step)}"
  elif [ -n "$status" ]; then
    echo "unknown:${status}"
  else
    echo "UNKNOWN"
  fi
}

# ── Main ──

start_app

# Optionally attach
if [ "${1:-}" = "--attach" ]; then
  echo "(Attaching — detach with Ctrl+B D to let the test continue)"
  tmux attach-session -t "$SESSION"
fi

echo "Sending: $FEATURE_DESC"
send_text "$FEATURE_DESC"
sleep 5

# ── Poll ──

start_time=$(date +%s)
prev_state=""
seen_plan=0
seen_work=0
seen_review=0

while true; do
  elapsed=$(( $(date +%s) - start_time ))

  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    echo "TIMEOUT after ${elapsed}s. Last: $prev_state. Seen: plan=$seen_plan work=$seen_work review=$seen_review"
    capture "timeout-final.log"
    echo "FAIL  PIPELINE-timeout — timed out after ${elapsed}s (plan=$seen_plan work=$seen_work review=$seen_review)" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    break
  fi

  screen=$(tmux capture-pane -t "$SESSION" -p 2>/dev/null || echo "")

  state=$(detect_state "$screen")

  if [ "$state" != "$prev_state" ]; then
    echo "[$(date +%H:%M:%S)] State: $state (${elapsed}s)"
    prev_state="$state"

    case "$state" in
      plan:*)   seen_plan=1 ;;
      work:*)   seen_work=1 ;;
      review:*) seen_review=1 ;;
    esac
  fi

  case "$state" in
    CRASHED)
      echo "FAIL  PIPELINE-crash — TUI crashed" >> "$SUMMARY"
      FAIL_COUNT=$((FAIL_COUNT + 1))
      break
      ;;
    IDLE)
      if [ "$seen_plan" -eq 1 ] && [ "$seen_work" -eq 1 ] && [ "$seen_review" -eq 1 ]; then
        echo "PASS  PIPELINE-complete — full pipeline (plan→work→review) in ${elapsed}s" >> "$SUMMARY"
        PASS_COUNT=$((PASS_COUNT + 1))
        break
      fi
      # May return to idle between stages — keep polling
      ;;
    *:completed)
      if [ "$seen_plan" -eq 1 ] && [ "$seen_work" -eq 1 ] && [ "$seen_review" -eq 1 ]; then
        echo "PASS  PIPELINE-complete — full pipeline (plan→work→review) in ${elapsed}s" >> "$SUMMARY"
        PASS_COUNT=$((PASS_COUNT + 1))
        break
      fi
      ;;
  esac

  sleep "$POLL_INTERVAL"
done

# Verify stages were seen
if [ "$seen_plan" -eq 1 ]; then
  echo "PASS  PIPELINE-saw-plan — plan stage observed" >> "$SUMMARY"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  PIPELINE-saw-plan — plan stage never observed" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if [ "$seen_work" -eq 1 ]; then
  echo "PASS  PIPELINE-saw-work — work stage observed" >> "$SUMMARY"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  PIPELINE-saw-work — work stage never observed" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
if [ "$seen_review" -eq 1 ]; then
  echo "PASS  PIPELINE-saw-review — review stage observed" >> "$SUMMARY"
  PASS_COUNT=$((PASS_COUNT + 1))
else
  echo "FAIL  PIPELINE-saw-review — review stage never observed" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Cleanup sandbox artifacts
rm -rf "$(dirname "$0")/../../tests/sandbox" 2>/dev/null || true

stop_app
finish_harness
