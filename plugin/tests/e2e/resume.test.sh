#!/usr/bin/env bash
# E2E: resume-from-checkpoint integration test.
#
# Usage: bash tests/e2e/resume.test.sh
#
# Per Phase 5 T5.3: simulates a session that was mid-execution when
# context was cleared — state.json has phase 1 completed and phase 2
# pending. The test asserts that the state-parsing logic (which
# work-implementation Phase 1 uses to decide which phase to resume)
# correctly identifies phase 2 as the next phase, and that the baseline
# hash re-verification succeeds.
#
# We do NOT invoke a skill; we exercise the same shell/jq logic the
# SKILL.md documents procedurally.
#
# Scenarios:
#   1. state.json has phase-1 completed, phase-2 pending, phase-3
#      pending → next-phase is phase-2
#   2. state.json has all phases completed → next-phase is empty (work done)
#   3. Baseline hash has NOT been mutated → resume is safe
#   4. Baseline has been mutated (bytes changed) → resume detects mismatch
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
FLYWHEEL_DIR="$REPO_ROOT/.flywheel/plugin"
SESSIONS_DIR="$FLYWHEEL_DIR/sessions"
ACTIVE="$FLYWHEEL_DIR/active.json"

SESSION_ID="e2e-resume-2026-04-23"
SESSION_DIR="$SESSIONS_DIR/$SESSION_ID"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

ACTIVE_BACKUP=""
if [ -f "$ACTIVE" ]; then
  ACTIVE_BACKUP=$(mktemp -t e2e_resume_active_backup_XXXXXX.json)
  cp "$ACTIVE" "$ACTIVE_BACKUP"
fi

