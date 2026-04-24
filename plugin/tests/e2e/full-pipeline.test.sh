#!/usr/bin/env bash
# E2E: full pipeline integration test (plan-creation → plan-review →
# plan-consolidation → work-implementation baseline → work-review).
#
# Usage: bash tests/e2e/full-pipeline.test.sh
#
# Per Phase 5 T5.1: this is a **simulated** E2E — no skills are actually
# invoked. The test writes the JSON artifacts each phase would produce,
# then asserts the artifact relationships, routing decisions, and hash
# invariants hold through the pipeline.
#
# Pipeline exercised:
#   1. plan-creation output    → spec.json (origin.created_by = plan-creation)
#   2. routing heuristic check → plan-review (spec only, no baseline)
#   3. plan-review output      → findings.json
#   4. plan-consolidation      → spec.json.pre-consolidation backup + updated spec
#   5. work-implementation boot → baseline.json + baseline_hash in session.json
#   6. routing heuristic check → work-review (baseline present)
#   7. work-review Phase 1.0   → Check 2 emits no findings (all BCs satisfied)
#
# Safety: this test MUST restore the pre-existing active.json (if any)
# after running. It MUST NOT touch real session directories. It operates
# only on a temp session dir created inside the repo under
# .flywheel/plugin/sessions/<fixture-slug>-2026-04-23/ and cleans up on
# EXIT via trap.
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
FLYWHEEL_DIR="$REPO_ROOT/.flywheel/plugin"
SESSIONS_DIR="$FLYWHEEL_DIR/sessions"
ACTIVE="$FLYWHEEL_DIR/active.json"

# Unique session id so we do not collide with any real session.
SESSION_ID="e2e-full-pipeline-2026-04-23"
SESSION_DIR="$SESSIONS_DIR/$SESSION_ID"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

# ---- Preserve any existing active.json through the test --------------------
ACTIVE_BACKUP=""
if [ -f "$ACTIVE" ]; then
  ACTIVE_BACKUP=$(mktemp -t e2e_active_backup_XXXXXX.json)
  cp "$ACTIVE" "$ACTIVE_BACKUP"
fi

cleanup() {
  # Tear down the fake session.
  rm -rf "$SESSION_DIR"
  # Restore active.json from backup, or remove if none existed.
  if [ -n "$ACTIVE_BACKUP" ] && [ -f "$ACTIVE_BACKUP" ]; then
    cp "$ACTIVE_BACKUP" "$ACTIVE"
    rm -f "$ACTIVE_BACKUP"
  else
    # Only remove if it's the pointer this test created.
    if [ -f "$ACTIVE" ] && [ "$(jq -r '.session_id' "$ACTIVE" 2>/dev/null)" = "$SESSION_ID" ]; then
      rm -f "$ACTIVE"
    fi
  fi
}
trap cleanup EXIT

mkdir -p "$SESSION_DIR"
mkdir -p "$FLYWHEEL_DIR"

