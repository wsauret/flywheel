#!/usr/bin/env bash
# Module: Workflow — /work command, pause, resume, abort, completion
source "$(dirname "$0")/lib/harness.sh"
init_harness "workflow" "$@"
start_app

# ── W-01: Start Workflow from Chat ──
echo "W-01: Start Workflow from Chat"
send_text "say exactly: pre-workflow marker"
wait_and_capture "$WAIT_RESPONSE" "W-01a-chat-before.log"
assert_contains "W-01a-chat-before.log" "pre-workflow marker" "W-01a-chat-works" || true

send_text '/work "create a file called /tmp/flywheel-uat-test.txt with the text hello world"'
sleep 20
capture "W-01b-workflow-started.log"
assert_contains "W-01b-workflow-started.log" "flywheel" "W-01b-app-alive" || true
assert_not_contains "W-01b-workflow-started.log" "Send a message (/new for fresh chat)" "W-01b-not-chat-prompt" || true

sleep 30
capture "W-01c-workflow-progress.log"

# ── W-02: Pause Workflow (Esc) ──
echo "W-02: Pause Workflow"
send_keys Escape
wait_and_capture 5 "W-02a-paused.log"

# ── W-03: Resume Workflow via Message ──
echo "W-03: Resume Workflow via Message"
send_text "keep going"
sleep 5
capture "W-03a-resumed.log"
sleep 20
capture "W-03b-progress.log"

# ── W-04: Abort Workflow (Esc twice) ──
echo "W-04: Abort Workflow"
send_keys Escape; sleep 3
capture "W-04a-pausing.log"
send_keys Escape; sleep 5
capture "W-04b-aborted.log"

# ── W-06: Workflow Completion ──
echo "W-06: Workflow Completion"
send_keys C-n; sleep "$WAIT_MEDIUM"
send_text '/work "say exactly: workflow done"'
sleep 60
capture "W-06a-completed.log"

send_keys C-n; sleep "$WAIT_MEDIUM"
send_text "say exactly: chat after workflow completion"
wait_and_capture "$WAIT_RESPONSE" "W-06b-chat-after.log"
assert_contains "W-06b-chat-after.log" "chat after workflow completion" "W-06b-chat-works" || true
# Verify workflow status line doesn't leak into new chat
assert_not_contains "W-06b-chat-after.log" "steps" "W-06b-no-status-leak" || true

# ── W-07: Ctrl+R Resume ──
echo "W-07: Ctrl+R Resume"
send_text '/work "create a file called /tmp/flywheel-uat-resume-test.txt with hello"'
sleep 15
send_keys Escape; sleep 3
capture "W-07a-paused.log"

send_keys C-n; sleep "$WAIT_MEDIUM"
capture "W-07b-in-chat.log"

send_keys C-r; sleep 10
capture "W-07c-resumed.log"

# Clean up
send_keys Escape; sleep 2
send_keys Escape; sleep 3

stop_app
finish_harness
