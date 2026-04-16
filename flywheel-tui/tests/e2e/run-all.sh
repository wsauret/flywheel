#!/usr/bin/env bash
#
# Run all TUI regression test modules.
#
# Usage:
#   ./tests/e2e/run-all.sh                              # run all modules
#   ./tests/e2e/run-all.sh chat workflow                # run specific modules
#   ./tests/e2e/run-all.sh --engine=harness             # run all with harness engine
#   ./tests/e2e/run-all.sh --engine=harness chat        # specific modules + engine
#
# Each module runs in its own tmux session with isolated logs.
# Results are collected into a single summary at the end.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S)"

# Parse --engine flag from args
FLYWHEEL_E2E_ENGINE=""
REMAINING_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --engine=*) FLYWHEEL_E2E_ENGINE="${arg#--engine=}" ;;
    *) REMAINING_ARGS+=("$arg") ;;
  esac
done
set -- "${REMAINING_ARGS[@]+"${REMAINING_ARGS[@]}"}"
export FLYWHEEL_E2E_ENGINE

ALL_MODULES=(
  headless
  chat
  workflow
  multi-session
  session-modal
  session-recovery
  chat-workflow-interaction
  subprocess-reliability
  tui-regression
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
echo "  Engine:  ${FLYWHEEL_E2E_ENGINE:-default (from config)}"
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

  # Parse results from module summary
  summary="$BASE_DIR/$module/summary.log"
  if [ -f "$summary" ]; then
    pass=$(grep "^PASS:" "$summary" | awk '{print $2}' || echo 0)
    fail=$(grep "^FAIL:" "$summary" | awk '{print $2}' || echo 0)
    TOTAL_PASS=$((TOTAL_PASS + pass))
    TOTAL_FAIL=$((TOTAL_FAIL + fail))
    MODULE_RESULTS+=("  $module: $pass passed, $fail failed")
  else
    MODULE_RESULTS+=("  $module: no summary (${status})")
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
