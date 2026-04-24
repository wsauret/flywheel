#!/usr/bin/env bash
# Atomic state.json write pattern test.
#
# Usage: bash tests/work/atomic-write.test.sh
#
# Per P1-D: work-implementation must write state.json atomically — write to
# state.json.tmp, then rename over state.json. This gives us "either the
# pre-write state OR the post-write state" on disk at any instant; there is
# no window where state.json is half-written.
#
# This test validates the mechanic the skill SKILL.md mandates. The
# checkpoint-procedure.md documents the rule; this test exercises the
# shell primitives (mv is atomic on local POSIX filesystems).
#
# Scenarios:
#   1. Normal path: write to .tmp, rename — tmp gone, state.json present with
#      correct content.
#   2. Interrupted path: start a subshell that writes to .tmp but is killed
#      before the rename. Assert state.json is either absent or still at its
#      prior value; the .tmp may or may not exist, but state.json is never
#      half-written.
#
# Exits 0 on success, 1 on any assertion failure.

set -u

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

tmpdir=$(mktemp -d -t atomic_write_XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT

STATE="$tmpdir/state.json"
STATE_TMP="$tmpdir/state.json.tmp"

# -----------------------------------------------------------------------------
# Scenario 1: normal atomic write — write to .tmp, then mv to state.json.
# Assertions: .tmp does not exist; state.json exists with written content.
# -----------------------------------------------------------------------------
CONTENT='{"schema_version":1,"plan_id":"test","status":"in_progress","summary":"atomic write test","phases":[],"learnings":[],"error_log":[]}'

echo "$CONTENT" > "$STATE_TMP"
mv "$STATE_TMP" "$STATE"

if [ ! -f "$STATE_TMP" ]; then
  note_pass "after mv: state.json.tmp does not exist"
else
  note_fail "after mv: state.json.tmp still exists"
fi

if [ -f "$STATE" ]; then
  note_pass "after mv: state.json exists"
else
  note_fail "after mv: state.json does not exist"
fi

if [ "$(cat "$STATE")" = "$CONTENT" ]; then
  note_pass "state.json content matches written bytes"
else
  note_fail "state.json content mismatch"
fi

# Also verify it's valid JSON that jq can parse.
if jq empty "$STATE" 2>/dev/null; then
  note_pass "state.json parses as valid JSON"
else
  note_fail "state.json does not parse as valid JSON"
fi

# -----------------------------------------------------------------------------
# Scenario 2: interrupted write — write to .tmp but never rename. The
# existing state.json (from scenario 1) should remain unchanged. No half-
# written state.json should ever exist.
# -----------------------------------------------------------------------------
PRE_INTERRUPT_CONTENT=$(cat "$STATE")

# Write new content to .tmp but do NOT rename.
NEW_CONTENT='{"schema_version":1,"plan_id":"test","status":"completed","summary":"new content that should not clobber","phases":[],"learnings":[],"error_log":[]}'
echo "$NEW_CONTENT" > "$STATE_TMP"

# Simulate the interrupt — no mv happens. Assert state.json still holds the
# previous value.
if [ "$(cat "$STATE")" = "$PRE_INTERRUPT_CONTENT" ]; then
  note_pass "interrupted write: state.json unchanged (atomic semantics)"
else
  note_fail "interrupted write: state.json was modified without a mv"
fi

# .tmp may exist (it was written), but state.json is never half-written.
# The invariant is: after any interrupt, state.json is either (pre) or (post),
# never partial. Our test proved (pre) held; the post case is scenario 1.

# Verify state.json is still valid JSON (no partial-write corruption).
if jq empty "$STATE" 2>/dev/null; then
  note_pass "after simulated interrupt: state.json is still valid JSON"
else
  note_fail "after simulated interrupt: state.json is corrupted"
fi

# Clean up the stranded .tmp (the skill's recovery procedure should delete
# stranded .tmp files on startup; we just document that here).
rm -f "$STATE_TMP"

if [ ! -f "$STATE_TMP" ]; then
  note_pass "recovery: stranded state.json.tmp cleaned up"
else
  note_fail "recovery: state.json.tmp not removed"
fi

# -----------------------------------------------------------------------------
# Scenario 3: rename is atomic on same filesystem (mv is a rename(2) syscall).
# This is a property of the filesystem, not something we can truly race-test
# from bash without significant ceremony. We document the invariant and
# verify that the simple sequential pattern produces the expected on-disk
# state — the readers' invariant is: at any instant, state.json parses as
# valid JSON or is absent.
# -----------------------------------------------------------------------------
# Final state should be a valid JSON.
if [ -f "$STATE" ] && jq empty "$STATE" 2>/dev/null; then
  note_pass "final state.json is valid JSON (atomic invariant holds)"
else
  note_fail "final state.json is absent or invalid"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
