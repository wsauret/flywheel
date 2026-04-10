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

# ── T-16: Switch via Modal then Esc Restores ──
echo "T-16: Modal Switch + Esc Restore"
# Create a fresh chat as our "home" session
send_keys C-n; sleep "$WAIT_MEDIUM"
send_text "say exactly: T16 home session"
wait_and_capture "$WAIT_RESPONSE" "T-16a-active.log"
assert_contains "T-16a-active.log" "T16 home session" "T-16a" || true

# Switch to a different session via modal (second item = older session)
send_keys C-b; sleep 1
send_keys Down; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-16b-switched.log"

# Esc from a live-switched session should NOT restore priorState
# (priorState only applies to "view" of non-active sessions)
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-16c-after-esc.log"

# ── T-20: Modal switch doesn't show "Viewing session" ──
echo "T-20: Modal Switch is Live"
send_keys C-b; sleep 1
send_keys Down; sleep 0.3
send_keys Down; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-20a-switched.log"
assert_not_contains "T-20a-switched.log" "Viewing session" "T-20a-live" || true

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
