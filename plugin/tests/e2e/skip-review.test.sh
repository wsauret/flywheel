#!/usr/bin/env bash
# E2E: skip-review integration test (plan-creation → work-implementation).
#
# Usage: bash tests/e2e/skip-review.test.sh
#
# Per Phase 5 T5.2: simulates the skip-review path where the user goes
# directly from plan-creation to work-implementation without invoking
# plan-review or plan-consolidation. The test asserts:
#   - spec.json is created, validates, and has origin.created_by = plan-creation
#   - there is NO findings.json in the session (review was skipped)
#   - there is NO spec.json.pre-consolidation (consolidation was skipped)
#   - work-implementation can still freeze a baseline (baseline.json) and
#     compute a hash
#   - baseline carries the same content as the un-consolidated spec.json
#   - origin.findings_path is null (no findings ever integrated)
#   - work-review BC coverage check (Phase 1.0 Check 2) still passes on a
#     happy-path state.json
#
# Safety: backs up and restores active.json if present; cleans up its
# fake session dir on EXIT via trap.
#
# Exits 0 on success, 1 on any assertion failure.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
FLYWHEEL_DIR="$REPO_ROOT/.flywheel/plugin"
SESSIONS_DIR="$FLYWHEEL_DIR/sessions"
ACTIVE="$FLYWHEEL_DIR/active.json"

SESSION_ID="e2e-skip-review-2026-04-23"
SESSION_DIR="$SESSIONS_DIR/$SESSION_ID"

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }

ACTIVE_BACKUP=""
if [ -f "$ACTIVE" ]; then
  ACTIVE_BACKUP=$(mktemp -t e2e_skip_active_backup_XXXXXX.json)
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
  "summary": "E2E fixture: skip-review test. Simulates the path where a user runs plan-creation and then invokes work-implementation directly without plan-review or plan-consolidation. The spec remains in its original plan-creation state — no findings integrated, no refinements.",
  "goal": "Exercise the skip-review happy path.",
  "origin": {
    "created_by": "plan-creation",
    "findings_path": null
  },
  "context": {
    "key_files": ["src/skip.ts"],
    "patterns": [],
    "gotchas": []
  },
  "behavioral_contract": [
    {
      "id": "BC-SKIP-001",
      "title": "Skip-review BC",
      "description": "The only contract for the skip-review fixture.",
      "evidence": "Test for BC-SKIP-001.",
      "area": "skip"
    }
  ],
  "phases": [
    {
      "id": "phase-1",
      "goal": "Implement the skip-review feature.",
      "depends_on": [],
      "files": ["src/skip.ts"],
      "tasks": [
        {
          "id": "t1.1",
          "description": "Implement behavior for BC-SKIP-001.",
          "files": ["src/skip.ts"],
          "test_scenarios": ["BC-SKIP-001 behavior asserted"],
          "fulfills": ["BC-SKIP-001"]
        }
      ],
      "verification": "bun run test tests/skip.test.ts",
      "manual_verification": "N/A for fixture"
    }
  ],
  "success_criteria": ["BC-SKIP-001 satisfied"]
}
EOF

cat > "$SESSION_DIR/session.json" <<EOF
{
  "schema_version": 1,
  "session_id": "$SESSION_ID",
  "slug": "e2e-skip-review",
  "status": "active",
  "started_at": "2026-04-23T12:00:00Z",
  "last_checkpoint_at": null,
  "active_skill": null,
  "baseline_hash": null
}
EOF

printf '{"schema_version":1,"session_id":"%s"}' "$SESSION_ID" > "$ACTIVE.tmp"
mv "$ACTIVE.tmp" "$ACTIVE"

# ---- Test 1: spec.json validates ------------------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SESSION_DIR/spec.json" >/dev/null 2>&1; then
  note_pass "plan-creation output: spec.json validates"
else
  note_fail "plan-creation output: spec.json did not validate"
fi

# ---- Test 2: origin.created_by == plan-creation (no consolidation flip) ---
origin=$(jq -r '.origin.created_by' "$SESSION_DIR/spec.json")
if [ "$origin" = "plan-creation" ]; then
  note_pass "skip-review: origin.created_by stays 'plan-creation' (no consolidation)"
else
  note_fail "skip-review: origin.created_by is '$origin', expected 'plan-creation'"
fi

# ---- Test 3: no findings.json in session (review was skipped) -------------
if [ ! -f "$SESSION_DIR/findings.json" ]; then
  note_pass "skip-review: no findings.json in session dir (review skipped)"
else
  note_fail "skip-review: findings.json is present but review was supposed to be skipped"
fi

# ---- Test 4: no spec.json.pre-consolidation sidecar -----------------------
if [ ! -f "$SESSION_DIR/spec.json.pre-consolidation" ]; then
  note_pass "skip-review: no spec.json.pre-consolidation sidecar (consolidation skipped)"
else
  note_fail "skip-review: spec.json.pre-consolidation is present but consolidation was skipped"
fi

# ---- Test 5: origin.findings_path is null ---------------------------------
findings_path=$(jq -r '.origin.findings_path' "$SESSION_DIR/spec.json")
if [ "$findings_path" = "null" ]; then
  note_pass "skip-review: origin.findings_path is null (no findings ever integrated)"
