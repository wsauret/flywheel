#!/usr/bin/env bash
# Module: UAT-B Skip-Review
#
# plan-creation -> work-implementation (no review, no consolidation)
# Verifies the skip-review happy path: spec.json goes straight to baseline+state,
# no orphaned findings.json or pre-consolidation sidecar.

source "$(dirname "$0")/lib/harness.sh"
init_harness "uat-b-skip-review" "$@"

mkdir -p "$UAT_DIR/cli-tool"
cat > "$UAT_DIR/cli-tool/README.md" <<EOF
# CLI Tool
UAT fixture: skip-review path.
EOF

start_claude

# T-01: prompt explicitly instructs skip-review
echo "T-01: plan then work, skipping review"
send_prompt "I want to skip review. First /fly:plan for: add a python CLI to cli-tool/ with two commands: 'greet NAME' that prints Hello NAME, and 'sum A B' that prints A+B. Plan as two phases, one per command. Then IMMEDIATELY after the plan is written, without running review, invoke /fly:work to implement. Do not run /fly:review or /fly:consolidate at any point."

# Wait for session dir to exist
wait_for_file "$UAT_DIR/.flywheel/plugin/active.json" "$WAIT_PLAN" || fail "T-01a-plan-written" "active.json never appeared"
detect_active_session || exit 1
capture "T-01-plan-created.log" 2

assert_file    "T-01b-spec"       "$ACTIVE_SESSION_DIR/spec.json"
assert_file    "T-01c-context"    "$ACTIVE_SESSION_DIR/context.md"
assert_file    "T-01d-session"    "$ACTIVE_SESSION_DIR/session.json"

# T-02: work starts, baseline written from raw spec.json
# The agent transitions from plan to work internally; give it the review timeout
# since it may deliberate and re-read files before invoking /fly:work.
echo "T-02: baseline + state appear from raw spec"
wait_for_file "$ACTIVE_SESSION_DIR/baseline.json" "$WAIT_REVIEW" || fail "T-02a-baseline" "baseline.json never appeared"
wait_for_file "$ACTIVE_SESSION_DIR/state.json"    "$WAIT_MEDIUM" || fail "T-02b-state" "state.json never appeared"
capture "T-02-work-boot.log" 2

# T-03: skip-review invariants: no findings, no pre-consolidation, origin still plan-creation
assert_file_absent "T-03a-no-findings"    "$ACTIVE_SESSION_DIR/findings.json"
assert_file_absent "T-03b-no-sidecar"     "$ACTIVE_SESSION_DIR/spec.json.pre-consolidation"
assert_json_eq    "T-03c-origin-unchanged" "$ACTIVE_SESSION_DIR/spec.json" ".origin.created_by" "plan-creation"
assert_json_eq    "T-03d-findings-path-null" "$ACTIVE_SESSION_DIR/spec.json" ".origin.findings_path" "null"

# T-04: work completes, every phase+BC accounted for
echo "T-04: work-implementation finishes all phases"
wait_for_work_complete "$WAIT_WORK" || fail "T-04a-work-complete" "not all phases completed in $WAIT_WORK s"
capture "T-04-work-done.log" 3

baseline_phases=$(jq -r '.phases[].id' "$ACTIVE_SESSION_DIR/baseline.json" | sort)
completed_phases=$(jq -r '.phases[] | select(.status == "completed") | .id' "$ACTIVE_SESSION_DIR/state.json" | sort)
if [ "$baseline_phases" = "$completed_phases" ]; then
  pass "T-04b-phase-handoff" "all baseline phases completed"
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

# Full schema + handoff validator pass
assert_session_valid "$ACTIVE_SESSION_DIR" "T-04d"

stop_claude
finish_harness
