#!/usr/bin/env bash
# Pipeline: plan-consolidation static validation test.
#
# Usage: bash tests/pipeline/plan-consolidate.test.sh
#
# plan-consolidation is a SKILL.md interpreted by Claude, not a runnable script.
# This test validates the before/findings/after fixture relationship:
#
#   - pre-consolidation-spec.json validates + origin.created_by == "plan-creation"
#   - sample-findings.json validates against findings.schema.json
#   - post-consolidation-spec.json validates + origin.created_by == "plan-consolidation"
#   - post-consolidation.origin.findings_path points to a findings.json
#   - post-consolidation BC coverage still holds (per D13)
#   - post-consolidation retains the same plan_id (same session, refined spec)
#   - post-consolidation integrates P1 suggested_fix language into the affected task
#
# Live-dogfood validation is deferred to Phase 5.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
FIX="$REPO_ROOT/tests/pipeline/fixtures"
PRE="$FIX/pre-consolidation-spec.json"
FIND="$FIX/sample-findings.json"
POST="$FIX/post-consolidation-spec.json"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# -----------------------------------------------------------------------------
# Test 1: pre-consolidation-spec.json validates against task-list schema
# -----------------------------------------------------------------------------
output=$("${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$PRE" 2>&1)
if [ $? -eq 0 ]; then
  note_pass "pre-consolidation-spec.json validates"
else
  note_fail "pre-consolidation-spec.json did not validate"
  echo "$output"
fi

# -----------------------------------------------------------------------------
# Test 2: pre-consolidation origin.created_by == "plan-creation"
# -----------------------------------------------------------------------------
pre_created_by=$(jq -r '.origin.created_by' "$PRE")
if [ "$pre_created_by" = "plan-creation" ]; then
  note_pass "pre-consolidation origin.created_by == 'plan-creation'"
else
  note_fail "pre-consolidation origin.created_by expected 'plan-creation', got '$pre_created_by'"
fi

# -----------------------------------------------------------------------------
# Test 3: sample-findings.json validates against findings schema
# -----------------------------------------------------------------------------
output=$("${AJV[@]}" validate -s "$SCHEMAS/findings.schema.json" -d "$FIND" 2>&1)
if [ $? -eq 0 ]; then
  note_pass "sample-findings.json validates"
else
  note_fail "sample-findings.json did not validate"
  echo "$output"
fi

# -----------------------------------------------------------------------------
# Test 4: post-consolidation-spec.json validates against task-list schema
# -----------------------------------------------------------------------------
output=$("${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$POST" 2>&1)
if [ $? -eq 0 ]; then
  note_pass "post-consolidation-spec.json validates"
else
  note_fail "post-consolidation-spec.json did not validate"
  echo "$output"
fi

# -----------------------------------------------------------------------------
# Test 5: post-consolidation origin.created_by == "plan-consolidation"
# -----------------------------------------------------------------------------
post_created_by=$(jq -r '.origin.created_by' "$POST")
if [ "$post_created_by" = "plan-consolidation" ]; then
  note_pass "post-consolidation origin.created_by == 'plan-consolidation'"
else
  note_fail "post-consolidation origin.created_by expected 'plan-consolidation', got '$post_created_by'"
fi

# -----------------------------------------------------------------------------
# Test 6: post-consolidation origin.findings_path is non-null and points to a
# findings.json path (not enforced to exist — fixture is relationship check)
# -----------------------------------------------------------------------------
post_findings_path=$(jq -r '.origin.findings_path' "$POST")
if [ "$post_findings_path" != "null" ] && [[ "$post_findings_path" == *"findings.json"* ]]; then
  note_pass "post-consolidation findings_path points to findings.json: $post_findings_path"
else
  note_fail "post-consolidation findings_path expected non-null findings.json reference, got '$post_findings_path'"
fi

# -----------------------------------------------------------------------------
# Test 7: BC coverage holds after consolidation (per D13)
# -----------------------------------------------------------------------------
orphans=$(jq -r '
  (.behavioral_contract | map(.id)) as $bcs
  | ([.phases[].tasks[].fulfills[]] | unique) as $claimed
  | $bcs - $claimed
  | .[]
' "$POST")

if [ -z "$orphans" ]; then
  note_pass "post-consolidation BC coverage: every BC claimed"
else
  note_fail "post-consolidation orphan BC(s): $orphans"
fi

# -----------------------------------------------------------------------------
# Test 8: plan_id is preserved across consolidation (same session)
# -----------------------------------------------------------------------------
pre_id=$(jq -r '.plan_id' "$PRE")
post_id=$(jq -r '.plan_id' "$POST")
if [ "$pre_id" = "$post_id" ]; then
  note_pass "plan_id preserved across consolidation: $pre_id"
else
  note_fail "plan_id changed: pre='$pre_id' post='$post_id'"
fi

# -----------------------------------------------------------------------------
# Test 9: P1 finding is integrated — post-consolidation task description
# references the finally-block / clear-alarm fix
# -----------------------------------------------------------------------------
t12_desc=$(jq -r '.phases[0].tasks[] | select(.id == "t1.2") | .description' "$POST")
if echo "$t12_desc" | grep -qi "finally"; then
  note_pass "P1 finding integrated into task t1.2 (mentions 'finally' block)"
else
  note_fail "P1 finding not visible in task t1.2 description"
  echo "t1.2 description: $t12_desc"
fi

# -----------------------------------------------------------------------------
# Test 10: .pre-consolidation sidecar relationship — pre/post differ on summary
# (consolidation updated the summary; sidecar would preserve the pre state)
# -----------------------------------------------------------------------------
pre_summary=$(jq -r '.summary' "$PRE")
post_summary=$(jq -r '.summary' "$POST")
if [ "$pre_summary" != "$post_summary" ]; then
  note_pass "consolidation changed summary — sidecar would preserve pre state"
else
  note_fail "pre and post summary identical; no refinement evidence"
fi

# -----------------------------------------------------------------------------
echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
