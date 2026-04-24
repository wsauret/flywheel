#!/usr/bin/env bash
#
# Run the flywheel plugin UAT suite (real claude sessions via tmux).
#
# Usage:
#   ./tests/uat/run-all.sh                                    # run all modules
#   ./tests/uat/run-all.sh uat-a-full-pipeline uat-b-skip-review   # specific modules
#
# Each module runs real `claude --dangerously-skip-permissions` in an isolated
# tmpdir and exercises one path through the pipeline. Results land under
# tests/uat/results/<timestamp>/<module>/.
#
# Expect each run to take 10-30 min depending on which modules you select
# (real-claude invocations with 6 parallel reviewer agents are slow).
set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BASE_DIR="$SCRIPT_DIR/results/$(date +%Y%m%d-%H%M%S)"

ALL_MODULES=(
  uat-a-full-pipeline
  uat-b-skip-review
  uat-c-stop-resume
)

if [ $# -gt 0 ]; then
  MODULES=("$@")
else
  MODULES=("${ALL_MODULES[@]}")
fi

mkdir -p "$BASE_DIR"

TOTAL_PASS=0
TOTAL_FAIL=0
MODULE_RESULTS=()

echo "========================================================"
echo "  Flywheel Plugin UAT Suite - $(date +%Y-%m-%d\ %H:%M)"
echo "  Modules: ${MODULES[*]}"
echo "  Results: $BASE_DIR"
echo "========================================================"
echo ""

for module in "${MODULES[@]}"; do
  script="$SCRIPT_DIR/$module.sh"
  if [ ! -f "$script" ]; then
    echo "  SKIP: $module.sh not found"
    continue
  fi

  echo "-- Running: $module --"
  chmod +x "$script"
  if bash "$script" "$BASE_DIR"; then
    status="OK"
  else
    status="FAIL"
  fi

  summary="$BASE_DIR/$module/summary.log"
  if [ -f "$summary" ]; then
    pass=$(grep "^PASS:" "$summary" | awk '{print $2}' || echo 0)
    fail=$(grep "^FAIL:" "$summary" | awk '{print $2}' || echo 0)
    TOTAL_PASS=$((TOTAL_PASS + pass))
    TOTAL_FAIL=$((TOTAL_FAIL + fail))
    MODULE_RESULTS+=("  $module: $pass passed, $fail failed ($status)")
  else
    MODULE_RESULTS+=("  $module: no summary ($status)")
  fi
  echo ""
done

# Combined summary
combined="$BASE_DIR/combined-summary.log"
{
  echo "Flywheel Plugin UAT Suite - $(date)"
  echo "---"
  for line in "${MODULE_RESULTS[@]}"; do echo "$line"; done
  echo "---"
  echo "TOTAL PASS: $TOTAL_PASS"
  echo "TOTAL FAIL: $TOTAL_FAIL"
} > "$combined"

echo "========================================================"
echo "  RESULTS"
echo ""
for line in "${MODULE_RESULTS[@]}"; do echo "$line"; done
echo ""
echo "  Total: $TOTAL_PASS passed, $TOTAL_FAIL failed"
echo "  Logs:  $BASE_DIR"
echo "========================================================"

[ "$TOTAL_FAIL" -eq 0 ]
