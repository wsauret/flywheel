#!/usr/bin/env bash
# Structured-diff compliance check test for work-review Phase 1.0 Check 1.
#
# Usage: bash tests/work-review/diff.test.sh
#
# Check 1 (structured diff) detects three classes of scope drift:
#
#   (a) Skipped phases — baseline.phases[].id absent from state.phases[] where
#       status == "completed". Emits plan-scope P1 finding with phase_id set.
#   (b) Files outside baseline — any path in state.phases[].artifacts.files_*
#       that is NOT in the corresponding baseline phase's files[]. Emits
#       code-scope P1 finding with file set.
#   (c) Removed tasks — baseline.phases[].tasks[].id with no corresponding
#       mention in state.phases[].outcomes. Emits plan-scope P1 finding with
#       phase_id and task_id set.
#
# The SKILL.md documents the logic. This test implements the same jq
# pipeline inline and asserts it produces the expected findings against the
# fixtures. The emitted findings must also validate against
# flywheel/schemas/findings.schema.json.
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
# Helper: run structured-diff against a baseline+state pair and emit an array
# of K1-shape findings. Mirrors the jq logic documented in SKILL.md Phase 1.0
# Check 1. Implemented in jq so the logic is reproducible outside the LLM.
# -----------------------------------------------------------------------------
structured_diff() {
  local baseline="$1"
  local state="$2"

  jq -n \
    --slurpfile b "$baseline" \
    --slurpfile s "$state" '
    ($b[0]) as $B
    | ($s[0]) as $S
    | [
        # (a) Skipped phases
        ( $B.phases[] as $bp
          | ($S.phases[] | select(.id == $bp.id)) as $sp
          | if ($sp | not) or ($sp.status != "completed")
              then {
                title: "Phase \($bp.id) skipped but baseline requires it",
                severity: "P1",
                scope: { kind: "plan", phase_id: $bp.id },
                what_wrong: "Baseline phase \($bp.id) is not marked completed in state.",
                suggested_fix: "Implement the phase or amend the baseline to remove it.",
                evidence: "state.phases[].status for \($bp.id) is \($sp.status // "absent")."
              }
            else empty
          end
        ),
        # (b) Files outside baseline
        ( $B.phases[] as $bp
          | ($S.phases[] | select(.id == $bp.id)) as $sp
          | if $sp
              then
                (($sp.artifacts.files_created + $sp.artifacts.files_modified) // []) as $touched
                | $touched[]
                | . as $f
                | if ($bp.files | index($f)) then empty
                  else {
                    title: "File outside baseline scope modified",
                    severity: "P1",
                    scope: { kind: "code", file: $f, line: null },
                    what_wrong: "state.phases[\($bp.id)].artifacts touched \($f) but baseline.phases[\($bp.id)].files[] does not include it.",
                    suggested_fix: "Remove the edit or amend the baseline to include \($f).",
                    evidence: "state.phases[\($bp.id)].artifacts files_modified/files_created listed \($f)."
                  }
                end
              else empty
          end
        ),
        # (c) Removed tasks — evidence surface is outcomes[] (whether any
        # baseline task id is explicitly cited). If outcomes reference any
        # baseline task ids in this phase, interpret them as the completed
        # subset; baseline task ids NOT in outcomes are treated as removed.
        # If outcomes reference no task ids at all, we cannot distinguish
        # coverage and skip the check for that phase (silence over false
        # positives).
        ( $B.phases[] as $bp
          | ($S.phases[] | select(.id == $bp.id)) as $sp
          | if $sp
              then
                ($sp.outcomes // []) as $outc
                | ($outc | join("\n")) as $outc_text
                | ($bp.tasks | map(.id)) as $task_ids
                | ($task_ids | map(select(. as $id | $outc_text | test($id; "i")))) as $mentioned
                | if ($mentioned | length) == 0 then
                    empty
                  else
                    $bp.tasks[]
                    | . as $t
                    | if ($mentioned | index($t.id)) then empty
                      else {
                        title: "Task removed from implementation",
                        severity: "P1",
                        scope: { kind: "plan", phase_id: $bp.id, task_id: $t.id },
                        what_wrong: "Baseline task \($t.id) in \($bp.id) is not referenced in state outcomes.",
                        suggested_fix: "Implement task \($t.id) or amend baseline to remove it.",
                        evidence: "state.phases[\($bp.id)].outcomes does not mention task id \($t.id)."
                      }
                    end
                  end
              else empty
          end
        )
      ]
  '
}

# Validate a JSON findings-array by wrapping in a reviewer-output envelope
# (the schema requires the envelope shape). Return 0 if valid.
validate_findings_array() {
  local findings_arr="$1"
  # ajv-cli sniffs the file extension, so the path MUST end in .json.
  # mktemp -t on mac appends its own random suffix after the template, so
  # build the path manually in a dedicated temp directory.
  local dir
  dir=$(mktemp -d -t wr_findings_XXXXXX)
  local tmp="$dir/envelope.json"
  jq -n --argjson f "$findings_arr" '{
    schema_version: 1,
    reviewer: "synthesizer",
    summary: "Structured-diff mechanical check output. This fixture stands in as a reviewer-shaped envelope for schema validation. In production these findings come from work-review Phase 1.0 and are merged through the synthesizer write path into review.findings.json.",
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
# Test 1: skipped phase (baseline-3phases + state-2-completed) → plan-scope P1
# finding with phase_id = "phase-c".
# -----------------------------------------------------------------------------
out=$(structured_diff "$FIX/baseline-3phases.json" "$FIX/state-2-completed.json")

# Expect at least one finding citing phase-c as skipped.
if echo "$out" | jq -e '
  any(
    .scope.kind == "plan"
    and .scope.phase_id == "phase-c"
    and (.title | test("skipped"; "i"))
  )
' >/dev/null; then
  note_pass "skipped phase: phase-c emits plan-scope P1 finding"
else
  note_fail "skipped phase: expected plan-scope P1 finding with phase_id = phase-c"
  echo "$out" | jq '.'
fi

# Severity must be P1 for the skipped-phase finding.
sev=$(echo "$out" | jq -r '
  map(select(.scope.kind == "plan" and .scope.phase_id == "phase-c")) | .[0].severity
')
if [ "$sev" = "P1" ]; then
  note_pass "skipped phase: severity = P1"
else
  note_fail "skipped phase: severity expected P1, got '$sev'"
fi

# Findings must validate against findings.schema.json.
if validate_findings_array "$out"; then
  note_pass "skipped phase: findings envelope validates against findings.schema.json"
else
  note_fail "skipped phase: findings envelope failed schema validation"
  validate_findings_array "$out" || true  # echo the failure
fi

# -----------------------------------------------------------------------------
# Test 2: files outside baseline (baseline-files-abc + state-modified-abz) →
# code-scope P1 finding for Z.
# -----------------------------------------------------------------------------
out=$(structured_diff "$FIX/baseline-files-abc.json" "$FIX/state-modified-abz.json")

if echo "$out" | jq -e '
  any(
    .scope.kind == "code"
    and .scope.file == "src/z.ts"
  )
' >/dev/null; then
  note_pass "files outside baseline: src/z.ts emits code-scope P1 finding"
else
  note_fail "files outside baseline: expected code-scope P1 finding with file = src/z.ts"
  echo "$out" | jq '.'
fi

# Must NOT emit a drift finding for A or B (they're in baseline).
# (We do allow the task-removal check to emit plan-scope findings citing phase-1,
# but we explicitly check that no code-scope finding cites src/a.ts or src/b.ts.)
extra_drift=$(echo "$out" | jq '
  map(select(.scope.kind == "code" and (.scope.file == "src/a.ts" or .scope.file == "src/b.ts"))) | length
')
if [ "$extra_drift" = "0" ]; then
  note_pass "files outside baseline: no false positives for A or B"
else
  note_fail "files outside baseline: unexpected drift finding for A or B ($extra_drift such findings)"
  echo "$out" | jq '.'
fi

if validate_findings_array "$out"; then
  note_pass "files outside baseline: findings envelope validates against findings.schema.json"
else
  note_fail "files outside baseline: findings envelope failed schema validation"
fi

# -----------------------------------------------------------------------------
# Test 3: removed task (baseline-tasks-123 + state-did-only-12) → plan-scope P1
# finding citing phase-1 and t3.
# -----------------------------------------------------------------------------
out=$(structured_diff "$FIX/baseline-tasks-123.json" "$FIX/state-did-only-12.json")

if echo "$out" | jq -e '
  any(
    .scope.kind == "plan"
    and .scope.phase_id == "phase-1"
    and .scope.task_id == "t3"
  )
' >/dev/null; then
  note_pass "removed task: phase-1/t3 emits plan-scope P1 finding"
else
  note_fail "removed task: expected plan-scope P1 finding with phase_id=phase-1, task_id=t3"
  echo "$out" | jq '.'
fi

# T1 and T2 must NOT produce a removed-task finding (their ids appear in outcomes).
false_removals=$(echo "$out" | jq '
  map(select(.scope.kind == "plan" and (.scope.task_id == "t1" or .scope.task_id == "t2"))) | length
')
if [ "$false_removals" = "0" ]; then
  note_pass "removed task: no false positives for t1 or t2"
else
  note_fail "removed task: t1 or t2 falsely flagged as removed ($false_removals findings)"
  echo "$out" | jq '.'
fi

if validate_findings_array "$out"; then
  note_pass "removed task: findings envelope validates against findings.schema.json"
else
  note_fail "removed task: findings envelope failed schema validation"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
