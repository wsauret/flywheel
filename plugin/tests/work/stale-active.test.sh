#!/usr/bin/env bash
# Stale active.json rescue test.
#
# Usage: bash tests/work/stale-active.test.sh
#
# Per P1-F: work-implementation Phase 0 must rescue a stale active.json —
# when the pointer in .flywheel/plugin/active.json references a session
# directory that no longer exists (user manually rm -rf'd it, say), the
# skill should:
#
#   1. Print an explicit error identifying the missing session.
#   2. Clear active.json (so subsequent /fly:work invocations don't repeat
#      the same error).
#   3. Exit with a non-zero status so the caller knows to rerun with a
#      plan or slug.
#
# The skill is interpreted — there is no executable adapter. This test
# defines the expected check as a shell function `check_active_session`
# and asserts the function's behavior on stale-pointer input. The skill
# SKILL.md implements the same logic procedurally.
#
# Exits 0 on success, 1 on any assertion failure.

set -u

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# Sandbox so we do not touch the real .flywheel/plugin/active.json.
tmpdir=$(mktemp -d -t stale_active_XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT

FLYWHEEL="$tmpdir/.flywheel/plugin"
ACTIVE="$FLYWHEEL/active.json"
SESSIONS="$FLYWHEEL/sessions"
mkdir -p "$SESSIONS"

# -----------------------------------------------------------------------------
# check_active_session: the shared helper (mirrors work-implementation Phase 0)
#
# Contract:
#   - arg1: path to active.json
#   - arg2: path to sessions/ directory
#   - stdout: the resolved session_id on success, else empty
#   - stderr: an error message on stale or missing pointer
#   - exit code: 0 on success; 2 on stale pointer (active cleared); 3 on no
#     active.json
# -----------------------------------------------------------------------------
check_active_session() {
  local active_path="$1"
  local sessions_dir="$2"

  if [ ! -f "$active_path" ]; then
    echo "No active session. Run /fly:plan or /fly:work <slug>." >&2
    return 3
  fi

  local session_id
  session_id=$(jq -r '.session_id' "$active_path" 2>/dev/null)
  if [ -z "$session_id" ] || [ "$session_id" = "null" ]; then
    echo "active.json is malformed (no session_id)." >&2
    return 3
  fi

  if [ ! -d "$sessions_dir/$session_id" ]; then
    # Stale pointer rescue.
    echo "Session $session_id not found. Clearing active pointer. Run /fly:plan or /fly:work <slug>." >&2
    rm -f "$active_path"
    return 2
  fi

  echo "$session_id"
  return 0
}

# -----------------------------------------------------------------------------
# Scenario 1: active.json is missing — expect exit 3 + error message
# -----------------------------------------------------------------------------
rm -f "$ACTIVE"

stderr=$(check_active_session "$ACTIVE" "$SESSIONS" 2>&1 >/dev/null)
rc=$?
if [ "$rc" = "3" ] && echo "$stderr" | grep -q "No active session"; then
  note_pass "missing active.json: exit 3 + explicit error"
else
  note_fail "missing active.json: expected exit 3 + error; got rc=$rc stderr=$stderr"
fi

# -----------------------------------------------------------------------------
# Scenario 2: active.json points to an existing session — expect exit 0
# -----------------------------------------------------------------------------
mkdir -p "$SESSIONS/real-session-2026-04-23"
echo '{"schema_version":1,"session_id":"real-session-2026-04-23"}' > "$ACTIVE"

stdout=$(check_active_session "$ACTIVE" "$SESSIONS" 2>/dev/null)
rc=$?
if [ "$rc" = "0" ] && [ "$stdout" = "real-session-2026-04-23" ]; then
  note_pass "valid active.json: exit 0 + stdout is session_id"
else
  note_fail "valid active.json: expected exit 0 + session_id; got rc=$rc stdout=$stdout"
fi

# -----------------------------------------------------------------------------
# Scenario 3: active.json points to a DELETED session — the rescue path
# a. exit 2
# b. stderr names the session and directs the user to plan/slug
# c. active.json is cleared after the check
# -----------------------------------------------------------------------------
echo '{"schema_version":1,"session_id":"nonexistent-2026-01-01"}' > "$ACTIVE"
# Sessions dir is real but the session inside is missing.

stderr=$(check_active_session "$ACTIVE" "$SESSIONS" 2>&1 >/dev/null)
rc=$?

if [ "$rc" = "2" ]; then
  note_pass "stale active.json: exit code 2"
else
  note_fail "stale active.json: expected exit 2, got $rc"
fi

if echo "$stderr" | grep -q "nonexistent-2026-01-01 not found"; then
  note_pass "stale active.json: error names the missing session"
else
  note_fail "stale active.json: error did not name the missing session. Got: $stderr"
fi

if echo "$stderr" | grep -q "Clearing active pointer"; then
  note_pass "stale active.json: error explains the clear action"
else
  note_fail "stale active.json: error did not mention clearing. Got: $stderr"
fi

if echo "$stderr" | grep -qE "/fly:(plan|work)"; then
  note_pass "stale active.json: error directs the user to /fly:plan or /fly:work"
else
  note_fail "stale active.json: error did not direct the user. Got: $stderr"
fi

if [ ! -f "$ACTIVE" ]; then
  note_pass "stale active.json: active.json is cleared after rescue"
else
  note_fail "stale active.json: active.json still exists after rescue"
fi

# -----------------------------------------------------------------------------
# Scenario 4: after rescue, re-invocation hits scenario 1 (no active.json)
# -----------------------------------------------------------------------------
stderr=$(check_active_session "$ACTIVE" "$SESSIONS" 2>&1 >/dev/null)
rc=$?
if [ "$rc" = "3" ] && echo "$stderr" | grep -q "No active session"; then
  note_pass "post-rescue: next invocation reports no-active (clean state)"
else
  note_fail "post-rescue: expected exit 3 + no-active; got rc=$rc stderr=$stderr"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
