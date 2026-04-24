#!/usr/bin/env bash
# Module: UAT-A Full Pipeline
#
# plan-creation -> plan-review -> plan-consolidation -> work-implementation -> work-review
# Multi-phase task (3 Flask endpoints, one per phase) verifies every baseline phase
# lands in state and every BC is satisfied.

source "$(dirname "$0")/lib/harness.sh"
init_harness "uat-a-full-pipeline" "$@"

# Prepare workspace: a greenfield scratch-api subdir
mkdir -p "$UAT_DIR/scratch-api"
cat > "$UAT_DIR/scratch-api/README.md" <<EOF
# Scratch API
UAT fixture for flywheel plugin full-pipeline test.
EOF

start_claude

# T-01: plan-creation emits a spec with three phases, one per endpoint
echo "T-01: plan-creation multi-phase"
send_prompt "/fly:plan Add three Flask endpoints to scratch-api/: GET /hello returning 'hello world', GET /health returning JSON {status: 'ok'}, and GET /echo?msg=X returning the msg query param. Plan this as three separate phases, one endpoint per phase. Include pytest coverage for each endpoint in its phase."

wait_for_file "$UAT_DIR/.flywheel/plugin/active.json" "$WAIT_PLAN" || fail "T-01a-plan-written" "active.json never appeared"
detect_active_session || exit 1
capture "T-01-plan-created.log" 2

assert_file            "T-01b-spec.json"    "$ACTIVE_SESSION_DIR/spec.json"
assert_file            "T-01c-context.md"   "$ACTIVE_SESSION_DIR/context.md"
assert_file            "T-01d-session.json" "$ACTIVE_SESSION_DIR/session.json"
assert_json_eq         "T-01e-origin-creator"    "$ACTIVE_SESSION_DIR/spec.json" ".origin.created_by" "plan-creation"
assert_json_eq         "T-01f-findings-path-null" "$ACTIVE_SESSION_DIR/spec.json" ".origin.findings_path" "null"

# Validate schema shape of what plan-creation just wrote
assert_session_valid "$ACTIVE_SESSION_DIR" "T-01g"

# T-02: plan-review produces findings.json with scope.kind=plan
echo "T-02: plan-review"
wait_for_file "$ACTIVE_SESSION_DIR/findings.json" "$WAIT_REVIEW" || fail "T-02a-findings-written" "findings.json never appeared"
capture "T-02-review-done.log" 2

assert_json_eq         "T-02b-reviewer"           "$ACTIVE_SESSION_DIR/findings.json" ".reviewer"   "synthesizer"
# All findings during plan-review should be plan-scoped
scope_count=$(jq -r '[.findings[].scope.kind] | unique | length' "$ACTIVE_SESSION_DIR/findings.json")
scope_kind=$(jq -r '[.findings[].scope.kind] | unique | .[0]' "$ACTIVE_SESSION_DIR/findings.json")
if [ "$scope_count" = "1" ] && [ "$scope_kind" = "plan" ]; then
  pass "T-02c-scope-kind-plan" "all findings are scope.kind=plan"
else
  fail "T-02c-scope-kind-plan" "unique scopes=$scope_count first=$scope_kind"
fi

# T-03: plan-consolidation writes pre-consolidation sidecar and flips origin
echo "T-03: plan-consolidation"
wait_for_file "$ACTIVE_SESSION_DIR/spec.json.pre-consolidation" "$WAIT_REVIEW" || fail "T-03a-sidecar" "pre-consolidation sidecar never appeared"
capture "T-03-consolidation-done.log" 3

assert_json_eq         "T-03b-origin-flipped"     "$ACTIVE_SESSION_DIR/spec.json" ".origin.created_by" "plan-consolidation"
assert_json_eq         "T-03c-sidecar-origin"     "$ACTIVE_SESSION_DIR/spec.json.pre-consolidation" ".origin.created_by" "plan-creation"

# T-04: work-implementation writes baseline+state; each phase completes
echo "T-04: work-implementation (expect interactive prompt)"
# After consolidation the skill asks "what next?" — answer by invoking /fly:work.
# In some flows the orchestrator auto-chains; sending /fly:work is idempotent.
sleep 5
send_prompt "/fly:work"
wait_for_file "$ACTIVE_SESSION_DIR/baseline.json" "$WAIT_REVIEW" || fail "T-04a-baseline-written" "baseline.json never appeared"
wait_for_file "$ACTIVE_SESSION_DIR/state.json"    "$WAIT_MEDIUM" || true

# baseline_hash in session.json must match shasum of baseline.json
stored=$(jq -r '.baseline_hash // ""' "$ACTIVE_SESSION_DIR/session.json")
computed=$(shasum -a 256 "$ACTIVE_SESSION_DIR/baseline.json" | awk '{print $1}')
if [ "$stored" = "$computed" ] && [ -n "$stored" ]; then
  pass "T-04b-hash-match" "baseline_hash=$stored"
else
  fail "T-04b-hash-match" "stored=$stored computed=$computed"
fi

# Wait for work to run through all phases
wait_for_work_complete "$WAIT_WORK" || fail "T-04c-work-complete" "not all phases completed in $WAIT_WORK s"
capture "T-04-work-done.log" 3

# Every baseline phase ID shows up in state with status=completed
baseline_phases=$(jq -r '.phases[].id' "$ACTIVE_SESSION_DIR/baseline.json" | sort)
completed_phases=$(jq -r '.phases[] | select(.status == "completed") | .id' "$ACTIVE_SESSION_DIR/state.json" | sort)
if [ "$baseline_phases" = "$completed_phases" ]; then
  pass "T-04d-phase-handoff" "all baseline phases completed in state"
else
  fail "T-04d-phase-handoff" "baseline=[$baseline_phases] completed=[$completed_phases]"
fi

# Every BC satisfied
baseline_bcs=$(jq -r '.behavioral_contract[].id' "$ACTIVE_SESSION_DIR/baseline.json" | sort -u)
satisfied_bcs=$(jq -r '[.phases[].bc_satisfied[]] | .[]' "$ACTIVE_SESSION_DIR/state.json" | sort -u)
missing_bcs=$(comm -23 <(echo "$baseline_bcs") <(echo "$satisfied_bcs"))
if [ -z "$missing_bcs" ]; then
  bc_count=$(echo "$baseline_bcs" | grep -c .)
  pass "T-04e-bc-coverage" "$bc_count BCs satisfied"
else
  fail "T-04e-bc-coverage" "uncovered=$missing_bcs"
fi

# No scope drift: every state file is declared in baseline
baseline_files=$(jq -r '[.phases[].files[]] | unique | .[]' "$ACTIVE_SESSION_DIR/baseline.json" | sort -u)
state_files=$(jq -r '[.phases[].artifacts.files_created[], .phases[].artifacts.files_modified[]] | unique | .[]' "$ACTIVE_SESSION_DIR/state.json" | sort -u)
if [ -z "$state_files" ]; then
  pass "T-04f-no-drift" "no files written (unusual)"
else
  drift=$(comm -23 <(echo "$state_files") <(echo "$baseline_files"))
  if [ -z "$drift" ]; then
    file_count=$(echo "$state_files" | grep -c .)
    pass "T-04f-no-drift" "$file_count state files all in baseline"
  else
    fail "T-04f-no-drift" "out-of-scope=$drift"
  fi
fi

# Full-session validator (schemas + all cross-artifact rules)
assert_session_valid "$ACTIVE_SESSION_DIR" "T-04g"

stop_claude
finish_harness
