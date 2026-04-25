#!/usr/bin/env bash
# Integration: /fly:plan creates a session with a valid spec.json.
#
# Spawns claude in tmux against an empty sandbox (no pre-existing session),
# sends `/fly:plan <trivial feature>`, and waits for plan-creation to write
# spec.json + session.json + active.json into a fresh session dir.
#
# This is the most expensive case — plan-creation does codebase research
# and may dispatch locator/analyzer subagents, then plan-review fires
# every reviewer agent in parallel, then plan-consolidation refines.
# We wait only for the plan-creation step (spec.json + active.json) to
# avoid paying for the full pipeline; if plan-review/consolidation also
# complete inside the timeout, we cross-check those outputs too.
#
# Real Anthropic API calls. Plan on 3-10 minutes per run.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIB="$REPO_ROOT/tests/integration/lib"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
. "$LIB/assert.sh"
. "$LIB/sandbox.sh"
. "$LIB/tmux.sh"

pass=0
fail=0
SESSION="flywheel-int-fly-plan"
SBOX=""

cleanup() {
  tmux_kill "$SESSION"
  cleanup_sandbox "$SBOX"
}
trap cleanup EXIT

SBOX=$(make_sandbox "fly-plan")

# Seed a target file so the planner has something concrete to plan against.
# Without a real codebase the model tends to refuse or stall.
cat > "$SBOX/hello.sh" <<'EOF'
#!/usr/bin/env bash
echo "hi"
EOF
chmod +x "$SBOX/hello.sh"
(cd "$SBOX" && git add hello.sh && git commit -q -m "seed hello.sh")

tmux_start "$SESSION" "$SBOX"

if ! wait_for_pane "$SESSION" "Quick safety check|\\? for shortcuts|Welcome back" 30; then
  note_fail "claude TUI did not start"
  finalize
fi
if tmux_capture "$SESSION" | grep -q "Quick safety check"; then
  tmux_send_line "$SESSION" ""
  wait_for_pane "$SESSION" "\\? for shortcuts|Welcome back" 15 || true
fi

# Drive: ask plan-creation to plan a trivial change to hello.sh.
# Avoid apostrophes in the prompt — tmux send-keys can mangle them and
# leave the input box stuck without ever submitting Enter.
tmux_send_line "$SESSION" "/fly:plan Update hello.sh to print hello world instead of hi"

ACTIVE="$SBOX/.flywheel/plugin/active.json"
SESSIONS_DIR="$SBOX/.flywheel/plugin/sessions"

# Wait up to 15 minutes for active.json to appear. plan-creation does
# real codebase research and drafting; the orchestrator may also chain
# plan-review/consolidation. We only need the spec to land.
if wait_for_file "$ACTIVE" 900; then
  note_pass "active.json created by plan-creation"
else
  note_fail "active.json never appeared (plan-creation never finished)"
  echo "----- pane tail -----"; tmux_capture "$SESSION"; echo "----- end -----"
  finalize
fi

SESSION_ID=$(jq -r .session_id "$ACTIVE" 2>/dev/null || echo "")
if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then
  note_fail "active.json has no session_id"
  finalize
else
  note_pass "active.json has session_id: $SESSION_ID"
fi

SDIR="$SESSIONS_DIR/$SESSION_ID"
if [ -d "$SDIR" ]; then
  note_pass "session dir exists at $SESSION_ID"
else
  note_fail "session dir missing at $SDIR"
  finalize
fi

# spec.json should validate against task-list.schema.json.
if [ -f "$SDIR/spec.json" ]; then
  note_pass "spec.json present"
else
  note_fail "spec.json missing in session dir"
  finalize
fi

AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)
if "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SDIR/spec.json" >/dev/null 2>&1; then
  note_pass "spec.json validates against task-list.schema.json"
else
  note_fail "spec.json failed schema validation"
  echo "----- spec.json -----"; cat "$SDIR/spec.json"; echo "----- end -----"
  echo "----- ajv error -----"
  "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SDIR/spec.json" 2>&1 || true
  echo "----- end -----"
fi

# plan_id should match the session-id naming pattern.
if jq -re '.plan_id' "$SDIR/spec.json" 2>/dev/null | grep -E -q "^[a-z0-9-]+-2[0-9]{3}-[0-9]{2}-[0-9]{2}(-[0-9]+)?$"; then
  note_pass "spec.plan_id has session-id shape"
else
  note_fail "spec.plan_id does not match expected pattern"
fi

# session.json should also exist and validate.
if [ -f "$SDIR/session.json" ] && \
   "${AJV[@]}" validate -s "$SCHEMAS/session.schema.json" -d "$SDIR/session.json" >/dev/null 2>&1; then
  note_pass "session.json present and validates"
else
  note_fail "session.json missing or invalid"
fi

finalize
