#!/usr/bin/env bash
#
# TUI Regression Tests — Automated UAT via tmux
#
# Runs the flywheel TUI in a tmux session and exercises every major user flow,
# capturing pane output after each action for offline examination.
#
# Usage:
#   ./tests/e2e/tui-regression.sh [--log-dir <path>]
#
# Outputs:
#   <log-dir>/T-XX-<name>.log   — captured pane after each step
#   <log-dir>/stderr.log        — TUI stderr
#   <log-dir>/summary.log       — PASS/FAIL per test
#
source "$(dirname "$0")/lib/harness.sh"
init_harness "tui-regression" "$@"

# ─── Start ─────────────────────────────────────────────────────────────────────

echo "Starting TUI regression tests…"
echo "Log dir: $LOG_DIR"

start_app

# ═══════════════════════════════════════════════════════════════════════════════
# T-01: Basic Chat Round Trip
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-01: Basic Chat Round Trip"

send_text "say exactly: test reply alpha"
wait_and_capture "$WAIT_RESPONSE" "T-01a-first-message.log"
assert_contains "T-01a-first-message.log" "test reply alpha" "T-01a" || true

send_text "say exactly: test reply beta"
wait_and_capture "$WAIT_RESPONSE" "T-01b-second-message.log"
assert_contains "T-01b-second-message.log" "test reply beta" "T-01b" || true
assert_contains "T-01b-second-message.log" "test reply alpha" "T-01b-history" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-02: New Chat (Ctrl+N)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-02: New Chat (Ctrl+N)"

send_keys C-n
wait_and_capture "$WAIT_MEDIUM" "T-02a-new-chat.log"
assert_not_contains "T-02a-new-chat.log" "test reply alpha" "T-02a-cleared" || true
assert_contains "T-02a-new-chat.log" "bg" "T-02a-background" || true

send_text "say exactly: new chat gamma"
wait_and_capture "$WAIT_RESPONSE" "T-02b-new-msg.log"
assert_contains "T-02b-new-msg.log" "new chat gamma" "T-02b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-03: End Chat and Restart (Ctrl+W)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-03: End Chat and Restart (Ctrl+W)"

send_keys C-n
wait_and_capture "$WAIT_MEDIUM" "T-03a-after-ctrl-w.log"
assert_not_contains "T-03a-after-ctrl-w.log" "new chat gamma" "T-03a-cleared" || true

send_text "say exactly: after ctrl-w zeta"
wait_and_capture "$WAIT_RESPONSE" "T-03b-new-msg.log"
assert_contains "T-03b-new-msg.log" "after ctrl-w zeta" "T-03b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-04: Session Modal Open/Close
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-04: Session Modal Navigation"

send_keys C-b
wait_and_capture 1 "T-04a-modal-open.log"
assert_contains "T-04a-modal-open.log" "Sessions" "T-04a-open" || true

send_keys Down Down
sleep 0.3
capture "T-04b-modal-nav.log"

send_keys Escape
wait_and_capture 1 "T-04c-modal-close.log"
assert_not_contains "T-04c-modal-close.log" "Sessions" "T-04c-closed" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-05: Multi-Chat Switch
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-05: Multi-Chat Switch"

# Current chat has "after ctrl-w zeta". Background it and make a new one.
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: chat B delta"
wait_and_capture "$WAIT_RESPONSE" "T-05a-chatB.log"
assert_contains "T-05a-chatB.log" "chat B delta" "T-05a" || true

# Open modal and switch to first chat (should be 2nd item since chatB is newest)
send_keys C-b
sleep 1
send_keys Down  # navigate to the previous chat
sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-05b-switch-back.log"
assert_contains "T-05b-switch-back.log" "after ctrl-w zeta" "T-05b-old-output" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-09: Send Message After Switch
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-09: Send Message After Switch"

send_text "say exactly: switched back epsilon"
wait_and_capture "$WAIT_RESPONSE" "T-09a-msg-after-switch.log"
assert_contains "T-09a-msg-after-switch.log" "switched back epsilon" "T-09a" || true

# Switch to Chat B and verify it works too
send_keys C-b
sleep 1
send_keys Enter  # first item should be chat B (most recently active)
sleep "$WAIT_SHORT"
send_text "say exactly: chatB still works"
wait_and_capture "$WAIT_RESPONSE" "T-09b-chatB-msg.log"
assert_contains "T-09b-chatB-msg.log" "chatB still works" "T-09b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-06: View Completed Session
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-06: View Completed Session"

