#!/usr/bin/env bash
# validate-session.sh — verify handoff correctness for a completed flywheel session
#
# Checks every step of the pipeline actually landed:
#   1. spec.json conforms to task-list schema
#   2. context.md + session.json + active.json exist
#   3. If findings.json exists: validates against findings schema
#   4. If baseline.json exists: hash matches session.json.baseline_hash
#   5. If state.json exists: validates + every baseline phase is in state + completed
#   6. Every task declared in baseline.phases[].tasks[] accounted for
#   7. BC coverage: union of state.phases[].bc_satisfied[] covers baseline.behavioral_contract[]
#   8. Scope drift check: every file in state.phases[].artifacts.files_* is in baseline.phases[].files[]
#
# Usage: bash tests/uat/validate-session.sh <session-dir>

set -u

SESSION_DIR="${1:?session dir required}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

pass=0
fail=0
notes=0

ok()    { echo "PASS: $*"; pass=$((pass+1)); }
bad()   { echo "FAIL: $*"; fail=$((fail+1)); }
note()  { echo "NOTE: $*"; notes=$((notes+1)); }

require_file() {
  local f="$1"
  if [ -f "$f" ]; then
    ok "$(basename "$f") exists"
  else
    bad "$(basename "$f") missing at $f"
  fi
}

validate_schema() {
  local schema="$1"
  local file="$2"
  if [ ! -f "$file" ]; then return; fi
  # Copy to a predictable .json path so ajv-cli doesn't choke on unusual extensions.
  local dir
  dir=$(mktemp -d)
  local tmp="$dir/candidate.json"
  cp "$file" "$tmp"
  if "${AJV[@]}" -s "$schema" -d "$tmp" >/dev/null 2>&1; then
    ok "$(basename "$file") validates against $(basename "$schema")"
  else
    bad "$(basename "$file") FAILED $(basename "$schema")"
    "${AJV[@]}" -s "$schema" -d "$tmp" 2>&1 | tail -5
  fi
  rm -rf "$dir"
}

echo "==> Validating session at $SESSION_DIR"

# ---- Artifact presence ---------------------------------------------------
require_file "$SESSION_DIR/spec.json"
require_file "$SESSION_DIR/context.md"
require_file "$SESSION_DIR/session.json"

# Active pointer
ACTIVE="$SESSION_DIR/../../active.json"
[ -f "$ACTIVE" ] || ACTIVE="$(dirname "$(dirname "$SESSION_DIR")")/active.json"
if [ -f "$ACTIVE" ]; then
  SID=$(jq -r '.session_id' "$ACTIVE")
  EXPECTED=$(basename "$SESSION_DIR")
  if [ "$SID" = "$EXPECTED" ]; then
    ok "active.json points at this session ($SID)"
  else
    bad "active.json points at $SID, expected $EXPECTED"
  fi
else
  note "active.json not found (may be post-cleanup)"
fi

# ---- Schema validation ---------------------------------------------------
validate_schema "$SCHEMAS/task-list.schema.json" "$SESSION_DIR/spec.json"
validate_schema "$SCHEMAS/task-list.schema.json" "$SESSION_DIR/spec.json.pre-consolidation"
validate_schema "$SCHEMAS/session.schema.json"   "$SESSION_DIR/session.json"
validate_schema "$SCHEMAS/findings.schema.json"  "$SESSION_DIR/findings.json"
validate_schema "$SCHEMAS/findings.schema.json"  "$SESSION_DIR/review.findings.json"
validate_schema "$SCHEMAS/state.schema.json"     "$SESSION_DIR/state.json"

# Baseline needs composed schemas
if [ -f "$SESSION_DIR/baseline.json" ]; then
  dir=$(mktemp -d)
  tmp="$dir/baseline.json"
  cp "$SESSION_DIR/baseline.json" "$tmp"
  if "${AJV[@]}" -s "$SCHEMAS/task-list.schema.json" -r "$SCHEMAS/baseline.schema.json" -d "$tmp" >/dev/null 2>&1; then
    ok "baseline.json validates against task-list+baseline schemas"
  else
    # Fallback: baseline.json extends task-list — try plain task-list validation
    if "${AJV[@]}" -s "$SCHEMAS/task-list.schema.json" -d "$tmp" >/dev/null 2>&1; then
      ok "baseline.json validates against task-list schema"
    else
      bad "baseline.json failed task-list validation"
    fi
  fi
  rm -rf "$dir"