cleanup() {
  rm -rf "$SESSION_DIR"
  if [ -n "$ACTIVE_BACKUP" ] && [ -f "$ACTIVE_BACKUP" ]; then
    cp "$ACTIVE_BACKUP" "$ACTIVE"
    rm -f "$ACTIVE_BACKUP"
  else
    if [ -f "$ACTIVE" ] && [ "$(jq -r '.session_id' "$ACTIVE" 2>/dev/null)" = "$SESSION_ID" ]; then
      rm -f "$ACTIVE"
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$SESSION_DIR"
mkdir -p "$FLYWHEEL_DIR"

# ---- find_next_phase: the resume-selection helper --------------------------
# Contract (mirrors work-implementation Phase 1 "Resume case" prose):
#   stdout: phase id of the first non-completed phase, or empty if all done
#   exit 0 always (empty is a valid answer)
find_next_phase() {
  local state_path="$1"
  jq -r '.phases[] | select(.status != "completed") | .id' "$state_path" | head -n 1
}

# ---- verify_baseline_hash: resume safety check ----------------------------
# Contract: exit 0 if hash matches, exit 1 otherwise (halt work-review
# per SKILL.md Phase 1.0 Check 0).
verify_baseline_hash() {
  local baseline="$1"
  local session="$2"
  local fresh stored
  fresh=$(shasum -a 256 "$baseline" | awk '{print $1}')
  stored=$(jq -r '.baseline_hash' "$session")
  [ "$fresh" = "$stored" ]
}

# ---- Step 1: write a baseline + session with a stored hash ----------------
# Baseline mirrors the three-phase spec we'll resume against.
cat > "$SESSION_DIR/baseline.json" <<EOF
{
  "schema_version": 1,
  "plan_id": "$SESSION_ID",
  "summary": "E2E fixture: three-phase baseline for the resume test. Represents the frozen spec at work-implementation boot. The paired state.json has phase-1 completed and phases 2 and 3 pending — simulating a context-clear mid-work.",
  "goal": "Exercise resume-from-checkpoint logic.",
  "origin": {
    "created_by": "plan-creation",
    "findings_path": null
  },
  "context": {
    "key_files": ["src/resume.ts"],
    "patterns": [],
    "gotchas": []
  },
  "behavioral_contract": [
    {
      "id": "BC-RES-001",
      "title": "Resume BC 1",
      "description": "Phase 1 contract.",
      "evidence": "Phase 1 test.",
      "area": "resume"
    },
    {
      "id": "BC-RES-002",
      "title": "Resume BC 2",
      "description": "Phase 2 contract.",
      "evidence": "Phase 2 test.",
      "area": "resume"
    },
    {
      "id": "BC-RES-003",
      "title": "Resume BC 3",
      "description": "Phase 3 contract.",
      "evidence": "Phase 3 test.",
      "area": "resume"
    }
  ],
  "phases": [
    {
      "id": "phase-1",
      "goal": "Phase 1 work.",
      "depends_on": [],
      "files": ["src/resume.ts"],
      "tasks": [
        {
          "id": "t1.1",
          "description": "Do phase 1 work for BC-RES-001.",
          "files": ["src/resume.ts"],
          "test_scenarios": ["BC-RES-001 satisfied"],
          "fulfills": ["BC-RES-001"]
        }
      ],
      "verification": "bun run test tests/resume/p1.test.ts",
      "manual_verification": "N/A"
    },
    {
      "id": "phase-2",
      "goal": "Phase 2 work.",
      "depends_on": ["phase-1"],
      "files": ["src/resume.ts"],
      "tasks": [
        {
          "id": "t2.1",
          "description": "Do phase 2 work for BC-RES-002.",
          "files": ["src/resume.ts"],
          "test_scenarios": ["BC-RES-002 satisfied"],
          "fulfills": ["BC-RES-002"]
        }
      ],
      "verification": "bun run test tests/resume/p2.test.ts",
      "manual_verification": "N/A"
    },
    {
      "id": "phase-3",
      "goal": "Phase 3 work.",
      "depends_on": ["phase-2"],
      "files": ["src/resume.ts"],
      "tasks": [
        {
          "id": "t3.1",
          "description": "Do phase 3 work for BC-RES-003.",
          "files": ["src/resume.ts"],
          "test_scenarios": ["BC-RES-003 satisfied"],
          "fulfills": ["BC-RES-003"]
        }
      ],
      "verification": "bun run test tests/resume/p3.test.ts",
      "manual_verification": "N/A"
    }
  ],
  "success_criteria": ["All three BCs satisfied"],
  "baseline_frozen_at": "2026-04-23T13:00:00Z"
}
EOF

# Compute baseline hash and write session.json.
BASELINE_HASH=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')

cat > "$SESSION_DIR/session.json" <<EOF
{
  "schema_version": 1,
  "session_id": "$SESSION_ID",
  "slug": "e2e-resume",
  "status": "active",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": "2026-04-23T13:15:00Z",
  "active_skill": null,
  "baseline_hash": "$BASELINE_HASH"
}
EOF

# spec.json mirrors baseline (they'd be identical at this point in a real session).
jq 'del(.baseline_frozen_at)' "$SESSION_DIR/baseline.json" > "$SESSION_DIR/spec.json.tmp"
mv "$SESSION_DIR/spec.json.tmp" "$SESSION_DIR/spec.json"

# Partial state: phase-1 completed, phase-2 and phase-3 pending.
cat > "$SESSION_DIR/state.json" <<EOF
{
  "schema_version": 1,
  "session_id": "$SESSION_ID",
  "status": "in_progress",
  "summary": "Partial state for the resume test. Phase 1 completed before context was cleared; phases 2 and 3 are pending. The resume logic should identify phase-2 as the next phase to execute.",
  "phases": [
    {
      "id": "phase-1",
      "status": "completed",
      "started_at": "2026-04-23T13:00:00Z",
      "completed_at": "2026-04-23T13:10:00Z",
      "outcomes": ["Phase 1 work done"],
      "strikes": [],
      "bc_satisfied": ["BC-RES-001"],
      "artifacts": {
        "files_created": ["src/resume.ts"],
        "files_modified": [],
        "commands_run": [
          {
            "command": "bun run test tests/resume/p1.test.ts",
            "exit_code": 0,
            "stdout_tail": "1 pass",
            "re_executable": true
          }
        ]
      }
    },
    {
      "id": "phase-2",
      "status": "pending",
      "started_at": null,
      "completed_at": null,
      "outcomes": [],
      "strikes": [],
      "bc_satisfied": [],
      "artifacts": {
        "files_created": [],
        "files_modified": [],
        "commands_run": []
      }
    },
    {
      "id": "phase-3",
      "status": "pending",
      "started_at": null,
      "completed_at": null,
      "outcomes": [],
      "strikes": [],
      "bc_satisfied": [],
      "artifacts": {
        "files_created": [],
        "files_modified": [],
        "commands_run": []
      }
    }
  ],
  "learnings": ["Phase 1 exposed no surprises"],
  "error_log": []
}
EOF

printf '{"schema_version":1,"session_id":"%s"}' "$SESSION_ID" > "$ACTIVE.tmp"
mv "$ACTIVE.tmp" "$ACTIVE"

# ---- Test 1: all fixtures validate ---------------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/baseline.schema.json" -r "$SCHEMAS/task-list.schema.json" -d "$SESSION_DIR/baseline.json" >/dev/null 2>&1; then
  note_pass "resume fixture: baseline.json validates"
else
  note_fail "resume fixture: baseline.json did not validate"
fi

if "${AJV[@]}" validate -s "$SCHEMAS/state.schema.json" -d "$SESSION_DIR/state.json" >/dev/null 2>&1; then
  note_pass "resume fixture: state.json validates"
else
  note_fail "resume fixture: state.json did not validate"
fi

if "${AJV[@]}" validate -s "$SCHEMAS/session.schema.json" -d "$SESSION_DIR/session.json" >/dev/null 2>&1; then
  note_pass "resume fixture: session.json validates"
else
  note_fail "resume fixture: session.json did not validate"
fi

# ---- Test 2: find_next_phase returns phase-2 ------------------------------
next=$(find_next_phase "$SESSION_DIR/state.json")
if [ "$next" = "phase-2" ]; then
  note_pass "resume: next phase is phase-2 (phase-1 completed, phase-2 pending)"
else
  note_fail "resume: expected phase-2, got '$next'"
fi

# ---- Test 3: state.status is in_progress ---------------------------------
state_status=$(jq -r '.status' "$SESSION_DIR/state.json")
if [ "$state_status" = "in_progress" ]; then
  note_pass "resume: state.status = 'in_progress' reflects partial completion"
else
  note_fail "resume: state.status is '$state_status', expected 'in_progress'"
fi

# ---- Test 4: baseline hash re-verification succeeds (unmutated) ----------
if verify_baseline_hash "$SESSION_DIR/baseline.json" "$SESSION_DIR/session.json"; then
  note_pass "resume: baseline hash re-verification succeeds (no mutation)"
else
  note_fail "resume: baseline hash mismatch on unmutated baseline (should have matched)"
fi

# ---- Test 5: mutate baseline → hash re-verification fails ----------------
# Save original so we can restore for further assertions.
cp "$SESSION_DIR/baseline.json" "$SESSION_DIR/baseline.json.orig"
printf '\n' >> "$SESSION_DIR/baseline.json"

if ! verify_baseline_hash "$SESSION_DIR/baseline.json" "$SESSION_DIR/session.json"; then
  note_pass "resume: mutated baseline triggers hash mismatch (halt signal)"
else
  note_fail "resume: mutated baseline did NOT trigger hash mismatch"
fi

# Restore baseline for further tests.
mv "$SESSION_DIR/baseline.json.orig" "$SESSION_DIR/baseline.json"

# ---- Test 6: all-completed state → next_phase is empty -------------------
jq '
  .status = "completed"
  | .phases = (.phases | map(
      . + {
        status: "completed",
        started_at: (.started_at // "2026-04-23T14:00:00Z"),
        completed_at: (.completed_at // "2026-04-23T14:30:00Z"),
        bc_satisfied: (if (.id == "phase-1") then ["BC-RES-001"]
                       elif (.id == "phase-2") then ["BC-RES-002"]
                       else ["BC-RES-003"] end)
      }
    ))
' "$SESSION_DIR/state.json" > "$SESSION_DIR/state.json.tmp"
mv "$SESSION_DIR/state.json.tmp" "$SESSION_DIR/state.json"

next=$(find_next_phase "$SESSION_DIR/state.json")
if [ -z "$next" ]; then
  note_pass "resume: all phases completed → no next phase (work done)"
else
  note_fail "resume: expected empty next-phase, got '$next'"
fi

# ---- Test 7: BC coverage check passes for all-completed state ------------
missing=$(jq -n \
  --slurpfile b "$SESSION_DIR/baseline.json" \
  --slurpfile s "$SESSION_DIR/state.json" '
  ($b[0]) as $B
  | ($s[0]) as $S
  | ($B.behavioral_contract | map(.id)) as $required
  | ([ $S.phases[].bc_satisfied[] ] | unique) as $satisfied
  | ($required - $satisfied)
')
missing_count=$(echo "$missing" | jq 'length')
if [ "$missing_count" = "0" ]; then
  note_pass "resume: all-completed state covers all BCs (Phase 1.0 Check 2 clean)"
else
  note_fail "resume: expected 0 missing BCs after resume completion, got $missing_count"
  echo "$missing" | jq '.'
fi

# ---- Test 8: baseline hash still matches after all the resume activity ---
if verify_baseline_hash "$SESSION_DIR/baseline.json" "$SESSION_DIR/session.json"; then
  note_pass "resume: baseline hash still matches post-resume (baseline never touched)"
else
  note_fail "resume: baseline hash drifted during test"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