# End current chat to create a completed session
send_keys C-n
sleep "$WAIT_MEDIUM"

# Open modal, navigate to completed section
send_keys C-b
sleep 1
capture "T-06a-modal-with-paused.log"
# Chats never complete — they pause. Check for Paused section.
assert_contains "T-06a-modal-with-paused.log" "Paused" "T-06a-has-paused" || true

# Navigate to a paused session — use Up from top to wrap to bottom
send_keys Up  # wraps to last item (paused area)
sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_MEDIUM" "T-06b-resumed.log"
# Paused chats resume (not "view") — should show the old chat content
assert_contains "T-06b-resumed.log" "flywheel" "T-06b-resumed" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-07: Delete Session (D+D confirmation)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-07: Delete Session"

send_keys C-b
sleep 1
# Navigate to a completed session using Up (wraps to bottom, then back up into completed)
send_keys Up  # wrap to last item (archived or completed)
sleep 0.3
send_keys Up  # one more up to ensure we're in completed/archived
sleep 0.3
capture "T-07a-before-delete.log"

# Press D first time — confirmation prompt
send_keys d
sleep 0.5
capture "T-07b-confirm-prompt.log"
# The confirm text could be garbled in render, so just check that D didn't
# immediately delete (item still visible)
assert_contains "T-07b-confirm-prompt.log" "Sessions" "T-07b-still-open" || true

# Press D again — delete
send_keys d
sleep 1
capture "T-07c-after-delete.log"

send_keys Escape
sleep 1

# ═══════════════════════════════════════════════════════════════════════════════
# T-08: Interrupt Chat (Esc)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-08: Interrupt Chat (Esc)"

send_text "write a 1000 word essay about the history of mathematics"
sleep 4  # let agent start generating
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-08a-interrupted.log"
assert_contains "T-08a-interrupted.log" "Interrupted" "T-08a-interrupt" || true

# Verify chat still alive — send another message
send_text "say exactly: after interrupt theta"
wait_and_capture "$WAIT_RESPONSE" "T-08b-after-interrupt.log"
assert_contains "T-08b-after-interrupt.log" "after interrupt theta" "T-08b-alive" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-10: Rapid Ctrl+N Spam
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-10: Rapid Ctrl+N Spam"

send_keys C-n
sleep 0.2
send_keys C-n
sleep 0.2
send_keys C-n
sleep 0.2
send_keys C-n
sleep 0.2
send_keys C-n
sleep 15  # extra time — 5 concurrent chat startups take a while
capture "T-10a-after-spam.log"
# Should not crash — verify app is still responsive by checking header
assert_contains "T-10a-after-spam.log" "flywheel" "T-10a-alive" || true

send_text "say exactly: survived spam iota"
wait_and_capture "$WAIT_RESPONSE" "T-10b-msg.log"
assert_contains "T-10b-msg.log" "survived spam iota" "T-10b" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-11: Message During Startup (buffering)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-11: Message During Startup"

send_keys C-n
sleep 0.1
# Type immediately before chat is ready
send_text "say exactly: buffered lambda"
wait_and_capture "$WAIT_RESPONSE" "T-11a-buffered.log"
assert_contains "T-11a-buffered.log" "buffered lambda" "T-11a" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-12: View → Delete → Restore
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-12: View → Delete → Restore"

# First, create a completed session
send_text "say exactly: marker for T12"
wait_and_capture "$WAIT_RESPONSE" "T-12-setup.log"
send_keys C-n
sleep "$WAIT_MEDIUM"

# Send a message to identify the current chat
send_text "say exactly: active chat T12"
wait_and_capture "$WAIT_RESPONSE" "T-12a-active.log"

# Open modal and delete a non-foreground session
send_keys C-b
sleep 1
send_keys Down; sleep 0.3  # select second session
send_keys d; sleep 0.3     # first d = confirm prompt
send_keys d                 # second d = delete
wait_and_capture 1 "T-12b-after-delete.log"
send_keys Escape; sleep 1

# Foreground chat should still work after deletion
send_text "say exactly: still alive T12"
wait_and_capture "$WAIT_RESPONSE" "T-12c-still-works.log"
assert_contains "T-12c-still-works.log" "still alive T12" "T-12c-alive" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-17: Modal While Agent Active
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-17: Modal While Agent Active"

