#!/usr/bin/env bash
# Baseline hash verification test for work-review Phase 1.0 Check 0.
#
# Usage: bash tests/work-review/hash.test.sh
#
# Check 0 (baseline hash verification): work-review recomputes the SHA-256 of
# baseline.json and compares it to the stored session.json.baseline_hash. If
# they match, proceed. If they mismatch, emit a plan-scope P1 synthetic
# finding titled "Baseline was mutated after work-start" and HALT the
# mechanical checks section.
#
# This test asserts:
#   - normal case (baseline-valid + session-with-matching-hash): fresh
#     shasum == stored hash → no finding
#   - mutated case (baseline-mutated + session-with-old-hash): fresh shasum
#     != stored hash → P1 finding emitted
#   - hash format is 64-char lowercase hex
#   - emitted finding validates against findings.schema.json
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

hash_of() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Check 0 as a pure function: emit a findings array (possibly empty) based on
# baseline + session pair. Mirrors the SKILL.md Phase 1.0 Check 0 procedure.
hash_check() {
  local baseline="$1"
  local session="$2"

  local computed stored
  computed=$(hash_of "$baseline")
  stored=$(jq -r '.baseline_hash' "$session")

  if [ "$computed" = "$stored" ]; then
    # No finding emitted; downstream checks can proceed.
    printf '[]'
  else
    # Mismatch — emit the synthetic P1.
    jq -n --arg computed "$computed" --arg stored "$stored" '[{
      title: "Baseline was mutated after work-start",
      severity: "P1",
      scope: { kind: "plan", phase_id: "*" },
      what_wrong: "SHA-256 of baseline.json (\($computed)) does not match session.json.baseline_hash (\($stored)). The baseline file was altered after work-implementation froze it.",
      suggested_fix: "Investigate what modified baseline.json. If the change is intentional, re-run work-implementation to produce a fresh baseline with an updated hash. Do NOT edit baseline.json directly.",
      evidence: "shasum -a 256 mismatch. Check 0 halts subsequent mechanical checks."
    }]'
  fi
}

validate_findings_array() {
  local findings_arr="$1"
  # ajv-cli sniffs the file extension; path must end in .json.
  local dir
  dir=$(mktemp -d -t wr_hash_findings_XXXXXX)
  local tmp="$dir/envelope.json"
  jq -n --argjson f "$findings_arr" '{
    schema_version: 1,
    reviewer: "synthesizer",
    summary: "Baseline hash verification output (Check 0). Envelope wrapping the findings array to exercise schema validation. Padded to meet the 100-char summary minimum required by findings.schema.json.",
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
# Test 1: hash format
# -----------------------------------------------------------------------------
h=$(hash_of "$FIX/baseline-valid.json")
if [[ "$h" =~ ^[a-f0-9]{64}$ ]]; then
  note_pass "hash format is 64-char lowercase hex ($h)"
else
  note_fail "hash '$h' is not 64-char lowercase hex"
fi

# -----------------------------------------------------------------------------
# Test 2: normal case — baseline-valid + session-with-matching-hash → no finding
# -----------------------------------------------------------------------------
out=$(hash_check "$FIX/baseline-valid.json" "$FIX/session-with-matching-hash.json")
count=$(echo "$out" | jq 'length')
if [ "$count" = "0" ]; then
  note_pass "normal case: no finding emitted"
else
  note_fail "normal case: expected 0 findings, got $count"
  echo "$out" | jq '.'
fi

# Empty findings array still validates.
if validate_findings_array "$out"; then
  note_pass "normal case: empty findings envelope validates against findings.schema.json"
else
  note_fail "normal case: findings envelope failed schema validation"
fi

# Guard: make sure the computed hash actually matches the stored hash in the
# fixture (catches fixture rot — if someone edits baseline-valid.json and
# forgets to update session-with-matching-hash.json, this rings the alarm).
stored=$(jq -r '.baseline_hash' "$FIX/session-with-matching-hash.json")
if [ "$h" = "$stored" ]; then
  note_pass "normal case: fresh shasum == session.baseline_hash (fixture consistent)"
else
  note_fail "normal case: fixture drift — fresh hash ($h) != stored ($stored). Update session-with-matching-hash.json."
fi

# -----------------------------------------------------------------------------
# Test 3: mutated case — baseline-mutated + session-with-old-hash → P1 finding
# -----------------------------------------------------------------------------
out=$(hash_check "$FIX/baseline-mutated.json" "$FIX/session-with-old-hash.json")
count=$(echo "$out" | jq 'length')
if [ "$count" = "1" ]; then
  note_pass "mutated case: exactly 1 finding emitted"
else
  note_fail "mutated case: expected 1 finding, got $count"
  echo "$out" | jq '.'
fi

title=$(echo "$out" | jq -r '.[0].title')
if echo "$title" | grep -qi "mutated"; then
  note_pass "mutated case: title mentions 'mutated'"
else
  note_fail "mutated case: expected title containing 'mutated', got: $title"
fi

sev=$(echo "$out" | jq -r '.[0].severity')
if [ "$sev" = "P1" ]; then
  note_pass "mutated case: severity = P1"
else
  note_fail "mutated case: severity expected P1, got '$sev'"
fi

kind=$(echo "$out" | jq -r '.[0].scope.kind')
if [ "$kind" = "plan" ]; then
  note_pass "mutated case: scope.kind = plan"
else
  note_fail "mutated case: expected scope.kind = plan, got '$kind'"
fi

if validate_findings_array "$out"; then
  note_pass "mutated case: findings envelope validates against findings.schema.json"
else
  note_fail "mutated case: findings envelope failed schema validation"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
