#!/usr/bin/env bash
# Integration: /fly:work resumes a pre-seeded session.
#
# Pre-seeds the sandbox with a tiny but valid spec.json + session.json +
# active.json. Spawns claude with the local plugin, sends `/fly:work`,
# and waits for progress.json to appear in the session dir.
#
# Pass criteria:
#   - work-implementation skill writes progress.json (mode: plan).
#   - session.json gets active_skill stamped to work-implementation.
#
# This test invokes a real skill against the real model, so it makes
# Anthropic API calls. Plan on ~1-3 minutes.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIB="$REPO_ROOT/tests/integration/lib"
SCHEMAS="$REPO_ROOT/flywheel/schemas"
. "$LIB/assert.sh"
. "$LIB/sandbox.sh"
. "$LIB/tmux.sh"

pass=0
fail=0
SESSION="flywheel-int-fly-work"
SBOX=""

cleanup() {
  tmux_kill "$SESSION"
  cleanup_sandbox "$SBOX"
}
trap cleanup EXIT

SBOX=$(make_sandbox "fly-work")
SESSION_ID="smoketask-2026-04-24"
SDIR="$SBOX/.flywheel/plugin/sessions/$SESSION_ID"
mkdir -p "$SDIR"
mkdir -p "$SBOX/.flywheel/plugin"

# Seed: a trivial valid spec. No actual code changes will succeed since the
# files referenced do not exist in the sandbox; that's fine — we only need
# work-implementation to reach the point where it writes progress.json.
cat > "$SDIR/spec.json" <<'EOF'
{
  "schema_version": 1,
  "summary": "Pre-seeded fixture used by the /fly:work integration test. The plan describes a single trivial phase that prints 'hello' to stdout. The point of the fixture is to give work-implementation enough valid input to bootstrap its progress.json — the spec content itself is never executed end-to-end during the test.",
  "context": { "key_files": ["hello.sh"], "patterns": [], "gotchas": [] },
  "phases": [
    {
      "id": "phase-1",
      "goal": "Print hello.",
      "files": ["hello.sh"],
      "tasks": [
        {
          "id": "t1",
          "description": "Create hello.sh that echoes 'hello'.",
          "files": ["hello.sh"],
          "test_scenarios": ["bash hello.sh outputs 'hello'"]
        }
      ],
      "verification": "bash hello.sh | grep -q hello",
      "manual_verification": null
    }
  ],
  "success_criteria": ["hello.sh prints hello"]
}
EOF

cat > "$SDIR/session.json" <<EOF
{
  "schema_version": 1,
  "session_id": "$SESSION_ID",
  "slug": "smoketask",
  "status": "active",
  "started_at": "2026-04-24T12:00:00Z",
  "last_checkpoint_at": null,
  "active_skill": null
}
EOF

cat > "$SBOX/.flywheel/plugin/active.json" <<EOF
{ "schema_version": 1, "session_id": "$SESSION_ID" }
EOF

# Validate fixtures before driving the test, so we know any later failure
# is in the skill, not the seed.
AJV=(bunx ajv-cli --validate-formats=false --spec=draft2020)
if "${AJV[@]}" validate -s "$SCHEMAS/task-list.schema.json" -d "$SDIR/spec.json" >/dev/null 2>&1; then
  note_pass "seed spec.json validates"
else
  note_fail "seed spec.json did not validate (test bug, not skill bug)"
  finalize
fi
if "${AJV[@]}" validate -s "$SCHEMAS/session.schema.json" -d "$SDIR/session.json" >/dev/null 2>&1; then
  note_pass "seed session.json validates"
else
  note_fail "seed session.json did not validate (test bug, not skill bug)"
  finalize
fi

tmux_start "$SESSION" "$SBOX"

if ! wait_for_pane "$SESSION" "Quick safety check|\\? for shortcuts|Welcome back" 30; then
  note_fail "claude TUI did not start"
  finalize
fi
if tmux_capture "$SESSION" | grep -q "Quick safety check"; then
  tmux_send_line "$SESSION" ""
  wait_for_pane "$SESSION" "\\? for shortcuts|Welcome back" 15 || true
fi

# Drive: ask the skill to run against the active session.
tmux_send_line "$SESSION" "/fly:work"

# work-implementation Phase 1 writes progress.json atomically. Wait up to
# 4 minutes — the skill loads the spec, may dispatch a probe subagent, then
# checkpoints. Real-world this should hit the file within ~60-120s.
if wait_for_file "$SDIR/progress.json" 240; then
  note_pass "progress.json appeared in session dir"
else
  note_fail "progress.json did not appear within 240s"
  echo "----- pane tail -----"; tmux_capture "$SESSION"; echo "----- end -----"
  finalize
fi

# progress.json should validate against the schema.
if "${AJV[@]}" validate -s "$SCHEMAS/progress.schema.json" -d "$SDIR/progress.json" >/dev/null 2>&1; then
  note_pass "progress.json validates against progress.schema.json"
else
  note_fail "progress.json failed schema validation"
  echo "----- progress.json -----"; cat "$SDIR/progress.json"; echo "----- end -----"
fi

# mode must be "plan" since we seeded a spec.json without findings.
if [ -f "$SDIR/progress.json" ] && jq -e '.mode == "plan"' "$SDIR/progress.json" >/dev/null 2>&1; then
  note_pass "progress.json mode == plan"
else
  note_fail "progress.json mode is not 'plan'"
fi

finalize