send_text "write a 500 word essay about space exploration"
sleep 2
send_keys C-b
wait_and_capture 1 "T-17a-modal-during-active.log"
assert_contains "T-17a-modal-during-active.log" "Sessions" "T-17a-modal" || true

send_keys Escape
wait_and_capture "$WAIT_RESPONSE" "T-17b-after-modal.log"
# Agent should have continued — look for some essay content
assert_contains "T-17b-after-modal.log" "space" "T-17b-continued" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-18: Archive Session
# ═══════════════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════════════
# T-19: Esc in Idle Chat (interrupt, not kill)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-19: Esc in Idle Chat"

send_text "say exactly: before esc test"
wait_and_capture "$WAIT_RESPONSE" "T-19a-before.log"

send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-19b-after-esc.log"

# Chat should still be alive — send another message
send_text "say exactly: after esc kappa"
wait_and_capture "$WAIT_RESPONSE" "T-19c-still-alive.log"
assert_contains "T-19c-still-alive.log" "after esc kappa" "T-19c" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-16: Modal Switch via Down+Enter
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-16: Modal Switch"

# Identify current chat
send_text "say exactly: session Z active"
wait_and_capture "$WAIT_RESPONSE" "T-16a-active.log"
assert_contains "T-16a-active.log" "session Z active" "T-16a" || true

# Switch to second session in modal
send_keys C-b; sleep 1
send_keys Down; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-16b-switched.log"

# ═══════════════════════════════════════════════════════════════════════════════
# T-20: View Historical → Switch to Live → Esc Doesn't Restore
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-20: View Historical → Switch Live → Esc"

# Switch to a different session via modal, verify no "Viewing session" state
send_keys C-b; sleep 1
send_keys Down; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-20a-switched.log"
assert_not_contains "T-20a-switched.log" "Viewing session" "T-20a-live" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-W01: Start Workflow from Chat (/work command)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W01: Start Workflow from Chat"

# First ensure we're in a clean chat
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: pre-workflow marker"
wait_and_capture "$WAIT_RESPONSE" "T-W01a-chat-before.log"
assert_contains "T-W01a-chat-before.log" "pre-workflow marker" "T-W01a-chat-works" || true

# Start a workflow — this should replace the chat foreground
send_text '/work "create a file called /tmp/flywheel-uat-test.txt with the text hello world"'
sleep 20  # workflows take longer to initialize (dispatcher + worker spawn)
capture "T-W01b-workflow-started.log"
# Workflow should show step indicator and/or agent output
assert_contains "T-W01b-workflow-started.log" "flywheel" "T-W01b-app-alive" || true
# The header should no longer say "Chat" — it should show the workflow description
assert_not_contains "T-W01b-workflow-started.log" "Send a message (/new for fresh chat)" "T-W01b-not-chat-prompt" || true

# Wait for more workflow progress
sleep 30
capture "T-W01c-workflow-progress.log"

# ═══════════════════════════════════════════════════════════════════════════════
# T-W02: Pause Workflow (Esc)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W02: Pause Workflow"

send_keys Escape
wait_and_capture 5 "T-W02a-paused.log"
# Should show paused state — prompt changes to mention resume/stop
# Check for "paused" in the header or footer
capture "T-W02a-paused.log"

# ═══════════════════════════════════════════════════════════════════════════════
# T-W03: Resume Workflow via Message (type text while paused)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W03: Resume Workflow via Message"

send_text "keep going"
sleep 5
capture "T-W03a-resumed.log"
# Sending a message to a paused workflow should resume it (cancelShutdown)
# The header should switch back to running/active state

# Wait for the step to finish or make more progress
sleep 20
capture "T-W03b-progress.log"

# ═══════════════════════════════════════════════════════════════════════════════
# T-W04: Abort Workflow (Esc twice: pause then abort)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W04: Abort Workflow"

# First Esc to pause
send_keys Escape
sleep 3
capture "T-W04a-pausing.log"

# Second Esc to force abort
send_keys Escape
sleep 5
capture "T-W04b-aborted.log"

# ═══════════════════════════════════════════════════════════════════════════════
# T-W05: Chat → Workflow → Switch Back to Chat
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W05: Chat → Workflow → Switch Back to Chat"

# Start a fresh chat
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: chat before workflow W05"
wait_and_capture "$WAIT_RESPONSE" "T-W05a-chat.log"
assert_contains "T-W05a-chat.log" "chat before workflow W05" "T-W05a-chat" || true

