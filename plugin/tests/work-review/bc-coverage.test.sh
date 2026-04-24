#!/usr/bin/env bash
# BC coverage compliance check test for work-review Phase 1.0 Check 2.
#
# Usage: bash tests/work-review/bc-coverage.test.sh
#
# Check 2 (BC coverage): for each baseline.behavioral_contract[].id NOT in
# the union of state.phases[].bc_satisfied[], emit a plan-scope P1 finding
# with bc_id set. Mirrors the jq logic documented in work-review SKILL.md
# Phase 1.0 Check 2.
#
# This test implements the same check inline in jq and asserts:
#   - baseline-5bcs + state-covers-4bcs → one P1 finding for BC-A-005
#   - baseline-3bcs-allcovered + state-covers-3bcs → no findings
#   - emitted findings validate against flywheel/schemas/findings.schema.json
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
FIX="$REPO_ROOT/tests/work-review/fixtures"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# -----------------------------------------------------------------------------
# Helper: compute BC coverage findings array.
# -----------------------------------------------------------------------------
bc_coverage() {
  local baseline="$1"
  local state="$2"

  jq -n \
    --slurpfile b "$baseline" \
    --slurpfile s "$state" '
    ($b[0]) as $B
    | ($s[0]) as $S
    | ($B.behavioral_contract | map(.id)) as $required
    | (
        [ $S.phases[].bc_satisfied[] ] | unique
      ) as $satisfied
    | ($required - $satisfied) as $missing
    | $missing
    | map({
        title: "Behavioral contract \(.) has no satisfying task",
        severity: "P1",
        scope: { kind: "plan", bc_id: . },
        what_wrong: "Baseline declares \(.) but no phase satisfied it (absent from union of state.phases[].bc_satisfied[]).",
        suggested_fix: "Add a task that fulfills \(.) or amend the baseline to remove the BC.",
        evidence: "Union of state.phases[].bc_satisfied[] does not include \(.)."
      })
  '
}

# Validate findings array via envelope shape.
validate_findings_array() {
  local findings_arr="$1"
  # ajv-cli sniffs the file extension; path must end in .json.
  local dir
  dir=$(mktemp -d -t wr_bc_findings_XXXXXX)
  local tmp="$dir/envelope.json"
  jq -n --argjson f "$findings_arr" '{
    schema_version: 1,
    reviewer: "synthesizer",
    summary: "BC coverage mechanical check output. Envelope wrapping the array so the schema validates; production path runs this through the synthesizer before writing review.findings.json. The summary field is padded to satisfy the 100-char minimum.",
    findings: $f,
    residual_risks: [],
    open_questions: []
  }' > "$tmp"
  "${AJV[@]}" validate -s "$SCHEMAS/findings.schema.json" -d "$tmp" >/dev/null 2>&1
  local rc=$?
  rm -rf "$dir"
  return $rc
}

# -----------------------------------------------------------------------------
# Test 1: baseline-5bcs + state-covers-4bcs → one P1 finding, bc_id BC-A-005.
# -----------------------------------------------------------------------------
out=$(bc_coverage "$FIX/baseline-5bcs.json" "$FIX/state-covers-4bcs.json")

count=$(echo "$out" | jq 'length')
if [ "$count" = "1" ]; then
  note_pass "5 BCs / 4 covered: exactly 1 finding emitted"
else
  note_fail "5 BCs / 4 covered: expected 1 finding, got $count"
  echo "$out" | jq '.'
fi

bc_id=$(echo "$out" | jq -r '.[0].scope.bc_id')
if [ "$bc_id" = "BC-A-005" ]; then
  note_pass "5 BCs / 4 covered: bc_id = BC-A-005"
else
  note_fail "5 BCs / 4 covered: expected bc_id = BC-A-005, got '$bc_id'"
fi

kind=$(echo "$out" | jq -r '.[0].scope.kind')
if [ "$kind" = "plan" ]; then
  note_pass "5 BCs / 4 covered: scope.kind = plan"
else
  note_fail "5 BCs / 4 covered: expected scope.kind = plan, got '$kind'"
fi

sev=$(echo "$out" | jq -r '.[0].severity')
if [ "$sev" = "P1" ]; then
  note_pass "5 BCs / 4 covered: severity = P1"
else
  note_fail "5 BCs / 4 covered: expected severity = P1, got '$sev'"
fi

title=$(echo "$out" | jq -r '.[0].title')
if echo "$title" | grep -qi "BC-A-005"; then
  note_pass "5 BCs / 4 covered: title mentions uncovered BC id"
else
  note_fail "5 BCs / 4 covered: title should mention BC-A-005 — got: $title"
fi

if validate_findings_array "$out"; then
  note_pass "5 BCs / 4 covered: findings envelope validates against findings.schema.json"
else
  note_fail "5 BCs / 4 covered: findings envelope failed schema validation"
fi

# -----------------------------------------------------------------------------
# Test 2: baseline-3bcs-allcovered + state-covers-3bcs → no findings.
# -----------------------------------------------------------------------------
out=$(bc_coverage "$FIX/baseline-3bcs-allcovered.json" "$FIX/state-covers-3bcs.json")
count=$(echo "$out" | jq 'length')
if [ "$count" = "0" ]; then
  note_pass "3 BCs / all covered: no findings emitted"
else
  note_fail "3 BCs / all covered: expected 0 findings, got $count"
  echo "$out" | jq '.'
fi

# Still needs to validate (empty findings array is valid).
if validate_findings_array "$out"; then
  note_pass "3 BCs / all covered: findings envelope validates against findings.schema.json"
else
  note_fail "3 BCs / all covered: findings envelope failed schema validation"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
