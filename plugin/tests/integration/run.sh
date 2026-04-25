#!/usr/bin/env bash
# Integration test runner.
#
# Usage:
#   bash tests/integration/run.sh                # run every cases/*.test.sh
#   bash tests/integration/run.sh smoke          # run cases/00-smoke-*
#   bash tests/integration/run.sh fly-work       # run cases/*fly-work*
#
# These tests spawn real claude in real tmux against the local plugin.
# They make real Anthropic API calls. ANTHROPIC_API_KEY must be set.
#
# Cost / time discipline:
#   - 00-plugin-loads is a smoke test; cheap, ~30s.
#   - 01-fly-work and 02-fly-plan invoke real skills end-to-end.
#     Plan on 1-5 minutes per case and real token spend.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CASES_DIR="$REPO_ROOT/tests/integration/cases"
filter="${1:-}"

# Pre-flight checks -----------------------------------------------------------
fail_pre=0
if ! command -v tmux >/dev/null 2>&1; then
  echo "ERROR: tmux not found in PATH" >&2; fail_pre=1
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "ERROR: claude not found in PATH" >&2; fail_pre=1
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY is not set — these are real-API tests" >&2
  fail_pre=1
fi
[ "$fail_pre" = "1" ] && exit 2

# Discover cases --------------------------------------------------------------
shopt -s nullglob
cases=("$CASES_DIR"/*.test.sh)
shopt -u nullglob

if [ ${#cases[@]} -eq 0 ]; then
  echo "No cases found in $CASES_DIR"; exit 1
fi

run_count=0
pass_count=0
fail_count=0

for case_file in "${cases[@]}"; do
  name="$(basename "$case_file" .test.sh)"
  if [ -n "$filter" ] && [[ "$name" != *"$filter"* ]]; then
    continue
  fi
  run_count=$((run_count + 1))
  echo "=========================================================="
  echo "RUN: $name"
  echo "=========================================================="
  if bash "$case_file"; then
    pass_count=$((pass_count + 1))
    echo "OK: $name"
  else
    fail_count=$((fail_count + 1))
    echo "FAIL: $name"
  fi
  echo ""
done

echo "=========================================================="
echo "Cases: $run_count run, $pass_count passed, $fail_count failed."
echo "=========================================================="
[ "$fail_count" = "0" ] && exit 0 || exit 1