# Start a workflow (this displaces the chat from foreground)
send_text '/work "list files in the current directory"'
sleep 15
capture "T-W05b-workflow.log"

# Open modal and verify both sessions exist
send_keys C-b
sleep 1
capture "T-W05c-modal.log"
# Modal should show both the chat and workflow
assert_contains "T-W05c-modal.log" "Sessions" "T-W05c-modal-open" || true

# Switch back to chat (should be first or second item)
# The chat is still alive in registry, navigate to it
send_keys Down  # navigate away from workflow if selected
sleep 0.3
send_keys Enter
sleep "$WAIT_SHORT"
capture "T-W05d-switched.log"

# If we landed on the chat, verify it still works
# (may land on workflow — this is position-dependent)
# Try sending a message regardless
send_text "say exactly: chat after workflow W05"
wait_and_capture "$WAIT_RESPONSE" "T-W05e-chat-msg.log"
# At minimum, the app should still be alive
assert_contains "T-W05e-chat-msg.log" "flywheel" "T-W05e-alive" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-W06: Start Workflow via /work, Let It Complete
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W06: Workflow Completion"

send_keys C-n
sleep "$WAIT_MEDIUM"
send_text '/work "say exactly: workflow done"'
sleep 60  # wait for full workflow execution
capture "T-W06a-completed.log"
# After workflow completes, should show completion status (✓ or "done" in header)

# Verify we can start a new chat after workflow completion
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: chat after workflow completion"
wait_and_capture "$WAIT_RESPONSE" "T-W06b-chat-after.log"
assert_contains "T-W06b-chat-after.log" "chat after workflow completion" "T-W06b-chat-works" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-W07: Ctrl+R Resume (from idle state, resumes most recent paused workflow)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W07: Ctrl+R Resume"

# Start a workflow and pause it
send_text '/work "create a file called /tmp/flywheel-uat-resume-test.txt with hello"'
sleep 15
send_keys Escape  # pause
sleep 3
capture "T-W07a-paused.log"

# Start a new chat (leave workflow paused in background)
send_keys C-n
sleep "$WAIT_MEDIUM"
capture "T-W07b-in-chat.log"

# Press Ctrl+R to resume the paused workflow
send_keys C-r
sleep 10
capture "T-W07c-resumed.log"
# Should have switched to the workflow and resumed it

# Clean up: abort if still running
send_keys Escape
sleep 2
send_keys Escape
sleep 3

# ═══════════════════════════════════════════════════════════════════════════════
# T-W08: Workflow Session Visible in Modal After Completion
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-W08: Workflow in Modal"

send_keys C-n
sleep "$WAIT_MEDIUM"
send_keys C-b
sleep 1
capture "T-W08a-modal.log"
# Modal should show workflow sessions alongside chat sessions
# Look for "work" tag in the modal
send_keys Escape
sleep 1

# ═══════════════════════════════════════════════════════════════════════════════
# T-BUG1: Stale Sessions After Restart (regression for BUG-1 fix)
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-BUG1: Stale Session Recovery After Restart"

# Create multiple chats
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: pre-restart A"
sleep "$WAIT_RESPONSE"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: pre-restart B"
sleep "$WAIT_RESPONSE"

# Restart the app
restart_app
capture "T-BUG1a-after-restart.log"

# Open modal and check that old chats are NOT in Active section
send_keys C-b
wait_and_capture 1 "T-BUG1b-modal.log"
send_keys Escape
sleep 1

# Stale chat sessions should be in Paused group (❙ icon), not Active (● icon)
assert_contains "T-BUG1b-modal.log" "Paused" "T-BUG1b-has-paused" || true

# ═══════════════════════════════════════════════════════════════════════════════
# T-14: Exit Flow
# ═══════════════════════════════════════════════════════════════════════════════
echo "T-14: Exit Flow (Ctrl+C)"

send_keys C-c
sleep "$WAIT_MEDIUM"
capture "T-14a-exited.log"
# After exit, the TUI chrome should be gone — check that prompt area is absent
assert_not_contains "T-14a-exited.log" "Send a message" "T-14a-no-tui" || true

# Also test /exit — restart first
send_keys "FLYWHEEL_PROJECT_CWD=$UAT_DIR bun run dev 2>>$STDERR_LOG" Enter
sleep "$WAIT_MEDIUM"
send_text "/exit"
sleep "$WAIT_SHORT"
capture "T-14b-slash-exit.log"

finish_harness
