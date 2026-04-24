#!/usr/bin/env bash
# Fingerprint script test runner.
#
# Usage: bash tests/reviewers/fingerprint.test.sh
#
# Exercises flywheel/synthesizer/fingerprint.sh against the new contract:
# pre-grouped findings in, finalized findings out (severity promoted on
# multi-reviewer matches, stable fingerprint attached, reviewers_matched
# stamped).
#
# The LLM synthesizer is responsible for semantic dedup (deciding which
# findings are the same issue); this script is a pure policy function
# operating on the caller's grouping.
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FP="$REPO_ROOT/flywheel/synthesizer/fingerprint.sh"

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# -----------------------------------------------------------------------------
# Test 1: --help prints the contract without touching stdin.
# -----------------------------------------------------------------------------
help_out=$("$FP" --help 2>&1)
if echo "$help_out" | grep -q "CONTRACT"; then
  note_pass "help: --help prints CONTRACT section"
else
  note_fail "help: --help did not print CONTRACT"
fi
if echo "$help_out" | grep -q "stdin:"; then
  note_pass "help: --help documents stdin shape"
else
  note_fail "help: --help did not document stdin"
fi

# -----------------------------------------------------------------------------
# Test 2: single-reviewer group — severity unchanged, reviewers_matched set.
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-elegance"],
   "finding": {
     "title": "Module-level Flask app precludes factory pattern",
     "severity": "P3",
     "scope": {"kind": "plan", "phase_id": "phase-1"},
     "what_wrong": "app = Flask(__name__) at module scope.",
     "suggested_fix": "Move to a create_app() factory.",
     "evidence": "scratch-api/app.py:4"
   }}
]
JSON
)

sev=$(echo "$out" | jq -r '.[0].finding.severity')
if [ "$sev" = "P3" ]; then
  note_pass "single-reviewer: severity unchanged (P3 stays P3)"
else
  note_fail "single-reviewer: expected P3, got $sev"
fi

count=$(echo "$out" | jq -r '.[0].match_count')
if [ "$count" = "1" ]; then
  note_pass "single-reviewer: match_count=1"
else
  note_fail "single-reviewer: expected match_count=1, got $count"
fi

# -----------------------------------------------------------------------------
# Test 3: multi-reviewer group — severity promoted one level.
# P2 with 2+ reviewers → P1.
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-architecture", "reviewer-code-quality", "reviewer-patterns"],
   "finding": {
     "title": "conftest.py missing for Flask test client fixture",
     "severity": "P2",
     "scope": {"kind": "plan", "phase_id": "phase-1", "bc_id": "BC-AUTH-001"},
     "what_wrong": "No shared fixture; tests duplicate client setup.",
     "suggested_fix": "Add scratch-api/tests/conftest.py with a client fixture.",
     "evidence": "phase-1 files list lacks conftest.py"
   }}
]
JSON
)

sev=$(echo "$out" | jq -r '.[0].finding.severity')
if [ "$sev" = "P1" ]; then
  note_pass "multi-reviewer P2+3 reviewers: promoted P2 → P1"
else
  note_fail "multi-reviewer P2: expected P1, got $sev"
fi

count=$(echo "$out" | jq -r '.[0].match_count')
if [ "$count" = "3" ]; then
  note_pass "multi-reviewer: match_count=3"
else
  note_fail "multi-reviewer: expected match_count=3, got $count"
fi

rs=$(echo "$out" | jq -r '.[0].reviewers_matched | length')
if [ "$rs" = "3" ]; then
  note_pass "multi-reviewer: reviewers_matched has 3 entries"
else
  note_fail "multi-reviewer: expected 3 reviewers_matched, got $rs"
fi

# -----------------------------------------------------------------------------
# Test 4: P3 with 2 reviewers promotes to P2 (one step only).
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-code-quality", "reviewer-patterns"],
   "finding": {
     "title": "prefer f-string over concat",
     "severity": "P3",
     "scope": {"kind": "code", "file": "src/helper.py", "line": 12},
     "what_wrong": "string + int readability",
     "suggested_fix": "use f-string",
     "evidence": "src/helper.py:12"
   }}
]
JSON
)
sev=$(echo "$out" | jq -r '.[0].finding.severity')
if [ "$sev" = "P2" ]; then
  note_pass "P3 with 2 reviewers: promoted P3 → P2 (one step)"
else
  note_fail "P3 with 2 reviewers: expected P2, got $sev"
fi

