#!/usr/bin/env bash
# Module: Multi-Session — switching, background sessions, view/restore cycle
source "$(dirname "$0")/lib/harness.sh"
init_harness "multi-session" "$@"
start_app

# ── T-05: Multi-Chat Switch ──
echo "T-05: Multi-Chat Switch"
send_text "say exactly: chat A alpha"
wait_and_capture "$WAIT_RESPONSE" "T-05a-chatA.log"
assert_contains "T-05a-chatA.log" "chat A alpha" "T-05a" || true

send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: chat B delta"
wait_and_capture "$WAIT_RESPONSE" "T-05b-chatB.log"
assert_contains "T-05b-chatB.log" "chat B delta" "T-05b" || true

# Switch to Chat A via modal
send_keys C-b; sleep 1
send_keys Down; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-05c-switch-back.log"
assert_contains "T-05c-switch-back.log" "chat A alpha" "T-05c-old-output" || true

# ── T-09: Send Message After Switch ──
echo "T-09: Send Message After Switch"
send_text "say exactly: switched back epsilon"
wait_and_capture "$WAIT_RESPONSE" "T-09a-msg-after-switch.log"
assert_contains "T-09a-msg-after-switch.log" "switched back epsilon" "T-09a" || true

# Switch to Chat B and verify it works
send_keys C-b; sleep 1
send_keys Enter; sleep "$WAIT_SHORT"
send_text "say exactly: chatB still works"
wait_and_capture "$WAIT_RESPONSE" "T-09b-chatB-msg.log"
assert_contains "T-09b-chatB-msg.log" "chatB still works" "T-09b" || true

# ── T-16: View Multiple Historical (priorState invariant) ──
echo "T-16: View Multiple Historical"
# Create completed sessions
send_keys C-w; sleep "$WAIT_MEDIUM"
send_text "say exactly: session X"
sleep "$WAIT_RESPONSE"
send_keys C-w; sleep "$WAIT_MEDIUM"
send_text "say exactly: session Y"
sleep "$WAIT_RESPONSE"
send_keys C-w; sleep "$WAIT_MEDIUM"
send_text "say exactly: session Z active"
wait_and_capture "$WAIT_RESPONSE" "T-16a-active.log"
assert_contains "T-16a-active.log" "session Z active" "T-16a" || true

# View first completed
send_keys C-b; sleep 1
for i in $(seq 1 15); do send_keys Down; sleep 0.1; done
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-16b-view1.log"

# View second completed
send_keys C-b; sleep 1
for i in $(seq 1 16); do send_keys Down; sleep 0.1; done
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-16c-view2.log"

# Dismiss — should restore to session Z
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-16d-restored.log"
assert_contains "T-16d-restored.log" "session Z active" "T-16d-restore" || true

# ── T-20: View Historical → Switch Live → Esc ──
echo "T-20: View Historical → Switch Live → Esc"
send_keys C-b; sleep 1
for i in $(seq 1 15); do send_keys Down; sleep 0.1; done
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-20a-viewing.log"

send_keys C-b; sleep 1
send_keys Enter; sleep "$WAIT_SHORT"
capture "T-20b-switched.log"
assert_not_contains "T-20b-switched.log" "Viewing session" "T-20b-live" || true

send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-20c-esc.log"
assert_not_contains "T-20c-esc.log" "Viewing session" "T-20c-no-restore" || true

# ── T-17: Modal While Agent Active ──
echo "T-17: Modal While Agent Active"
send_text "write a 500 word essay about space exploration"
sleep 2
send_keys C-b
wait_and_capture 1 "T-17a-modal-during-active.log"
assert_contains "T-17a-modal-during-active.log" "Sessions" "T-17a-modal" || true
send_keys Escape
wait_and_capture "$WAIT_RESPONSE" "T-17b-after-modal.log"
assert_contains "T-17b-after-modal.log" "space" "T-17b-continued" || true

stop_app
finish_harness
