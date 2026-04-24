#!/usr/bin/env bash
# Work-implementation adapter test.
#
# Usage: bash tests/work/adapter.test.sh
#
# work-implementation's Phase 1 adapter consumes either:
#   (a) spec.json  — produced by plan-creation or plan-consolidation. No
#       transformation required; the spec IS the TaskList.
#   (b) findings.json — when invoked in fix-findings mode (no spec present or
#       explicit findings path). The adapter synthesizes a TaskList by
#       grouping findings into file-scoped phases and generating BCs from
#       finding titles.
#
# This test is a static fixture check — the adapter is a procedural rule in
# work-implementation/references/load-resume-procedures.md, not an executable
# script. We validate:
#
#   1. spec-input.json validates against task-list.schema.json (input shape)
#   2. findings-input.json validates against findings.schema.json (input shape)
#   3. findings-derived-tasklist.json validates against task-list.schema.json
#      (output shape after the adapter runs)
#   4. findings-derived-tasklist.json has origin.created_by ==
#      "work-implementation-adapter" (proof of adapter provenance)
#   5. findings-derived-tasklist.json has origin.findings_path set (traceable)
#   6. Every finding from findings-input.json is represented by a task in the
#      derived TaskList (no findings lost in translation)
#   7. BC coverage holds in the derived TaskList (every BC is claimed)
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
FIX="$REPO_ROOT/tests/work/fixtures"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# -----------------------------------------------------------------------------
# Test 1: spec-input.json validates against task-list.schema.json
# -----------------------------------------------------------------------------
out=$("${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$FIX/spec-input.json" 2>&1)
if [ $? -eq 0 ]; then
  note_pass "spec-input.json validates against task-list.schema.json"
else
  note_fail "spec-input.json did not validate"
  echo "$out"
fi

# -----------------------------------------------------------------------------
# Test 2: findings-input.json validates against findings.schema.json
# -----------------------------------------------------------------------------
out=$("${AJV[@]}" validate -s "$SCHEMAS/findings.schema.json" -d "$FIX/findings-input.json" 2>&1)
if [ $? -eq 0 ]; then
  note_pass "findings-input.json validates against findings.schema.json"
else
  note_fail "findings-input.json did not validate"
  echo "$out"
fi

# -----------------------------------------------------------------------------
# Test 3: findings-derived-tasklist.json validates against task-list.schema.json
# (proves the adapter produces a valid TaskList)
# -----------------------------------------------------------------------------
out=$("${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$FIX/findings-derived-tasklist.json" 2>&1)
if [ $? -eq 0 ]; then
  note_pass "findings-derived-tasklist.json validates against task-list.schema.json"
else
  note_fail "findings-derived-tasklist.json did not validate"
  echo "$out"
fi

# -----------------------------------------------------------------------------
# Test 4: derived tasklist has origin.created_by == "work-implementation-adapter"
# -----------------------------------------------------------------------------
created_by=$(jq -r '.origin.created_by' "$FIX/findings-derived-tasklist.json")
if [ "$created_by" = "work-implementation-adapter" ]; then
  note_pass "origin.created_by == 'work-implementation-adapter'"
else
  note_fail "origin.created_by expected 'work-implementation-adapter', got '$created_by'"
fi

# -----------------------------------------------------------------------------
# Test 5: derived tasklist has origin.findings_path pointing to input fixture
# -----------------------------------------------------------------------------
findings_path=$(jq -r '.origin.findings_path' "$FIX/findings-derived-tasklist.json")
if [ "$findings_path" != "null" ] && [[ "$findings_path" == *"findings-input.json"* ]]; then
  note_pass "origin.findings_path points to findings-input.json: $findings_path"
else
  note_fail "origin.findings_path expected non-null findings-input.json reference, got '$findings_path'"
fi

# -----------------------------------------------------------------------------
# Test 6: every finding from findings-input.json has a corresponding task
# in findings-derived-tasklist.json (no findings lost)
# -----------------------------------------------------------------------------
finding_count=$(jq '.findings | length' "$FIX/findings-input.json")
task_count=$(jq '[.phases[].tasks[]] | length' "$FIX/findings-derived-tasklist.json")
if [ "$finding_count" = "$task_count" ]; then
  note_pass "finding count ($finding_count) matches task count ($task_count) — no findings lost"
else
  note_fail "finding count ($finding_count) != task count ($task_count)"
fi

# -----------------------------------------------------------------------------
# Test 7: BC coverage holds in derived tasklist (every BC claimed by a task)
# -----------------------------------------------------------------------------
orphans=$(jq -r '
  (.behavioral_contract | map(.id)) as $bcs
  | ([.phases[].tasks[].fulfills[]] | unique) as $claimed
  | $bcs - $claimed
  | .[]
' "$FIX/findings-derived-tasklist.json")

if [ -z "$orphans" ]; then
  note_pass "BC coverage: every BC in derived tasklist is claimed"
else
  note_fail "orphan BC(s) in derived tasklist: $orphans"
fi

# -----------------------------------------------------------------------------
# Test 8: each finding's file appears in at least one phase's files[]
# (adapter groups by file — findings don't lose their file context)
# -----------------------------------------------------------------------------
missing_files=""
while IFS= read -r f; do
  if ! jq -e --arg f "$f" '[.phases[].files[]] | any(. == $f)' \
       "$FIX/findings-derived-tasklist.json" >/dev/null; then
    missing_files="${missing_files}${f} "
  fi
done < <(jq -r '.findings[].scope.file' "$FIX/findings-input.json" | sort -u)

if [ -z "$missing_files" ]; then
  note_pass "every finding's file appears in at least one phase's files[]"
else
  note_fail "files missing from phases: $missing_files"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
