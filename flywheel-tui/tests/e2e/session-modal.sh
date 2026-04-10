#!/usr/bin/env bash
# Module: Session Modal — open/close, navigate, view, delete, archive
source "$(dirname "$0")/lib/harness.sh"
init_harness "session-modal" "$@"
start_app

# Setup: create some history
send_text "say exactly: chat A for modal tests"
wait_and_capture "$WAIT_RESPONSE" "setup-chatA.log"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: chat B for modal tests"
wait_and_capture "$WAIT_RESPONSE" "setup-chatB.log"

# ── T-04: Session Modal Open/Close ──
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

# ── T-06: Switch to Background Session ──
echo "T-06: Switch to Background Session"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_keys C-b
sleep 1
capture "T-06a-modal.log"
assert_contains "T-06a-modal.log" "Active" "T-06a-has-active" || true

# Switch to a background session (navigate down to an older chat)
send_keys Down; sleep 0.3
send_keys Down; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-06b-switched.log"
# Switched session should show the old chat content
assert_contains "T-06b-switched.log" "modal tests" "T-06b-old-content" || true

# ── T-07: Delete Session ──
echo "T-07: Delete Session"
send_keys C-b
sleep 1
send_keys Up; sleep 0.3
send_keys Up; sleep 0.3
capture "T-07a-before-delete.log"

send_keys d; sleep 0.5
capture "T-07b-confirm-prompt.log"
assert_contains "T-07b-confirm-prompt.log" "Sessions" "T-07b-still-open" || true

send_keys d; sleep 1
capture "T-07c-after-delete.log"
send_keys Escape; sleep 1

# ── T-12: View → Delete → Restore ──
echo "T-12: View → Delete → Restore"
send_text "say exactly: active chat T12"
wait_and_capture "$WAIT_RESPONSE" "T-12a-active.log"

send_keys C-n; sleep "$WAIT_MEDIUM"
send_text "say exactly: new chat after T12"
wait_and_capture "$WAIT_RESPONSE" "T-12b-new-chat.log"

# View a completed session
send_keys C-b; sleep 1
send_keys Up; sleep 0.3
send_keys Up; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-12c-viewing.log"

# Delete the viewed session
send_keys C-b; sleep 1
send_keys Up; sleep 0.3
send_keys Up; sleep 0.3
send_keys d; sleep 0.3
send_keys d
wait_and_capture 1 "T-12d-after-delete.log"
send_keys Escape; sleep 1
capture "T-12e-restored.log"

stop_app
finish_harness
