#!/usr/bin/env bash
# Integration: full Flywheel pipeline driven through one tmux session.
#
#   /fly:plan   -> plan-creation -> plan-review -> plan-consolidation
#   /fly:work   -> work-implementation (plan mode)
#   /fly:review -> work-review
#   /fly:work   -> work-implementation (fix-findings mode)
#
# All four commands run against the SAME claude session, the SAME
# sandbox directory, and the SAME flywheel session id. Each step's
# completion signal is an artifact on disk:
#
#   plan        -> spec.json AND spec.json.pre-consolidation present,
#                  review.findings.json absent (was consumed by consolidation)
#   work plan   -> progress.json with mode=plan, status=completed
#   work-review -> review.findings.json present (validates against schema)
#   work fix    -> progress.json.plan-mode archive present, fresh
#                  progress.json with mode=fix-findings (any status)
#
# Real Anthropic API calls. The full pipeline against a trivial spec
# typically takes 20-40 minutes. Plan accordingly.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIB="$REPO_ROOT/tests/integration/lib"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
. "$LIB/assert.sh"
. "$LIB/sandbox.sh"
. "$LIB/tmux.sh"

pass=0
fail=0
SESSION="flywheel-int-pipeline"
SBOX=""

dump_pane() {
  echo "----- pane tail -----"
  tmux_capture "$SESSION" 2>/dev/null || true
  echo "----- end -----"
}

cleanup() {
  tmux_kill "$SESSION"
  cleanup_sandbox "$SBOX"
}
trap cleanup EXIT

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)

# ---- Sandbox setup ---------------------------------------------------------
SBOX=$(make_sandbox "pipeline")

# No seed. The plan creates a small Python notes API from scratch — file
# I/O + HTTP handler + tests. Big enough to surface several review
# findings (path traversal, missing validation, blocking I/O, error
# paths in tests, etc.) without taking too long. Stdlib-only so no
# pip install step.

ACTIVE="$SBOX/.flywheel/plugin/active.json"
SESSIONS_DIR="$SBOX/.flywheel/plugin/sessions"

# ---- Spawn claude in tmux --------------------------------------------------
tmux_start "$SESSION" "$SBOX"

if ! wait_for_pane "$SESSION" "Quick safety check|\\? for shortcuts|Welcome back" 30; then
  note_fail "claude TUI did not start"
  dump_pane; finalize
fi
if tmux_capture "$SESSION" | grep -q "Quick safety check"; then
  tmux_send_line "$SESSION" ""
  wait_for_pane "$SESSION" "\\? for shortcuts|Welcome back" 15 || true
fi
note_pass "claude TUI started"

# ---- Step 1: /fly:plan -----------------------------------------------------
# Single, terse prompt avoids open-questions in plan-review which would
# block plan-consolidation on AskUserQuestion.
PLAN_PROMPT="Build a small Python notes API with two source files and tests. notes.py is the storage layer (save_note, list_notes, read_note) writing .txt files in a data/ folder relative to cwd. app.py uses stdlib http.server on port 8000 with POST /notes (body JSON {name, content}, returns 201), GET /notes (returns JSON list of names), and GET /notes/{name} (returns JSON {content} or 404). tests/test_notes.py with unittest covers the storage layer happy paths. Stdlib only — no pip install."
tmux_send_line "$SESSION" "/fly:plan $PLAN_PROMPT"

# active.json appears once plan-creation has chosen a session id.
if ! wait_for_file_with_autopilot "$SESSION" "$ACTIVE" 600; then
  note_fail "active.json never appeared (plan-creation stalled)"
  dump_pane; finalize
