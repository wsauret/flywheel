#!/usr/bin/env bash
# Schema fixture test runner.
#
# Usage: bash tests/schemas/run.sh
#
# Iterates the fixture suite under tests/schemas/fixtures/ and asserts each
# file validates (or fails to validate) against its schema as expected.
# Exits non-zero on any unexpected result.
#
# ajv-cli does not bundle ajv-formats, so format keywords (e.g. date-time)
# are treated as annotations-only. This is spec-appropriate for JSON Schema
# 2020-12, which does not require format validation by default.
#
# The findings-malformed-reviewer-output.json fixture is for synthesizer
# tests (it is intentionally not parseable JSON), so it is skipped here
# with a notice.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
TEST_ROOT="$REPO_ROOT/tests/schemas"
FIXTURES="$TEST_ROOT/fixtures"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0
skip=0

# ---------------------------------------------------------------------------
# Fixture manifest
#
# Each entry: "<expected>|<schema>|<fixture>[|<referenced-schema>]"
#   expected: "valid" or "invalid"
#   schema:   schema file name under flywheel/schemas/
#   fixture:  fixture file name under tests/schemas/fixtures/
#   referenced-schema (optional): passed via -r for cross-file $ref

FIXTURES_MANIFEST=(
  # findings
  "valid|findings.schema.json|fixtures/findings-valid-code.json"
  "valid|findings.schema.json|fixtures/findings-valid-plan.json"
  "invalid|findings.schema.json|fixtures/findings-missing-summary.json"
  "invalid|findings.schema.json|fixtures/findings-missing-schema-version.json"
  "invalid|findings.schema.json|fixtures/findings-invalid-scope-kind.json"
  "invalid|findings.schema.json|fixtures/findings-missing-scope-kind.json"
  "invalid|findings.schema.json|fixtures/findings-bad-polymorphic-mix.json"
  # findings.example.json is both example and fixture (D4)
  "valid|findings.schema.json|example:findings.example.json"
  # task-list
  "valid|task-list.schema.json|fixtures/task-list-valid.json"
  "valid|task-list.schema.json|fixtures/task-list-orphan-bc.json"
  "invalid|task-list.schema.json|fixtures/task-list-duplicate-bc-id.json"
  "invalid|task-list.schema.json|fixtures/task-list-bad-slug.json"
  # state
  "valid|state.schema.json|fixtures/state-valid.json"
  "valid|state.schema.json|fixtures/state-invalid-paused.json"
  # baseline (needs task-list as referenced schema)
  "valid|baseline.schema.json|fixtures/baseline-valid.json|task-list.schema.json"
  # session
  "valid|session.schema.json|fixtures/session-valid.json"
  "invalid|session.schema.json|fixtures/session-invalid-id-format.json"
)

# findings-malformed-reviewer-output.json is NOT in the manifest above.
# It is intentionally malformed JSON for synthesizer-level testing.
MALFORMED_FIXTURE="$FIXTURES/findings-malformed-reviewer-output.json"
if [ -f "$MALFORMED_FIXTURE" ]; then
  echo "SKIP: findings-malformed-reviewer-output.json (synthesizer test, not schema test)"
  skip=$((skip + 1))
fi

run_case() {
  local expected="$1"
  local schema="$2"
  local fixture="$3"
  local ref_schema="${4:-}"

  local schema_path="$SCHEMAS/$schema"
  local fixture_path
  if [[ "$fixture" = example:* ]]; then
    fixture_path="$SCHEMAS/${fixture#example:}"
  else
    fixture_path="$TEST_ROOT/$fixture"
  fi

  local cmd=("${AJV[@]}" validate -s "$schema_path" -d "$fixture_path")
  if [ -n "$ref_schema" ]; then
    cmd+=(-r "$SCHEMAS/$ref_schema")
  fi

  local output
  output="$("${cmd[@]}" 2>&1)"
  local rc=$?

  local actual="invalid"
  if [ $rc -eq 0 ]; then
    actual="valid"
  fi

  if [ "$actual" = "$expected" ]; then
    echo "PASS: $fixture ($expected vs schema $schema)"
    pass=$((pass + 1))
  else
    echo "FAIL: $fixture expected $expected, got $actual"
    echo "----- ajv output -----"
    echo "$output"
    echo "----------------------"
    fail=$((fail + 1))
  fi
}

for entry in "${FIXTURES_MANIFEST[@]}"; do
  IFS='|' read -r expected schema fixture ref_schema <<< "$entry"
  run_case "$expected" "$schema" "$fixture" "$ref_schema"
done

total=$((pass + fail))
echo ""
echo "Summary: $pass passed, $fail failed, $skip skipped ($total active cases)."

if [ $fail -gt 0 ]; then
  exit 1
fi
exit 0
