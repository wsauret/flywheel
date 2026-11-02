#!/usr/bin/env bash
#
# Run all TUI regression test modules.
#
# Usage:
#   ./tests/e2e/tui-run-all.sh                          # run all modules
#   ./tests/e2e/tui-run-all.sh tui-chat tui-usage       # run specific modules
#
# Each module runs in its own tmux session with isolated logs.
# Results are collected into a single summary at the end.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S)"

ALL_MODULES=(
  tui-headless
  tui-chat
  tui-model-modal
  tui-multi-session
  tui-session-modal
  tui-session-recovery
  tui-chat-workflow-interaction
  tui-subprocess-reliability
  tui-regression
  tui-usage
)

# Allow running specific modules via args
if [ $# -gt 0 ]; then
  MODULES=("$@")
else
  MODULES=("${ALL_MODULES[@]}")
fi

mkdir -p "$BASE_DIR"

TOTAL_PASS=0
TOTAL_FAIL=0
MODULE_RESULTS=()

echo "════════════════════════════════════════════"
echo "  TUI Regression Suite — $(date +%Y-%m-%d\ %H:%M)"
echo "  Modules: ${MODULES[*]}"
echo "  Results: $BASE_DIR"
echo "════════════════════════════════════════════"
echo ""

for module in "${MODULES[@]}"; do
  script="$SCRIPT_DIR/$module.sh"
  if [ ! -f "$script" ]; then
    echo "  SKIP: $module.sh not found"
    continue
  fi

  echo "── Running: $module ──"
  chmod +x "$script"

  # Run the module, pass base dir so all modules share the results root
  if bash "$script" "$BASE_DIR"; then
    status="OK"
  else
    status="ERRORS"
  fi

  # Parse results from module summary. Some scripts use a shorter
  # init_e2e name than their script/module id (for example tui-chat → chat).
  summary="$BASE_DIR/$module/summary.log"
  if [ ! -f "$summary" ] && [[ "$module" == tui-* ]]; then
    summary="$BASE_DIR/${module#tui-}/summary.log"
  fi
  if [ -f "$summary" ]; then
    pass=$(awk '/^PASS:/ { value=$2 } END { print value }' "$summary")
    fail=$(awk '/^FAIL:/ { value=$2 } END { print value }' "$summary")
    if [[ ! "$pass" =~ ^[0-9]+$ ]] || [[ ! "$fail" =~ ^[0-9]+$ ]]; then
      TOTAL_FAIL=$((TOTAL_FAIL + 1))
      MODULE_RESULTS+=("  $module: malformed summary (1 failed)")
      echo ""
      continue
    fi
    if [ "$status" != "OK" ]; then
      fail=$((fail + 1))
      MODULE_RESULTS+=("  $module: $pass passed, $fail failed (script exited with errors)")
    else
      MODULE_RESULTS+=("  $module: $pass passed, $fail failed")
    fi
    TOTAL_PASS=$((TOTAL_PASS + pass))
    TOTAL_FAIL=$((TOTAL_FAIL + fail))
  elif [ "$module" = "tui-headless" ] && [ "$status" = "OK" ]; then
    MODULE_RESULTS+=("  $module: no summary (OK)")
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
    MODULE_RESULTS+=("  $module: missing summary (1 failed; status=${status})")
  fi
  echo ""
done

# Write combined summary
COMBINED="$BASE_DIR/combined-summary.log"
echo "TUI Regression Suite — $(date)" > "$COMBINED"
echo "---" >> "$COMBINED"
for line in "${MODULE_RESULTS[@]}"; do
  echo "$line" >> "$COMBINED"
done
echo "---" >> "$COMBINED"
echo "TOTAL PASS: $TOTAL_PASS" >> "$COMBINED"
echo "TOTAL FAIL: $TOTAL_FAIL" >> "$COMBINED"

echo "════════════════════════════════════════════"
echo "  RESULTS"
echo ""
for line in "${MODULE_RESULTS[@]}"; do
  echo "$line"
done
echo ""
echo "  Total: $TOTAL_PASS passed, $TOTAL_FAIL failed"
echo "  Logs:  $BASE_DIR"
echo "════════════════════════════════════════════"

# Exit with failure if any tests failed
[ "$TOTAL_FAIL" -eq 0 ]
