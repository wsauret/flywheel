#!/usr/bin/env bash
# /fly:review routing heuristic test.
#
# Usage: bash tests/work/routing.test.sh
#
# Per D9: the routing logic for /fly:review is authored in Phase 4a in
# work-implementation/references/session-detection.md as a shared helper.
# Phase 5 only wires the /fly:review command to invoke the heuristic.
#
# Routing contract:
#   - $ARGUMENTS matches ^#?[0-9]+$  (PR number, with or without #)    → work-review
#   - $ARGUMENTS is a branch-name shape (contains / or starts alpha-)  → work-review
#   - $ARGUMENTS is empty AND session has baseline.json                → work-review
#   - $ARGUMENTS is empty AND session has spec.json but no baseline   → plan-review
#   - $ARGUMENTS is empty AND neither file present                    → error
#
# The test defines the routing heuristic as a shell function
# `route_review` (mirrors the prose in session-detection.md) and asserts
# its behavior against fixture directories.
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIX="$REPO_ROOT/tests/work/fixtures"

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# -----------------------------------------------------------------------------
# route_review: the shared helper (mirrors work-implementation/references/
# session-detection.md "/fly:review routing heuristic" prose).
#
# Contract:
#   - arg1: $ARGUMENTS (may be empty)
#   - arg2: session dir path (resolved from .flywheel/plugin/active.json)
#   - stdout: "work-review" | "plan-review"
#   - exit code: 0 on success; 4 on error ("no spec to review")
# -----------------------------------------------------------------------------
route_review() {
  local arguments="${1:-}"
  local session_dir="${2:-}"

  # PR number (with optional #) routes to work-review.
  if [[ "$arguments" =~ ^#?[0-9]+$ ]]; then
    echo "work-review"
    return 0
  fi

  # Branch name shape: contains a slash, or looks like a typical branch name
  # (starts with alnum, contains more than just digits).
  if [ -n "$arguments" ] && [[ "$arguments" == */* || "$arguments" =~ ^[a-zA-Z][a-zA-Z0-9._-]*$ ]]; then
    # A bare session-id is handled below; but since the caller uses active.json
    # for session context, a non-empty non-numeric arg is interpreted as a
    # work-review target (PR/branch).
    echo "work-review"
    return 0
  fi

  # Empty args: consult the active session.
  if [ -z "$session_dir" ]; then
    echo "No active session and no PR/branch argument. Run /fly:plan first." >&2
    return 4
  fi

  if [ -f "$session_dir/baseline.json" ]; then
    echo "work-review"
    return 0
  fi

  if [ -f "$session_dir/spec.json" ]; then
    echo "plan-review"
    return 0
  fi

  echo "No spec to review. Run /fly:plan first." >&2
  return 4
}

# -----------------------------------------------------------------------------
# Case 1: empty args, session has spec.json only (plan-only) → plan-review
# -----------------------------------------------------------------------------
out=$(route_review "" "$FIX/routing-plan-only")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "plan-review" ]; then
  note_pass "empty args + plan-only session → plan-review"
else
  note_fail "empty args + plan-only: expected plan-review (exit 0); got $out (exit $rc)"
fi

# -----------------------------------------------------------------------------
# Case 2: empty args, session has baseline.json → work-review
# -----------------------------------------------------------------------------
out=$(route_review "" "$FIX/routing-with-baseline")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "work-review" ]; then
  note_pass "empty args + session-with-baseline → work-review"
else
  note_fail "empty args + with-baseline: expected work-review (exit 0); got $out (exit $rc)"
fi

# -----------------------------------------------------------------------------
# Case 3: PR number arg — routes to work-review
# -----------------------------------------------------------------------------
out=$(route_review "42" "$FIX/routing-plan-only")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "work-review" ]; then
  note_pass "PR number arg → work-review (even on plan-only session)"
else
  note_fail "PR arg '42': expected work-review; got $out (exit $rc)"
fi

# -----------------------------------------------------------------------------
# Case 4: PR number with # prefix — routes to work-review
# -----------------------------------------------------------------------------
out=$(route_review "#123" "$FIX/routing-plan-only")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "work-review" ]; then
  note_pass "PR arg with '#' prefix → work-review"
else
  note_fail "PR arg '#123': expected work-review; got $out (exit $rc)"
fi

# -----------------------------------------------------------------------------
# Case 5: branch name — routes to work-review
# -----------------------------------------------------------------------------
out=$(route_review "feat/flywheel-cli-engine" "$FIX/routing-plan-only")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "work-review" ]; then
  note_pass "branch name arg → work-review"
else
  note_fail "branch arg: expected work-review; got $out (exit $rc)"
fi

# -----------------------------------------------------------------------------
# Case 6: no active session + empty args → error
# -----------------------------------------------------------------------------
tmpdir=$(mktemp -d -t routing_empty_XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT
out=$(route_review "" "$tmpdir" 2>/dev/null)
rc=$?
if [ "$rc" = "4" ]; then
  note_pass "empty args + empty session dir → exit 4 (no-spec error)"
else
  note_fail "empty args + empty session dir: expected exit 4, got $rc"
fi

# Also verify the error message mentions what to do.
stderr=$(route_review "" "$tmpdir" 2>&1 >/dev/null)
if echo "$stderr" | grep -q "/fly:plan"; then
  note_pass "empty session error directs user to /fly:plan"
else
  note_fail "empty session error did not mention /fly:plan. Got: $stderr"
fi

# -----------------------------------------------------------------------------
# Case 7: plan-only fixture has the expected baseline absence (sanity check)
# -----------------------------------------------------------------------------
if [ -f "$FIX/routing-plan-only/spec.json" ] && [ ! -f "$FIX/routing-plan-only/baseline.json" ]; then
  note_pass "routing-plan-only fixture: spec.json present, baseline.json absent (sanity)"
else
  note_fail "routing-plan-only fixture invariants broken"
fi

# -----------------------------------------------------------------------------
# Case 8: with-baseline fixture has both spec.json and baseline.json (sanity)
# -----------------------------------------------------------------------------
if [ -f "$FIX/routing-with-baseline/spec.json" ] && [ -f "$FIX/routing-with-baseline/baseline.json" ]; then
  note_pass "routing-with-baseline fixture: both spec.json and baseline.json present (sanity)"
else
  note_fail "routing-with-baseline fixture invariants broken"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
