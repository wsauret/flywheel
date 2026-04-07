#!/usr/bin/env bash
# Module: Chat↔Workflow Interaction — switching between modes, state isolation
source "$(dirname "$0")/lib/harness.sh"
init_harness "chat-workflow-interaction" "$@"
start_app

# ── CW-01: Chat → Workflow → Switch Back to Chat ──
echo "CW-01: Chat → Workflow → Switch Back"
send_text "say exactly: chat before workflow CW01"
wait_and_capture "$WAIT_RESPONSE" "CW-01a-chat.log"
assert_contains "CW-01a-chat.log" "chat before workflow CW01" "CW-01a-chat" || true

send_text '/work "list files in the current directory"'
sleep 15
capture "CW-01b-workflow.log"

# Open modal — both should be visible
send_keys C-b; sleep 1
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
send_text '/work "say exactly: done"'
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
send_keys C-b; sleep 1
capture "CW-03a-modal.log"
assert_contains "CW-03a-modal.log" "Sessions" "CW-03a-modal" || true
send_keys Escape; sleep 1

stop_app
finish_harness