# -----------------------------------------------------------------------------
# Test 5: P1 with 3 reviewers stays P1 (no promotion above P1).
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-a", "reviewer-b", "reviewer-c"],
   "finding": {
     "title": "p1 thing",
     "severity": "P1",
     "scope": {"kind": "code", "file": "src/boot.py", "line": 1},
     "what_wrong": "x","suggested_fix": "y","evidence": "z"
   }}
]
JSON
)
sev=$(echo "$out" | jq -r '.[0].finding.severity')
if [ "$sev" = "P1" ]; then
  note_pass "P1 with 3 reviewers: stays P1 (no upward promotion)"
else
  note_fail "P1 with 3 reviewers: expected P1, got $sev"
fi

# -----------------------------------------------------------------------------
# Test 6: code-scope fingerprint format.
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-code-quality"],
   "finding": {
     "title": "parseDate validates input",
     "severity": "P2",
     "scope": {"kind": "code", "file": "src/auth.ts", "line": 42},
     "what_wrong": "x","suggested_fix": "y","evidence": "z"
   }}
]
JSON
)
fp=$(echo "$out" | jq -r '.[0].fingerprint')
expected="code:src/auth.ts:42:parsedate-validates-input"
if [ "$fp" = "$expected" ]; then
  note_pass "code scope fingerprint: $expected"
else
  note_fail "code scope: expected $expected, got $fp"
fi

# -----------------------------------------------------------------------------
# Test 7: plan-scope fingerprint with all three IDs.
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-architecture"],
   "finding": {
     "title": "error handling missing",
     "severity": "P2",
     "scope": {"kind": "plan", "phase_id": "phase-2", "task_id": "t3", "bc_id": "BC-AUTH-001"},
     "what_wrong": "x","suggested_fix": "y","evidence": "z"
   }}
]
JSON
)
fp=$(echo "$out" | jq -r '.[0].fingerprint')
expected="plan:phase-2:t3:BC-AUTH-001:error-handling-missing"
if [ "$fp" = "$expected" ]; then
  note_pass "plan scope fingerprint (all IDs): $expected"
else
  note_fail "plan scope: expected $expected, got $fp"
fi

# -----------------------------------------------------------------------------
# Test 8: plan-scope fingerprint with missing task_id → "*" in slot.
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-elegance"],
   "finding": {
     "title": "spec has no review gate",
     "severity": "P2",
     "scope": {"kind": "plan", "phase_id": "phase-3", "bc_id": "BC-REVIEWERS-004"},
     "what_wrong": "x","suggested_fix": "y","evidence": "z"
   }}
]
JSON
)
fp=$(echo "$out" | jq -r '.[0].fingerprint')
expected="plan:phase-3:*:BC-REVIEWERS-004:spec-has-no-review-gate"
if [ "$fp" = "$expected" ]; then
  note_pass "plan scope fingerprint (missing task_id → '*'): $expected"
else
  note_fail "plan scope missing task: expected $expected, got $fp"
fi

# -----------------------------------------------------------------------------
# Test 9: code-scope line:null → "*" in fingerprint.
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-code-quality"],
   "finding": {
     "title": "File has an issue",
     "severity": "P3",
     "scope": {"kind": "code", "file": "src/auth.ts", "line": null},
     "what_wrong": "x","suggested_fix": "y","evidence": "z"
   }}
]
JSON
)
fp=$(echo "$out" | jq -r '.[0].fingerprint')
expected="code:src/auth.ts:*:file-has-an-issue"
if [ "$fp" = "$expected" ]; then
  note_pass "code scope line:null → '*': $expected"
else
  note_fail "line-null: expected $expected, got $fp"
fi

# -----------------------------------------------------------------------------
# Test 10: title slugification — punctuation, caps, spaces collapsed.
# -----------------------------------------------------------------------------
out=$(cat <<'JSON' | "$FP"
[
  {"reviewers": ["reviewer-x"],
   "finding": {
     "title": "Foo: BAR!! baz (qux)",
     "severity": "P3",
     "scope": {"kind": "code", "file": "x.py", "line": 1},
     "what_wrong": "x","suggested_fix": "y","evidence": "z"
   }}
]
JSON
)
fp=$(echo "$out" | jq -r '.[0].fingerprint')
if echo "$fp" | grep -qE ':foo-bar-baz-qux$'; then
  note_pass "slugification: punctuation + caps normalized"
else
  note_fail "slugification: unexpected slug in $fp"
fi

# -----------------------------------------------------------------------------
# Test 11: empty input → empty array out.
# -----------------------------------------------------------------------------
out=$(echo '[]' | "$FP")
if [ "$(echo "$out" | jq 'length')" = "0" ]; then
  note_pass "empty input: empty array out"
else
  note_fail "empty input: expected [], got $out"
fi

# -----------------------------------------------------------------------------
echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