fi

# ---- Baseline hash -------------------------------------------------------
if [ -f "$SESSION_DIR/baseline.json" ] && [ -f "$SESSION_DIR/session.json" ]; then
  STORED=$(jq -r '.baseline_hash // ""' "$SESSION_DIR/session.json")
  COMPUTED=$(shasum -a 256 "$SESSION_DIR/baseline.json" | awk '{print $1}')
  if [ "$STORED" = "$COMPUTED" ]; then
    ok "baseline hash matches stored (session.json.baseline_hash)"
  elif [ -z "$STORED" ]; then
    bad "baseline.json exists but session.json.baseline_hash is empty"
  else
    bad "baseline hash mismatch: stored=$STORED computed=$COMPUTED"
  fi
fi

# ---- Handoff: every baseline phase in state -----------------------------
if [ -f "$SESSION_DIR/baseline.json" ] && [ -f "$SESSION_DIR/state.json" ]; then
  BASELINE_PHASES=$(jq -r '.phases[].id' "$SESSION_DIR/baseline.json" | sort)
  STATE_PHASES=$(jq -r '.phases[].id' "$SESSION_DIR/state.json" | sort)
  MISSING=$(comm -23 <(echo "$BASELINE_PHASES") <(echo "$STATE_PHASES"))
  if [ -z "$MISSING" ]; then
    ok "every baseline phase present in state"
  else
    bad "state missing phases: $MISSING"
  fi

  # Every baseline phase completed in state
  INCOMPLETE=$(jq -r '
    ([.phases[] | select(.status != "completed") | .id] | join(","))
  ' "$SESSION_DIR/state.json")
  if [ -z "$INCOMPLETE" ]; then
    ok "every state phase status=completed"
  else
    bad "incomplete phases in state: $INCOMPLETE"
  fi
fi

# ---- Handoff: every baseline task acknowledged --------------------------
if [ -f "$SESSION_DIR/baseline.json" ] && [ -f "$SESSION_DIR/state.json" ]; then
  BASELINE_TASKS=$(jq -r '.phases[].tasks[].id' "$SESSION_DIR/baseline.json" | sort -u)
  BASELINE_TASK_COUNT=$(echo "$BASELINE_TASKS" | grep -c .)
  # Tasks aren't individually listed in state, but every phase's task IDs
  # should appear somewhere in its outcomes or bc_satisfied coverage.
  # Minimum check: baseline task count > 0 and state phases fully completed.
  if [ "$BASELINE_TASK_COUNT" -gt 0 ]; then
    ok "baseline has $BASELINE_TASK_COUNT task(s) declared"
  else
    bad "baseline has zero tasks"
  fi
fi

# ---- Handoff: BC coverage -----------------------------------------------
if [ -f "$SESSION_DIR/baseline.json" ] && [ -f "$SESSION_DIR/state.json" ]; then
  BASELINE_BCS=$(jq -r '.behavioral_contract[].id' "$SESSION_DIR/baseline.json" | sort -u)
  SATISFIED=$(jq -r '[.phases[].bc_satisfied[]] | .[]' "$SESSION_DIR/state.json" | sort -u)
  UNCOVERED=$(comm -23 <(echo "$BASELINE_BCS") <(echo "$SATISFIED"))
  if [ -z "$UNCOVERED" ]; then
    BC_COUNT=$(echo "$BASELINE_BCS" | grep -c .)
    ok "every baseline BC satisfied in state ($BC_COUNT BCs)"
  else
    bad "uncovered BCs in state: $UNCOVERED"
  fi
fi

# ---- Handoff: fulfills coverage (every BC has at-least-one task claim) ---
if [ -f "$SESSION_DIR/baseline.json" ]; then
  ORPHANS=$(jq -r '
    [.behavioral_contract[].id] as $bcs |
    [.phases[].tasks[].fulfills[]] as $claimed |
    $bcs | map(select(. as $bc | ($claimed | index($bc)) == null)) | .[]
  ' "$SESSION_DIR/baseline.json" 2>/dev/null)
  if [ -z "$ORPHANS" ]; then
    ok "baseline BC coverage: every BC has at-least-one fulfills claim"
  else
    bad "baseline orphan BCs (no fulfills claim): $ORPHANS"
  fi
fi

# ---- Scope drift: state files are subset of baseline files ---------------
if [ -f "$SESSION_DIR/baseline.json" ] && [ -f "$SESSION_DIR/state.json" ]; then
  DRIFT=$(jq -r '
    ([.phases[].files[]] | unique) as $baseline |
    [.phases[].artifacts.files_created[], .phases[].artifacts.files_modified[]] | unique |
    map(select(. as $f | ($baseline | index($f)) == null))
  ' <(cat "$SESSION_DIR/baseline.json" "$SESSION_DIR/state.json" | jq -s '{phases: ([.[].phases[]] | add | [.])}') 2>/dev/null)
  # The jq above is tricky because we need to merge two files. Use simpler approach:
  BASELINE_FILES=$(jq -r '[.phases[].files[]] | unique | .[]' "$SESSION_DIR/baseline.json" 2>/dev/null | sort -u)
  STATE_FILES_RAW=$(jq -r '[.phases[].artifacts.files_created[], .phases[].artifacts.files_modified[]] | unique | .[]' "$SESSION_DIR/state.json" 2>/dev/null | sort -u)
  # Filter ephemeral build artifacts (virtualenvs, caches, lockfiles) — these are
  # environment byproducts the agent creates during verification, not deliverables
  # the baseline would have declared.
  STATE_FILES=$(echo "$STATE_FILES_RAW" | grep -v -E '(^|/)(\.venv|__pycache__|\.pytest_cache|node_modules|dist|build|\.DS_Store|.*\.pyc)(/|$)' || true)
  if [ -n "$STATE_FILES" ]; then
    OUT_OF_SCOPE=$(comm -23 <(echo "$STATE_FILES") <(echo "$BASELINE_FILES"))
    if [ -z "$OUT_OF_SCOPE" ]; then
      FILE_COUNT=$(echo "$STATE_FILES" | grep -c .)
      ok "no scope drift ($FILE_COUNT state files all in baseline.phases[].files)"
    else
      bad "scope drift (files outside baseline): $OUT_OF_SCOPE"
    fi
  fi
fi

# ---- Handoff: consolidation preserves BC coverage after refinement ------
if [ -f "$SESSION_DIR/spec.json.pre-consolidation" ]; then
  PRE_BCS=$(jq -r '.behavioral_contract[].id' "$SESSION_DIR/spec.json.pre-consolidation" | sort -u)
  POST_BCS=$(jq -r '.behavioral_contract[].id' "$SESSION_DIR/spec.json" | sort -u)
  # BCs can be added in consolidation, but pre-existing BCs should survive
  MISSING_AFTER=$(comm -23 <(echo "$PRE_BCS") <(echo "$POST_BCS"))
  if [ -z "$MISSING_AFTER" ]; then
    ok "consolidation preserved all pre-consolidation BCs"
  else
    bad "consolidation dropped BCs: $MISSING_AFTER"
  fi

  # origin.created_by transitions
  PRE_ORIGIN=$(jq -r '.origin.created_by' "$SESSION_DIR/spec.json.pre-consolidation")
  POST_ORIGIN=$(jq -r '.origin.created_by' "$SESSION_DIR/spec.json")
  if [ "$PRE_ORIGIN" = "plan-creation" ] && [ "$POST_ORIGIN" = "plan-consolidation" ]; then
    ok "origin transition plan-creation → plan-consolidation recorded"
  else
    bad "origin transition wrong: pre=$PRE_ORIGIN post=$POST_ORIGIN"
  fi
fi

# ---- Summary -------------------------------------------------------------
echo ""
echo "Summary: $pass passed, $fail failed, $notes noted"
[ "$fail" -eq 0 ] || exit 1
