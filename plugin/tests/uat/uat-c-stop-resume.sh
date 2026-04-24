#!/usr/bin/env bash
# Module: UAT-C Stop + Resume
#
# plan-creation -> plan-review -> STOP (kill claude)
# Fresh claude session -> /fly:work -> completes using persisted active.json
#
# Verifies session state survives across claude restarts: active.json points at
# the right session, work-implementation picks up from spec+findings without
# requiring consolidation.

source "$(dirname "$0")/lib/harness.sh"
init_harness "uat-c-stop-resume" "$@"

mkdir -p "$UAT_DIR/string-utils"
cat > "$UAT_DIR/string-utils/README.md" <<EOF
# String Utils
UAT fixture: stop-and-resume path.
EOF

start_claude

# T-01: plan + review, then stop
echo "T-01: plan and review, then stop"
send_prompt "/fly:plan Add a python module string-utils/strutils.py with two functions: reverse(s) and count_words(s). Plan this as a single phase with two tasks and two behavioral contracts. Include pytest. After writing the plan, run /fly:review to analyze it. Then STOP (do NOT run consolidate or work)."

wait_for_file "$UAT_DIR/.flywheel/plugin/active.json" "$WAIT_PLAN" || fail "T-01a-plan-written" "active.json never appeared"
detect_active_session || exit 1

# Wait for the review to finish producing findings.json
wait_for_file "$ACTIVE_SESSION_DIR/findings.json" "$WAIT_REVIEW" || fail "T-01b-findings" "findings.json never appeared"
capture "T-01-pre-stop.log" 3

assert_file        "T-01c-spec"     "$ACTIVE_SESSION_DIR/spec.json"
assert_file        "T-01d-findings" "$ACTIVE_SESSION_DIR/findings.json"
assert_file_absent "T-01e-no-base"  "$ACTIVE_SESSION_DIR/baseline.json"
assert_file_absent "T-01f-no-state" "$ACTIVE_SESSION_DIR/state.json"

# Preserve session id for comparison after restart
pre_restart_sid=$(jq -r '.session_id' "$UAT_DIR/.flywheel/plugin/active.json")

# T-02: stop claude; start a fresh claude session in the same workspace
echo "T-02: restart claude"
restart_claude

# T-03: fresh claude picks up the session via active.json and resumes with /fly:work
echo "T-03: /fly:work resumes via active.json"
send_prompt "/fly:work"

wait_for_file "$ACTIVE_SESSION_DIR/baseline.json" 300 || fail "T-03a-baseline" "baseline not written after restart"
wait_for_file "$ACTIVE_SESSION_DIR/state.json"    60  || fail "T-03b-state"    "state not written"
capture "T-03-resumed.log" 3

# active.json unchanged across restart
post_restart_sid=$(jq -r '.session_id' "$UAT_DIR/.flywheel/plugin/active.json")
if [ "$pre_restart_sid" = "$post_restart_sid" ]; then
  pass "T-03c-session-preserved" "session_id=$pre_restart_sid"
else
  fail "T-03c-session-preserved" "pre=$pre_restart_sid post=$post_restart_sid"
fi

# T-04: work completes under the resumed session
echo "T-04: work finishes after resume"
wait_for_work_complete "$WAIT_WORK" || fail "T-04a-work-complete" "not all phases completed after resume"
capture "T-04-work-done.log" 3

baseline_phases=$(jq -r '.phases[].id' "$ACTIVE_SESSION_DIR/baseline.json" | sort)
completed_phases=$(jq -r '.phases[] | select(.status == "completed") | .id' "$ACTIVE_SESSION_DIR/state.json" | sort)
if [ "$baseline_phases" = "$completed_phases" ]; then
  pass "T-04b-phase-handoff" "all phases completed after resume"
else
  fail "T-04b-phase-handoff" "baseline=[$baseline_phases] completed=[$completed_phases]"
fi

baseline_bcs=$(jq -r '.behavioral_contract[].id' "$ACTIVE_SESSION_DIR/baseline.json" | sort -u)
satisfied_bcs=$(jq -r '[.phases[].bc_satisfied[]] | .[]' "$ACTIVE_SESSION_DIR/state.json" | sort -u)
missing_bcs=$(comm -23 <(echo "$baseline_bcs") <(echo "$satisfied_bcs"))
if [ -z "$missing_bcs" ]; then
  bc_count=$(echo "$baseline_bcs" | grep -c .)
  pass "T-04c-bc-coverage" "$bc_count BCs satisfied"
else
  fail "T-04c-bc-coverage" "uncovered=$missing_bcs"
fi

assert_session_valid "$ACTIVE_SESSION_DIR" "T-04d"

stop_claude
finish_harness