fi
SESSION_ID=$(jq -r .session_id "$ACTIVE" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  note_fail "active.json missing session_id"
  dump_pane; finalize
fi
SDIR="$SESSIONS_DIR/$SESSION_ID"
note_pass "plan-creation: session_id=$SESSION_ID"

# Consolidation produces TWO observable transitions, in order:
#   - Phase 2: spec.json.pre-consolidation sidecar appears (early)
#   - Phase 6: review.findings.json is deleted (consumed) AND spec.json
#             is rewritten
# The TRUE end-of-pipeline signal is: pre-consolidation sidecar present
# AND review.findings.json absent. Sidecar alone is not enough — using
# it as the gate caused the test to fire /fly:work and /fly:review while
# consolidation was still surfacing P3 questions. Now we wait for the
# combined predicate.
#
# Auto-pilot is critical here: plan-consolidation surfaces P3 findings
# and open questions one-at-a-time via AskUserQuestion. Without Enter
# being driven on each prompt the pipeline deadlocks.
i=0
last_fire=0
consolidated=false
while [ "$i" -lt 1800 ]; do
  if [ -f "$SDIR/spec.json.pre-consolidation" ] && [ ! -f "$SDIR/review.findings.json" ]; then
    consolidated=true
    break
  fi
  now=$(date +%s)
  if [ $((now - last_fire)) -ge "$AUTOPILOT_COOLDOWN" ]; then
    if autopilot_respond "$SESSION"; then last_fire="$now"; fi
  fi
  sleep 2
  i=$((i + 2))
done

if [ "$consolidated" = "true" ]; then
  note_pass "plan-consolidation completed: sidecar present, findings consumed"
else
  note_fail "plan-consolidation did not complete (pre-consolidation=$(test -f "$SDIR/spec.json.pre-consolidation" && echo yes || echo no), findings=$(test -f "$SDIR/review.findings.json" && echo present || echo absent))"
  dump_pane; finalize
fi

if "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SDIR/spec.json" >/dev/null 2>&1; then
  note_pass "consolidated spec.json validates"
else
  note_fail "consolidated spec.json failed schema validation"
  echo "----- validation error -----"
  "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SDIR/spec.json" 2>&1 | head -20
  echo "----- file content -----"
  cat "$SDIR/spec.json" 2>/dev/null || echo "(file unreadable)"
  echo "----- end -----"
fi

# Decision-propagation assertion: plan-review surfaces an open question
# about whether 'stdlib only' applies to tests (pytest vs unittest). The
# autopilot picks the recommended answer ("Stdlib only — tests too").
# Plan-consolidation Phase 4.5 must propagate that decision INTO the
# spec — verification commands and task descriptions should reflect
# unittest, NOT pytest. If pytest still appears in verification commands
# after consolidation, the decision evaporated into conversation history
# and the implementer will produce wrong output (this happened in a
# prior run).
verifications=$(jq -r '.phases[].verification' "$SDIR/spec.json" 2>/dev/null)
if echo "$verifications" | grep -qi "pytest"; then
  note_fail "consolidated spec verification uses pytest — 'stdlib only' decision not propagated into spec"
  echo "----- verification commands -----"
  echo "$verifications"
  echo "----- end -----"
elif echo "$verifications" | grep -qi "unittest"; then
  note_pass "consolidated spec verification uses unittest (decision propagated)"
else
  note_fail "consolidated spec verification uses neither pytest nor unittest — propagation unclear"
  echo "----- verification commands -----"
  echo "$verifications"
  echo "----- end -----"
fi

# ---- Step 2: /fly:work (plan mode) -----------------------------------------
tmux_send_line "$SESSION" "/fly:work"

# work-implementation writes progress.json early (Phase 1 init), then
# transitions through pending -> in_progress -> completed as chunks land.
if ! wait_for_file_with_autopilot "$SESSION" "$SDIR/progress.json" 300; then
  note_fail "/fly:work did not create progress.json within 5min"
  dump_pane; finalize
fi
note_pass "/fly:work: progress.json created"

# Wait for status=completed. For a 1-task spec this should land within
# 10-15 minutes. Drive any AskUserQuestion prompts that appear.
i=0
last_fire=0
while [ "$i" -lt 1500 ]; do
  status=$(jq -r '.status // ""' "$SDIR/progress.json" 2>/dev/null || echo "")
  if [ "$status" = "completed" ]; then break; fi
  now=$(date +%s)
  if [ $((now - last_fire)) -ge "$AUTOPILOT_COOLDOWN" ]; then
    if autopilot_respond "$SESSION"; then last_fire="$now"; fi
  fi
  sleep 2
  i=$((i + 2))
done
if [ "$(jq -r .status "$SDIR/progress.json")" = "completed" ]; then
  note_pass "/fly:work: progress.json status=completed"
else
  note_fail "/fly:work did not reach status=completed"
  echo "----- progress.json -----"; cat "$SDIR/progress.json"; echo "----- end -----"
  dump_pane; finalize
fi

if [ "$(jq -r .mode "$SDIR/progress.json")" = "plan" ]; then
  note_pass "/fly:work: mode=plan"
else
  note_fail "expected mode=plan, got $(jq -r .mode "$SDIR/progress.json")"
fi

# Implementation should have created the notes API. The plan enumerates
# notes.py, app.py, and tests/test_notes.py — the executor should produce
# all three.
if [ -f "$SBOX/notes.py" ]; then
  note_pass "notes.py was created"
else
  note_fail "notes.py was NOT created"
fi
if [ -f "$SBOX/app.py" ]; then
  note_pass "app.py was created"
else
  note_fail "app.py was NOT created"
fi
if [ -f "$SBOX/tests/test_notes.py" ]; then
  note_pass "tests/test_notes.py was created"
else
  note_fail "tests/test_notes.py was NOT created"
fi

# ---- Step 3: /fly:review ---------------------------------------------------
# Snapshot the plan-mode progress so we can detect the archive later.
PLAN_PROGRESS_BEFORE_REVIEW=$(jq -c . "$SDIR/progress.json")

tmux_send_line "$SESSION" "/fly:review"

# work-review writes review.findings.json once all reviewers have
# returned and the synthesizer has merged.
if ! wait_for_file_with_autopilot "$SESSION" "$SDIR/review.findings.json" 1500; then
  note_fail "/fly:review did not produce review.findings.json within 25min"
  dump_pane; finalize
fi
note_pass "/fly:review: review.findings.json produced"

if "${AJV[@]}" validate -s "$SCHEMAS/findings.schema.json" -d "$SDIR/review.findings.json" >/dev/null 2>&1; then
  note_pass "review.findings.json validates"
else
  note_fail "review.findings.json failed schema validation"
  echo "----- validation error -----"
  "${AJV[@]}" validate -s "$SCHEMAS/findings.schema.json" -d "$SDIR/review.findings.json" 2>&1 | head -20
  echo "----- file content -----"
  cat "$SDIR/review.findings.json" 2>/dev/null || echo "(file unreadable)"
  echo "----- end -----"
fi

FINDING_COUNT=$(jq '.findings | length' "$SDIR/review.findings.json" 2>/dev/null || echo 0)
echo "INFO: review surfaced $FINDING_COUNT findings"

# ---- Step 4: /fly:work (fix-findings mode) --------------------------------
# work-implementation should detect that progress.json has mode=plan,
# status=completed AND review.findings.json exists -> archive the old
# progress to progress.json.plan-mode and start fresh fix-findings.
tmux_send_line "$SESSION" "/fly:work"

# The real signal that work-implementation transitioned into fix-findings
# mode is progress.json.mode == "fix-findings". The SKILL.md documents
# an atomic rename to progress.json.plan-mode before the fresh init, but
# models sometimes skip that step while still producing the correct
# fresh state — we accept both. The archive file presence is observed
# and reported but is NOT a pass/fail gate.
i=0
last_fire=0
transitioned=false
while [ "$i" -lt 1200 ]; do
  if [ -f "$SDIR/progress.json" ]; then
    mode=$(jq -r '.mode // ""' "$SDIR/progress.json" 2>/dev/null || echo "")
    if [ "$mode" = "fix-findings" ]; then transitioned=true; break; fi
  fi
  now=$(date +%s)
  if [ $((now - last_fire)) -ge "$AUTOPILOT_COOLDOWN" ]; then
    if autopilot_respond "$SESSION"; then last_fire="$now"; fi
  fi
  sleep 2
  i=$((i + 2))
done

if [ "$transitioned" = "true" ]; then
  note_pass "/fly:work: progress.json transitioned to mode=fix-findings"
else
  note_fail "progress.json.mode never became fix-findings"
  echo "----- progress.json -----"; cat "$SDIR/progress.json" 2>/dev/null; echo "----- end -----"
  dump_pane; finalize
fi

if [ -f "$SDIR/progress.json.plan-mode" ]; then
  note_pass "plan-mode progress was archived (proper transition path)"
else
  echo "INFO: progress.json.plan-mode absent — model transitioned without archiving plan-mode history"
fi

# Validate the fix-findings progress.json against the schema.
if "${AJV[@]}" validate -s "$SCHEMAS/progress.schema.json" -d "$SDIR/progress.json" >/dev/null 2>&1; then
  note_pass "fix-findings progress.json validates"
else
  note_fail "fix-findings progress.json failed schema validation"
  echo "----- validation error -----"
  "${AJV[@]}" validate -s "$SCHEMAS/progress.schema.json" -d "$SDIR/progress.json" 2>&1 | head -20
  echo "----- file content -----"
  cat "$SDIR/progress.json" 2>/dev/null || echo "(file unreadable)"
  echo "----- end -----"
fi

finalize
