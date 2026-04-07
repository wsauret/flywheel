#!/usr/bin/env bash
# E2E test for --headless CLI mode
#
# Tests:
#   H-01: --headless with no --description prints usage and exits 1
#   H-02: --headless --description "hello" starts without TUI
#         (may fail on missing API key — that's OK, just verify it doesn't launch TUI)

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$PROJECT_DIR/bin/flywheel"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# ── H-01: --headless without --description exits 1 ──
echo "H-01: --headless without --description"
set +e
output=$("$BIN" --headless 2>&1)
exit_code=$?
set -e

if [ "$exit_code" -eq 1 ]; then
  pass "H-01a exit code is 1"
else
  fail "H-01a expected exit 1, got $exit_code"
fi

if echo "$output" | grep -qi "description"; then
  pass "H-01b usage mentions --description"
else
  fail "H-01b usage output does not mention --description"
fi

# ── H-02: --headless --description starts without TUI ──
echo "H-02: --headless --description \"hello\""
set +e
# Run with a short timeout — we just want to confirm it doesn't hang trying to start TUI.
# It will likely fail due to missing API key or similar, but should NOT launch TUI.
output=$(timeout 15 "$BIN" --headless --description "hello" 2>&1)
exit_code=$?
set -e

# Exit code 124 = timeout killed it (still running, which means it started the workflow)
# Exit code 0 = completed successfully
# Exit code 1 = failed (e.g., missing API key) — still acceptable
# Any of these means it did NOT crash trying to launch TUI

if [ "$exit_code" -ne 137 ] && [ "$exit_code" -ne 139 ]; then
  pass "H-02a did not crash (exit=$exit_code)"
else
  fail "H-02a process crashed (exit=$exit_code)"
fi

# Should NOT contain TUI-specific output (e.g., escape sequences for full-screen rendering)
# A simple heuristic: headless mode should not produce the alternate screen escape sequence
if echo "$output" | grep -q $'\e\[?1049h'; then
  fail "H-02b launched TUI (found alternate screen escape)"
else
  pass "H-02b did not launch TUI"
fi

# ── Summary ──
echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
