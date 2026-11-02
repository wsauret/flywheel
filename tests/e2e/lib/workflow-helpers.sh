#!/usr/bin/env bash
# Shared helpers for workflow E2E tests.
# Source this file; it defines functions but runs nothing.

pass=0
fail=0

# Parse workflow-prompt.md with YAML frontmatter.
# Sets: PROMPT, EXPECTED_FILES (array), TEST_COMMAND
load_workflow_prompt() {
  local prompt_file="$1"
  local body=""
  local in_frontmatter=false
  local past_frontmatter=false
  EXPECTED_FILES=()
  TEST_COMMAND=""

  while IFS= read -r line; do
    if [ "$past_frontmatter" = true ]; then
      body="${body:+$body
}$line"
    elif [ "$line" = "---" ] && [ "$in_frontmatter" = false ]; then
      in_frontmatter=true
    elif [ "$line" = "---" ] && [ "$in_frontmatter" = true ]; then
      in_frontmatter=false
      past_frontmatter=true
    elif [ "$in_frontmatter" = true ]; then
      case "$line" in
        "  - "*)
          EXPECTED_FILES+=("${line#  - }")
          ;;
        "test_command: "*)
          TEST_COMMAND="${line#test_command: }"
          ;;
      esac
    fi
  done < "$prompt_file"

  PROMPT="$body"
}

# Assert expected files exist in UAT_DIR.
check_expected_files() {
  for f in "${EXPECTED_FILES[@]}"; do
    if [ -f "$UAT_DIR/$f" ]; then
      note_pass "$f exists"
    else
      note_fail "$f not found"
    fi
  done

  local test_count
  test_count=$(find "$UAT_DIR" -name "test_*.py" -not -path "*/.flywheel/*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$test_count" -ge 1 ]; then
    note_pass "$test_count test file(s) found"
  else
    note_fail "no test files found"
  fi
}

# Run the test command from the prompt frontmatter.
run_test_command() {
  local label="${1:-}"
  if [ -z "$TEST_COMMAND" ]; then return; fi
  if (cd "$UAT_DIR" && eval "$TEST_COMMAND" 2>&1); then
    note_pass "Unit tests pass${label:+ $label}"
  else
    note_fail "Unit tests failed${label:+ $label}"
  fi
}

note_pass() { echo "PASS: $1"; pass=$((pass + 1)); }
note_fail() { echo "FAIL: $1"; fail=$((fail + 1)); }
note_info() { echo "INFO: $1"; }

finalize() {
  echo ""
  echo "Summary: $pass passed, $fail failed."
  [ "$fail" = "0" ] && exit 0 || exit 1
}

capture() { tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null || echo ""; }

dump_pane() {
  echo "----- pane tail -----"
  capture | tail -20
  echo "----- end -----"
}

shell_quote() {
  printf "%q" "$1"
}

append_flywheel_env() {
  local name="$1"
  if [ "${!name+x}" = "x" ]; then
    launch_cmd="$launch_cmd && export $name=$(shell_quote "${!name}")"
  fi
}

wait_for_file() {
  local path="$1" timeout="${2:-30}" i=0
  while [ "$i" -lt "$timeout" ]; do
    [ -e "$path" ] && return 0
    sleep 2; i=$((i + 2))
  done
  return 1
}

wait_for_queue_step() {
  local queue_path="$1" step_idx="$2" expected="$3" timeout="${4:-7200}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if [ -f "$queue_path" ]; then
      local status
      status=$(jq -r ".steps[$step_idx].status // \"\"" "$queue_path" 2>/dev/null || echo "")
      [ "$status" = "$expected" ] && return 0
    fi
    sleep 3; i=$((i + 3))
  done
  return 1
}

# Wait for the queue to reach a given total step count (for forEach expansion).
wait_for_step_count() {
  local queue_path="$1" min_count="$2" timeout="${3:-300}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if [ -f "$queue_path" ]; then
      local count
      count=$(jq '.steps | length' "$queue_path" 2>/dev/null || echo 0)
      [ "$count" -ge "$min_count" ] && return 0
    fi
    sleep 2; i=$((i + 2))
  done
  return 1
}

# Wait for ALL steps in queue to be completed.
wait_for_queue_completed() {
  local queue_path="$1" timeout="${2:-7200}" i=0
  while [ "$i" -lt "$timeout" ]; do
    if [ -f "$queue_path" ]; then
      local status
      status=$(jq -r '.status // ""' "$queue_path" 2>/dev/null || echo "")
      [ "$status" = "completed" ] && return 0
      [ "$status" = "failed" ] && return 1
    fi
    sleep 3; i=$((i + 3))
  done
  return 1
}