else
  note_fail "skip-review: findings_path = '$findings_path', expected null"
fi

# ---- Test 6: routing heuristic chooses plan-review for empty-arg review ---
out=$(route_review "" "$SESSION_DIR")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "plan-review" ]; then
  note_pass "skip-review: pre-baseline /fly:review still routes to plan-review"
else
  note_fail "skip-review: expected plan-review (exit 0), got '$out' (exit $rc)"
fi

# ---- Step 2: work-implementation boot writes baseline.json ---------------
jq '. + { baseline_frozen_at: "2026-04-23T13:00:00Z" }' "$SESSION_DIR/spec.json" > "$SESSION_DIR/baseline.json.tmp"
mv "$SESSION_DIR/baseline.json.tmp" "$SESSION_DIR/baseline.json"

BASELINE_HASH=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
jq --arg hash "$BASELINE_HASH" '.baseline_hash = $hash' "$SESSION_DIR/session.json" > "$SESSION_DIR/session.json.tmp"
mv "$SESSION_DIR/session.json.tmp" "$SESSION_DIR/session.json"

# ---- Test 7: baseline.json validates --------------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/baseline.schema.json" -r "$SCHEMAS/task-list.schema.json" -d "$SESSION_DIR/baseline.json" >/dev/null 2>&1; then
  note_pass "skip-review: baseline.json validates (directly from plan-creation spec)"
else
  note_fail "skip-review: baseline.json did not validate"
fi

# ---- Test 8: baseline origin is still plan-creation -----------------------
baseline_origin=$(jq -r '.origin.created_by' "$SESSION_DIR/baseline.json")
if [ "$baseline_origin" = "plan-creation" ]; then
  note_pass "skip-review: baseline carries origin.created_by = 'plan-creation'"
else
  note_fail "skip-review: baseline origin is '$baseline_origin', expected 'plan-creation'"
fi

# ---- Test 9: hash format valid -------------------------------------------
if [[ "$BASELINE_HASH" =~ ^[a-f0-9]{64}$ ]]; then
  note_pass "skip-review: baseline_hash is 64-char lowercase hex"
else
  note_fail "skip-review: baseline_hash is not valid SHA-256 hex: $BASELINE_HASH"
fi

# ---- Test 10: after baseline, routing flips to work-review ---------------
out=$(route_review "" "$SESSION_DIR")
rc=$?
if [ "$rc" = "0" ] && [ "$out" = "work-review" ]; then
  note_pass "skip-review: post-baseline /fly:review routes to work-review"
else
  note_fail "skip-review: expected work-review (exit 0), got '$out' (exit $rc)"
fi

# ---- Step 3: simulate completed work state -------------------------------
cat > "$SESSION_DIR/state.json" <<EOF
{
  "schema_version": 1,
  "session_id": "$SESSION_ID",
  "status": "completed",
  "summary": "Skip-review state fixture: phase-1 completed. The single BC (BC-SKIP-001) is satisfied by task t1.1 verification. Work-review Phase 1.0 Check 2 emits no findings because the union of bc_satisfied across phases equals the baseline BC set.",
  "phases": [
    {
      "id": "phase-1",
      "status": "completed",
      "started_at": "2026-04-23T13:10:00Z",
      "completed_at": "2026-04-23T13:20:00Z",
      "outcomes": ["BC-SKIP-001 satisfied"],
      "strikes": [],
      "bc_satisfied": ["BC-SKIP-001"],
      "artifacts": {
        "files_created": ["src/skip.ts"],
        "files_modified": [],
        "commands_run": [
          {
            "command": "bun run test tests/skip.test.ts",
            "exit_code": 0,
            "stdout_tail": "1 pass",
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

# ---- Test 11: state.json validates ---------------------------------------
if "${AJV[@]}" validate -s "$SCHEMAS/state.schema.json" -d "$SESSION_DIR/state.json" >/dev/null 2>&1; then
  note_pass "skip-review: state.json validates"
else
  note_fail "skip-review: state.json did not validate"
fi

# ---- Test 12: BC coverage check passes (happy path) ----------------------
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
  note_pass "skip-review: work-review Check 2 emits 0 findings (all BCs covered)"
else
  note_fail "skip-review: expected 0 missing BCs, got $missing_count"
  echo "$missing" | jq '.'
fi

# ---- Test 13: no orphaned sidecars in the session dir --------------------
# Inventory the files we expect; anything else is an orphan.
expected_files="spec.json session.json baseline.json state.json"
actual_files=$(ls -1 "$SESSION_DIR" 2>/dev/null | sort)
expected_sorted=$(echo "$expected_files" | tr ' ' '\n' | sort)
if [ "$actual_files" = "$expected_sorted" ]; then
  note_pass "skip-review: session dir contains only expected files (no orphans)"
else
  note_fail "skip-review: session dir has unexpected files"
  echo "  expected: $expected_sorted"
  echo "  actual:   $actual_files"
fi

echo ""
echo "Summary: $pass passed, $fail failed."
[ "$fail" = "0" ] && exit 0 || exit 1
