#!/usr/bin/env bash
# Module: Chat↔Workflow Interaction — switching between modes, state isolation
source "$(dirname "$0")/lib/e2e-framework.sh"
init_e2e "chat-workflow-interaction" "$@"
install_e2e_workflow
start_app

# ── CW-01: Chat → Workflow → Switch Back to Chat ──
echo "CW-01: Chat → Workflow → Switch Back"
send_text "say exactly: chat before workflow CW01"
wait_and_capture "$WAIT_RESPONSE" "CW-01a-chat.log"
assert_contains "CW-01a-chat.log" "chat before workflow CW01" "CW-01a-chat" || true

send_text 'Use the workflow tool to launch e2e-work.workflow.yaml by path with description "list files in the current directory".'
sleep 15
capture "CW-01b-workflow.log"

# Open modal — both should be visible
send_keys C-s; sleep 1
capture "CW-01c-modal.log"
assert_contains "CW-01c-modal.log" "Sessions" "CW-01c-modal-open" || true

# Switch back to chat
send_keys Down; sleep 0.3
send_keys Enter; sleep "$WAIT_SHORT"
capture "CW-01d-switched.log"

send_text "say exactly: chat after workflow CW01"
wait_and_capture "$WAIT_RESPONSE" "CW-01e-chat-msg.log"
assert_contains "CW-01e-chat-msg.log" "flywheel" "CW-01e-alive" || true

# ── CW-02: Workflow completes → new chat works cleanly ──
echo "CW-02: Workflow Complete → New Chat"
send_keys C-n; sleep "$WAIT_MEDIUM"
send_text 'Use the workflow tool to launch e2e-work.workflow.yaml by path with description "say exactly: done".'
sleep 60
capture "CW-02a-completed.log"

# New chat should have clean state (no workflow artifacts)
send_keys C-n; sleep "$WAIT_MEDIUM"
send_text "say exactly: clean chat after work"
wait_and_capture "$WAIT_RESPONSE" "CW-02b-clean-chat.log"
assert_contains "CW-02b-clean-chat.log" "clean chat after work" "CW-02b-msg" || true
assert_not_contains "CW-02b-clean-chat.log" "steps" "CW-02b-no-wf-leak" || true

# ── CW-03: Workflow in modal alongside chats ──
echo "CW-03: Workflow in Modal"
send_keys C-s; sleep 1
capture "CW-03a-modal.log"
assert_contains "CW-03a-modal.log" "Sessions" "CW-03a-modal" || true
send_keys Escape; sleep 1

# ── CHILD-01: Chat-launched workflow is a separate child session (ARCH-SESSIONS-009) ──
# When chat launches a workflow file, the SQLite event store must
# contain separate chat/workflow session facts, parent/child link facts, queue
# facts, and chat tree facts. These facts are the durable relationship and
# resume contract.
echo "CHILD-01: Parent/Child Session Metadata"
EVENT_DB="$UAT_DIR/.flywheel/flywheel.sqlite"
if [ -f "$EVENT_DB" ]; then
  # Snapshot relevant session facts for forensics.
  CHILD_LOG="$LOG_DIR/CHILD-01-sessions.txt"
  (cd "$PROJECT_DIR" && bun -e "
    import { Database } from 'bun:sqlite';
    const db = new Database(process.argv[1], { readonly: true });
    for (const row of db.query(\"select type, payload from event where type in ('session.created', 'session.child.linked', 'queue.created', 'chat.tree.created') order by position\").all()) {
      console.log(JSON.stringify({ type: row.type, payload: JSON.parse(row.payload) }));
    }
    db.close();
  " "$EVENT_DB") > "$CHILD_LOG"

  # At least one workflow session whose launchedFrom names a chat parent.
  # Match each in turn (JSON key order isn't guaranteed).
  if grep -q '"launchedFrom"' "$CHILD_LOG" 2>/dev/null && grep -q '"kind":"workflow"' "$CHILD_LOG" 2>/dev/null; then
    echo "PASS  CHILD-01a-workflow-has-launchedFrom — workflow session facts carry launchedFrom" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  CHILD-01a-workflow-has-launchedFrom — no workflow session.created fact with launchedFrom" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  # At least one child link fact joins the chat to the workflow.
  if grep -q '"type":"session.child.linked"' "$CHILD_LOG" 2>/dev/null; then
    echo "PASS  CHILD-01b-chat-has-children — chat session facts carry child link" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  CHILD-01b-chat-has-children — no session.child.linked fact" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  # The workflow session has its own queue facts (independent resume surface).
  if grep -q '"type":"queue.created"' "$CHILD_LOG" 2>/dev/null; then
    echo "PASS  CHILD-01c-workflow-has-queue — workflow session has queue facts" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  CHILD-01c-workflow-has-queue — no queue.created fact" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi

  # The chat session has its own chat tree facts (independent resume surface).
  if grep -q '"type":"chat.tree.created"' "$CHILD_LOG" 2>/dev/null; then
    echo "PASS  CHILD-01d-chat-has-tree — chat session has chat tree facts" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  CHILD-01d-chat-has-tree — no chat.tree.created fact" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "FAIL  CHILD-01-event-store-missing — $EVENT_DB not found" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

stop_app
finish_e2e