completed_step_count() {
  local queue_path="$1" definition_id="$2"
  jq --arg definition_id "$definition_id" \
    '[.steps[] | select(.definitionId == $definition_id and .status == "completed")] | length' \
    "$queue_path" 2>/dev/null || echo 0
}

# Create sandbox, copy config, start TUI, wait for ready.
# Sets: UAT_DIR, SESSIONS_DIR
setup_sandbox_and_tui() {
  local project_dir="$1"

  UAT_DIR=$(mktemp -d /tmp/flywheel-e2e-XXXXXX)
  (
    cd "$UAT_DIR"
    git init -q
    git config user.email "test@flywheel.local"
    git config user.name "Flywheel Test"
    printf ".flywheel/\n__pycache__/\n*.pyc\n" > .gitignore
    git add .gitignore
    git commit -q -m "init" >/dev/null 2>&1
  )

  mkdir -p "$UAT_DIR/.flywheel"
  [ -f "$project_dir/flywheel.toml" ] && cp "$project_dir/flywheel.toml" "$UAT_DIR/.flywheel/flywheel.toml"

  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  sleep 0.5
  local launch_cmd
  launch_cmd="cd $(shell_quote "$UAT_DIR") && export FLYWHEEL_PROJECT_ROOT=$(shell_quote "$UAT_DIR") && export HOME=$(shell_quote "$UAT_DIR")"
  launch_cmd="$launch_cmd && export FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS=$(shell_quote "${FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS:-1}")"
  append_flywheel_env FLYWHEEL_OPENAI_AUTH
  append_flywheel_env FLYWHEEL_OPENAI_EMAIL
  append_flywheel_env FLYWHEEL_CHAT_MODEL
  append_flywheel_env FLYWHEEL_CHAT_EFFORT
  append_flywheel_env FLYWHEEL_WORKER_MODEL
  append_flywheel_env FLYWHEEL_WORKER_EFFORT
  append_flywheel_env FLYWHEEL_QUEUE_MAX_STEPS
  append_flywheel_env FLYWHEEL_LOG_LEVEL
  launch_cmd="$launch_cmd && $(shell_quote "$project_dir/bin/flywheel")"
  tmux new-session -d -s "$TMUX_SESSION" -x 200 -y 50 \
    "$launch_cmd"
  sleep 8

  local i=0
  while [ "$i" -lt 20 ]; do
    vis=$(capture)
    if echo "$vis" | grep -q "Send a message"; then
      if ! echo "$vis" | grep -q "Thinking\|Esc to interrupt\|guide the agent"; then
        break
      fi
    fi
    sleep 1; i=$((i + 1))
  done
  if [ "$i" -ge 20 ]; then
    note_fail "TUI did not reach ready state"
    dump_pane; finalize
  fi
  note_pass "TUI started"

  SESSIONS_DIR="$UAT_DIR/.flywheel/sessions"
}