# ---- route_review: mirror the routing heuristic ---------------------------
# Matches session-detection.md "/fly:review Routing Heuristic (D9)" and
# the shell helper in tests/work/routing.test.sh.
route_review() {
  local arguments="${1:-}"
  local session_dir="${2:-}"
  if [[ "$arguments" =~ ^#?[0-9]+$ ]]; then
    echo "work-review"; return 0
  fi
  if [ -n "$arguments" ] && [[ "$arguments" == */* || "$arguments" =~ ^[a-zA-Z][a-zA-Z0-9._-]*$ ]]; then
    echo "work-review"; return 0
  fi
  if [ -z "$session_dir" ]; then
    echo "No active session and no PR/branch argument. Run /fly:plan first." >&2
    return 4
  fi
  if [ -f "$session_dir/baseline.json" ]; then
    echo "work-review"; return 0
  fi
  if [ -f "$session_dir/spec.json" ]; then
    echo "plan-review"; return 0
  fi
  echo "No spec to review. Run /fly:plan first." >&2
  return 4
}

# ---- Step 1: simulate plan-creation writing spec.json ----------------------
cat > "$SESSION_DIR/spec.json" <<EOF
{
  "schema_version": 1,
  "plan_id": "$SESSION_ID",
  "summary": "E2E fixture: full-pipeline integration test. Simulates the spec.json that plan-creation would emit for a two-BC feature. Paired with a state fixture that satisfies both BCs in a single phase so the work-review BC coverage check emits no findings.",
  "goal": "Exercise the full rigor-gradient pipeline end-to-end against fake artifacts.",
  "origin": {
    "created_by": "plan-creation",
    "findings_path": null
  },
  "context": {
    "key_files": ["src/example.ts"],
    "patterns": [],
    "gotchas": []
  },
  "behavioral_contract": [
    {
      "id": "BC-E2E-001",
      "title": "First E2E contract",
      "description": "Contract number one for the E2E fixture feature.",
      "evidence": "Test for BC-E2E-001 in tests/example.test.ts.",
      "area": "example"
    },
    {
      "id": "BC-E2E-002",
      "title": "Second E2E contract",
      "description": "Contract number two for the E2E fixture feature.",
      "evidence": "Test for BC-E2E-002 in tests/example.test.ts.",
      "area": "example"
    }
  ],
  "phases": [
    {
      "id": "phase-1",
      "goal": "Implement the example feature.",
      "depends_on": [],
      "files": ["src/example.ts"],
      "tasks": [
        {
          "id": "t1.1",
          "description": "Implement the behavior for BC-E2E-001 and BC-E2E-002.",
          "files": ["src/example.ts"],
          "test_scenarios": ["both contracts satisfied"],
          "fulfills": ["BC-E2E-001", "BC-E2E-002"]
        }
      ],
      "verification": "bun run test tests/example.test.ts",
      "manual_verification": "N/A for fixture"
    }
  ],
  "success_criteria": ["All BCs satisfied"]
}
EOF

# Minimal session.json for the fixture.
cat > "$SESSION_DIR/session.json" <<EOF
{
  "schema_version": 1,
  "session_id": "$SESSION_ID",
  "slug": "e2e-full-pipeline",
  "status": "active",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": null,
  "active_skill": null,
  "baseline_hash": null
}
EOF

# Update active.json to point at this session.
printf '{"schema_version":1,"session_id":"%s"}' "$SESSION_ID" > "$ACTIVE.tmp"
mv "$ACTIVE.tmp" "$ACTIVE"

# ---- Test 1: spec.json validates against schema ---------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SESSION_DIR/spec.json" >/dev/null 2>&1; then
  note_pass "plan-creation output: spec.json validates"
else
  note_fail "plan-creation output: spec.json did not validate"
fi

# ---- Test 2: session.json validates ---------------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/session.schema.json" -d "$SESSION_DIR/session.json" >/dev/null 2>&1; then
  note_pass "plan-creation output: session.json validates"
else
  note_fail "plan-creation output: session.json did not validate"
fi

# ---- Test 3: origin.created_by == plan-creation ---------------------------
origin=$(jq -r '.origin.created_by' "$SESSION_DIR/spec.json")
if [ "$origin" = "plan-creation" ]; then
  note_pass "plan-creation output: origin.created_by == 'plan-creation'"
else
  note_fail "plan-creation output: expected 'plan-creation', got '$origin'"
fi

# ---- Test 4: routing heuristic chooses plan-review (spec only) ------------
out=$(route_review "" "$SESSION_DIR")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "plan-review" ]; then
  note_pass "routing: spec-only session → plan-review"
else
  note_fail "routing: expected plan-review (exit 0), got '$out' (exit $rc)"
fi

# ---- Step 2: simulate plan-review writing findings.json -------------------
cat > "$SESSION_DIR/findings.json" <<'EOF'
{
  "schema_version": 1,
  "reviewer": "synthesizer",
  "summary": "E2E fixture: synthesizer findings for the full-pipeline test. One P2 finding recommending more specific test scenarios in t1.1. No P1 issues. The findings are lightweight and meant to exercise the consolidation merge path — they do not require new BCs or phase restructuring.",
  "findings": [
    {
      "title": "test_scenarios in t1.1 could be more specific",
      "severity": "P2",
      "scope": {
        "kind": "plan",
        "phase_id": "phase-1",
        "task_id": "t1.1"
      },
      "what_wrong": "The single test_scenario 'both contracts satisfied' is too vague to serve as a TDD guide — reviewers cannot tell from the scenario what specific behaviors to assert.",
      "suggested_fix": "Break the test_scenarios into per-contract assertions: one for BC-E2E-001, one for BC-E2E-002.",
      "evidence": "task.test_scenarios has a single vague entry."
    }
  ],
  "residual_risks": [],
  "open_questions": []
}
EOF

# ---- Test 5: findings.json validates --------------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/findings.schema.json" -d "$SESSION_DIR/findings.json" >/dev/null 2>&1; then
  note_pass "plan-review output: findings.json validates"
else
  note_fail "plan-review output: findings.json did not validate"
fi

# ---- Step 3: simulate plan-consolidation ----------------------------------
# Back up pre-consolidation spec.
cp "$SESSION_DIR/spec.json" "$SESSION_DIR/spec.json.pre-consolidation"

# Produce a new spec.json with the P2 finding integrated: split the vague
# scenario into two per-BC scenarios and flip origin to plan-consolidation.
jq --arg path ".flywheel/plugin/sessions/$SESSION_ID/findings.json" '
  .origin.created_by = "plan-consolidation"
  | .origin.findings_path = $path
  | .phases[0].tasks[0].test_scenarios = [
      "BC-E2E-001 behavior asserted",
      "BC-E2E-002 behavior asserted"
    ]
' "$SESSION_DIR/spec.json.pre-consolidation" > "$SESSION_DIR/spec.json.tmp"
mv "$SESSION_DIR/spec.json.tmp" "$SESSION_DIR/spec.json"

# ---- Test 6: pre-consolidation backup exists ------------------------------
if [ -f "$SESSION_DIR/spec.json.pre-consolidation" ]; then
  note_pass "consolidation: spec.json.pre-consolidation backup exists"
else
  note_fail "consolidation: spec.json.pre-consolidation backup missing"
fi

# ---- Test 7: origin transitioned to plan-consolidation --------------------
origin=$(jq -r '.origin.created_by' "$SESSION_DIR/spec.json")
if [ "$origin" = "plan-consolidation" ]; then
  note_pass "consolidation: origin.created_by flipped to 'plan-consolidation'"
else
  note_fail "consolidation: expected 'plan-consolidation', got '$origin'"
fi

# ---- Test 8: origin.findings_path points at the session's findings.json ---
findings_path=$(jq -r '.origin.findings_path' "$SESSION_DIR/spec.json")
if [ "$findings_path" = ".flywheel/plugin/sessions/$SESSION_ID/findings.json" ]; then
  note_pass "consolidation: origin.findings_path points at session findings.json"
else
  note_fail "consolidation: expected findings_path, got '$findings_path'"
fi

# ---- Test 9: refined spec still validates ---------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SESSION_DIR/spec.json" >/dev/null 2>&1; then
  note_pass "consolidation: refined spec.json validates"
else
  note_fail "consolidation: refined spec.json did not validate"
fi

# ---- Test 10: plan_id preserved across consolidation ----------------------
pre_pid=$(jq -r '.plan_id' "$SESSION_DIR/spec.json.pre-consolidation")
post_pid=$(jq -r '.plan_id' "$SESSION_DIR/spec.json")
if [ "$pre_pid" = "$post_pid" ]; then
  note_pass "consolidation: plan_id preserved ($post_pid)"
else
  note_fail "consolidation: plan_id changed ('$pre_pid' → '$post_pid')"
fi

# ---- Step 4: simulate work-implementation baseline write ------------------
# Copy spec to baseline and inject baseline_frozen_at.
jq '. + { baseline_frozen_at: "2026-04-23T13:00:00Z" }' "$SESSION_DIR/spec.json" > "$SESSION_DIR/baseline.json.tmp"
mv "$SESSION_DIR/baseline.json.tmp" "$SESSION_DIR/baseline.json"

# Compute SHA-256 and write to session.json.
BASELINE_HASH=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
jq --arg hash "$BASELINE_HASH" '.baseline_hash = $hash' "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"

# ---- Test 11: baseline.json validates (composed schema) ------------------
if "${AJV[@]}" validate -s "$SCHEMAS/baseline.schema.json" -r "$SCHEMAS/task-list.schema.json" -d "$SESSION_DIR/baseline.json" >/dev/null 2>&1; then
  note_pass "work-impl boot: baseline.json validates"
else
  note_fail "work-impl boot: baseline.json did not validate"
fi

# ---- Test 12: baseline_hash is 64-char lowercase hex ----------------------
if [[ "$BASELINE_HASH" =~ ^[a-f0-9]{64}$ ]]; then
  note_pass "work-impl boot: baseline_hash is 64-char lowercase hex"
else
  note_fail "work-impl boot: baseline_hash is not valid SHA-256 hex: $BASELINE_HASH"
fi

# ---- Test 13: session.json validates with new hash ------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/session.schema.json" -d "$SESSION_DIR/session.json" >/dev/null 2>&1; then
  note_pass "work-impl boot: session.json validates with baseline_hash"
else
  note_fail "work-impl boot: session.json did not validate with baseline_hash"
fi

# ---- Test 14: routing heuristic now chooses work-review (baseline present)
out=$(route_review "" "$SESSION_DIR")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "work-review" ]; then
  note_pass "routing: with-baseline session → work-review"
else
  note_fail "routing: expected work-review (exit 0), got '$out' (exit $rc)"
fi

# ---- Step 5: simulate state.json with all BCs covered ---------------------
cat > "$SESSION_DIR/state.json" <<EOF
{
  "schema_version": 1,
  "session_id": "$SESSION_ID",
  "status": "completed",
  "summary": "E2E state fixture: phase-1 completed, both BCs (BC-E2E-001, BC-E2E-002) satisfied by task t1.1 verification. Work-review BC coverage check should emit zero findings because the union of bc_satisfied across phases equals the baseline BC set.",
  "phases": [
    {
      "id": "phase-1",
      "status": "completed",
      "started_at": "2026-04-23T13:10:00Z",
      "completed_at": "2026-04-23T13:30:00Z",
      "outcomes": ["Both contracts satisfied"],
      "strikes": [],
      "bc_satisfied": ["BC-E2E-001", "BC-E2E-002"],
      "artifacts": {
        "files_created": ["src/example.ts"],
        "files_modified": [],
        "commands_run": [
          {
            "command": "bun run test tests/example.test.ts",
            "exit_code": 0,
            "stdout_tail": "2 pass",
            "re_executable": true
          }
        ]
      }
    }
  ],
  "learnings": [],
  "error_log": []
}
EOF

# ---- Test 15: state.json validates ---------------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/state.schema.json" -d "$SESSION_DIR/state.json" >/dev/null 2>&1; then
  note_pass "work-impl state: state.json validates"
else
  note_fail "work-impl state: state.json did not validate"
fi

# ---- Test 16: run the Phase 4b BC-coverage mechanical check ---------------
# Per work-review SKILL.md Phase 1.0 Check 2: union of state.phases[].bc_satisfied[]
# must cover every baseline BC. Missing BCs → P1 findings.
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
  note_pass "work-review Phase 1.0 Check 2: all BCs covered, 0 findings (happy path)"
else
  note_fail "work-review Phase 1.0 Check 2: expected 0 missing BCs, got $missing_count"
  echo "$missing" | jq '.'
fi

# ---- Test 17: baseline hash re-verification matches on resume -------------
fresh_hash=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
stored_hash=$(jq -r '.baseline_hash' "$SESSION_DIR/session.json")
if [ "$fresh_hash" = "$stored_hash" ]; then
  note_pass "work-impl resume: baseline hash re-verification matches"
else
  note_fail "work-impl resume: baseline hash mismatch (fresh=$fresh_hash stored=$stored_hash)"
fi

# ---- Test 18: active.json still points at the right session ---------------
active_session=$(jq -r '.session_id' "$ACTIVE")
if [ "$active_session" = "$SESSION_ID" ]; then
  note_pass "pipeline: active.json still points at the right session"
else
  note_fail "pipeline: active.json drifted — session_id=$active_session expected $SESSION_ID"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
