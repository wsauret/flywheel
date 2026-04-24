#!/usr/bin/env bash
# Pipeline: plan-creation static validation test.
#
# Usage: bash tests/pipeline/plan-create.test.sh
#
# plan-creation is a SKILL.md interpreted by Claude, not a runnable script. This
# test validates a reference fixture (what plan-creation WOULD produce for a
# trivial feature) against the task-list schema plus structural invariants:
#
#   - spec validates against flywheel/schemas/task-list.schema.json
#   - plan_id matches session-id pattern: <slug>-<YYYY-MM-DD>
#   - origin.created_by == "plan-creation"
#   - origin.findings_path is null
#   - summary length 100..5000 chars
#   - every BC id matches ^BC-[A-Z0-9]+-\d{3}$
#   - BC coverage: every BC is claimed by at-least-one task.fulfills (D13)
#
# Live-dogfood validation (actually invoking the SKILL) is deferred to Phase 5.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
FIXTURE="$REPO_ROOT/tests/pipeline/fixtures/trivial-spec.json"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# -----------------------------------------------------------------------------
# Test 1: fixture validates against task-list.schema.json
# -----------------------------------------------------------------------------
output=$("${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$FIXTURE" 2>&1)
rc=$?
if [ $rc -eq 0 ]; then
  note_pass "trivial-spec.json validates against task-list.schema.json"
else
  note_fail "trivial-spec.json did not validate"
  echo "----- ajv output -----"
  echo "$output"
  echo "----------------------"
fi

# -----------------------------------------------------------------------------
# Test 2: plan_id matches session-id pattern <slug>-<YYYY-MM-DD>[-N]
# -----------------------------------------------------------------------------
plan_id=$(jq -r '.plan_id' "$FIXTURE")
if [[ "$plan_id" =~ ^[a-z0-9-]+-[0-9]{4}-[0-9]{2}-[0-9]{2}(-[0-9]+)?$ ]]; then
  note_pass "plan_id '$plan_id' matches session-id pattern"
else
  note_fail "plan_id '$plan_id' does not match ^[a-z0-9-]+-\\d{4}-\\d{2}-\\d{2}(-\\d+)?\$"
fi

# -----------------------------------------------------------------------------
# Test 3: origin.created_by == "plan-creation"
# -----------------------------------------------------------------------------
created_by=$(jq -r '.origin.created_by' "$FIXTURE")
if [ "$created_by" = "plan-creation" ]; then
  note_pass "origin.created_by == 'plan-creation'"
else
  note_fail "origin.created_by expected 'plan-creation', got '$created_by'"
fi

# -----------------------------------------------------------------------------
# Test 4: origin.findings_path is null (plan-creation has not run consolidation)
# -----------------------------------------------------------------------------
findings_path=$(jq -r '.origin.findings_path' "$FIXTURE")
if [ "$findings_path" = "null" ]; then
  note_pass "origin.findings_path is null"
else
  note_fail "origin.findings_path expected null, got '$findings_path'"
fi

# -----------------------------------------------------------------------------
# Test 5: summary length in [100, 5000]
# -----------------------------------------------------------------------------
summary_len=$(jq -r '.summary | length' "$FIXTURE")
if [ "$summary_len" -ge 100 ] && [ "$summary_len" -le 5000 ]; then
  note_pass "summary length $summary_len in [100, 5000]"
else
  note_fail "summary length $summary_len not in [100, 5000]"
fi

# -----------------------------------------------------------------------------
# Test 6: every BC id matches BC-<AREA>-<NNN>
# -----------------------------------------------------------------------------
bad_ids=$(jq -r '[.behavioral_contract[].id | select(test("^BC-[A-Z0-9]+-[0-9]{3}$") | not)] | length' "$FIXTURE")
if [ "$bad_ids" = "0" ]; then
  note_pass "all BC ids match ^BC-[A-Z0-9]+-[0-9]{3}\$"
else
  note_fail "$bad_ids BC id(s) do not match pattern"
  jq -r '.behavioral_contract[].id' "$FIXTURE"
fi

# -----------------------------------------------------------------------------
# Test 7: BC coverage — every BC is claimed by at-least-one task.fulfills
# (per D13: orphans = error at creation)
# -----------------------------------------------------------------------------
orphans=$(jq -r '
  (.behavioral_contract | map(.id)) as $bcs
  | ([.phases[].tasks[].fulfills[]] | unique) as $claimed
  | $bcs - $claimed
  | .[]
' "$FIXTURE")

if [ -z "$orphans" ]; then
  note_pass "BC coverage: every BC claimed by at-least-one task"
else
  note_fail "orphan BC(s) detected (no task claim): $orphans"
fi

# -----------------------------------------------------------------------------
echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