# Ask the chat to launch a workflow file and discover its SQLite-backed session.
# Sets: SESSION_ID, EVENT_DB
send_sqlite_workflow_command() {
  local workflow_path="$1" prompt="$2"

  EVENT_DB="$UAT_DIR/.flywheel/flywheel.sqlite"
  tmux send-keys -t "$TMUX_SESSION" -l "Use the workflow tool to launch the file at $workflow_path by path with this description: $prompt"
  sleep 0.5
  tmux send-keys -t "$TMUX_SESSION" Enter
  note_info "Requested workflow file: $workflow_path"

  local i=0
  SESSION_ID=""
  while [ "$i" -lt 120 ]; do
    if [ -f "$EVENT_DB" ]; then
      SESSION_ID=$(cd "$PROJECT_DIR" && bun -e '
        import { openEventSearch } from "./src/infra/event-store-search.ts";
        const store = openEventSearch(process.argv[1]);
        const event = store?.scan({ types: ["queue.created"], order: "desc" })[0];
        if (event) console.log(event.sessionId);
        store?.close();
      ' "$EVENT_DB")
      [ -n "$SESSION_ID" ] && break
    fi
    sleep 2; i=$((i + 2))
  done
  if [ -z "$SESSION_ID" ]; then
    note_fail "No workflow session created within 2min"
    dump_pane; finalize
  fi
  note_pass "Workflow session created: $SESSION_ID"
}

workflow_events_json() {
  (cd "$PROJECT_DIR" && bun -e '
    import { openEventSearch } from "./src/infra/event-store-search.ts";
    const [dbPath, sessionId, ...types] = process.argv.slice(1);
    const store = openEventSearch(dbPath);
    if (!store) process.exit(0);
    const events = store.scan({ sessionId, ...(types.length > 0 ? { types } : {}) });
    for (const event of events) console.log(JSON.stringify(event));
    store.close();
  ' "$EVENT_DB" "$SESSION_ID" "$@")
}

workflow_queue_json() {
  (cd "$PROJECT_DIR" && bun -e '
    import { openEventSearch } from "./src/infra/event-store-search.ts";
    import { loadQueueFromEvents } from "./src/workflows/queue/queue-projection.ts";
    const [dbPath, sessionId] = process.argv.slice(1);
    const store = openEventSearch(dbPath);
    if (!store) process.exit(0);
    const queue = loadQueueFromEvents(store.scan({ sessionId }));
    if (queue) console.log(JSON.stringify(queue));
    store.close();
  ' "$EVENT_DB" "$SESSION_ID")
}

wait_for_workflow_step() {
  local step_idx="$1" expected="$2" timeout="${3:-7200}" i=0
  while [ "$i" -lt "$timeout" ]; do
    local status
    status=$(workflow_queue_json | jq -er ".steps[$step_idx].status") || return 2
    [ "$status" = "$expected" ] && return 0
    sleep 3; i=$((i + 3))
  done
  return 1
}

workflow_handoff_json() {
  local definition_id="$1"
  workflow_events_json "handoff.written" | jq -sc --arg definition_id "$definition_id" \
    '[.[] | select(.payload.definitionId == $definition_id)] | last | .payload.content // empty'
}

wait_for_workflow_terminal() {
  local timeout="${1:-7200}" i=0
  while [ "$i" -lt "$timeout" ]; do
    local terminal
    terminal=$(workflow_events_json "workflow.completed" "workflow.failed" "workflow.aborted" "workflow.paused" | jq -sr 'last.type // ""')
    # An unattended E2E cannot resume itself, so paused is a non-success stop for this wait contract.
    case "$terminal" in
      workflow.completed) return 0 ;;
      workflow.failed|workflow.aborted|workflow.paused) return 1 ;;
    esac
    sleep 3; i=$((i + 3))
  done
  return 1
}

log_sqlite_workflow_state() {
  local queue
  queue=$(workflow_queue_json)
  note_info "Final workflow status: $(jq -r '.status // ""' <<< "$queue")"
  jq -r '.steps[] | "  \(.name): \(.status)"' <<< "$queue" | while read -r line; do
    note_info "$line"
  done
  note_info "Total handoff facts: $(workflow_events_json "handoff.written" | jq -s 'length')"
  note_info "Total Python files: $(find "$UAT_DIR" -name '*.py' -not -path '*/.git/*' -not -path '*/.flywheel/*' 2>/dev/null | wc -l | tr -d ' ')"
}

# Cleanup trap helper.
cleanup_tui() {
  local timestamp
  timestamp=$(date +%Y%m%d-%H%M%S)
  local dest="/tmp/flywheel-e2e-${TMUX_SESSION}-${timestamp}.pane.txt"
  tmux capture-pane -t "$TMUX_SESSION" -p -S - > "$dest" 2>/dev/null || true
  echo "Pane history saved: $dest"
  tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
  [ -n "$UAT_DIR" ] && [ -d "$UAT_DIR" ] && echo "Sandbox preserved: $UAT_DIR"
}

# Log final queue state.
log_final_state() {
  local queue_status
  queue_status=$(jq -r '.status // ""' "$QUEUE" 2>/dev/null || echo "")
  note_info "Final queue status: $queue_status"
  jq -r '.steps[] | "  \(.name): \(.status)"' "$QUEUE" 2>/dev/null | while read -r line; do
    note_info "$line"
  done

  if [ -f "$SDIR/session.log" ]; then
    local log_errors
    log_errors=$(grep -c "^ERROR" "$SDIR/session.log" 2>/dev/null || echo 0)
    log_errors=$(echo "$log_errors" | tr -d '[:space:]')
    if [ "$log_errors" -gt 0 ] 2>/dev/null; then
      note_info "WARN: $log_errors ERROR entries in session.log"
      grep "^ERROR" "$SDIR/session.log" 2>/dev/null | head -5 | while read -r line; do
        note_info "  $line"
      done
    else
      note_pass "Session log clean (0 errors)"
    fi
  fi

  local total_handoffs
  total_handoffs=$(ls "$HANDOFFS"/*.json 2>/dev/null | wc -l | tr -d ' ')
  note_info "Total handoff files: $total_handoffs"
  note_info "Total Python files: $(find "$UAT_DIR" -name '*.py' -not -path '*/.git/*' -not -path '*/.flywheel/*' 2>/dev/null | wc -l | tr -d ' ')"
}
