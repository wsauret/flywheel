#!/usr/bin/env bash
# Module: Session Modal — open/close, navigate, view, delete, archive
source "$(dirname "$0")/lib/e2e-framework.sh"
init_e2e "session-modal" "$@"
start_app


# ── T-00m: Model modal scope chrome ──
echo "T-00m: Model modal scope chrome"
for key in / m o d e l s; do
  send_keys "$key"
  sleep 0.05
done
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-00m-models-session.log"
assert_contains "T-00m-models-session.log" "This Tab" "T-00m-session-scope" || true
assert_contains "T-00m-models-session.log" "g defaults" "T-00m-session-help" || true
send_keys "g"
wait_and_capture "$WAIT_SHORT" "T-00m-models-defaults.log"
assert_contains "T-00m-models-defaults.log" "New Session Defaults" "T-00m-defaults-scope" || true
assert_contains "T-00m-models-defaults.log" "g this tab" "T-00m-defaults-help" || true
send_keys Escape
sleep 1

# Setup: create some history
send_text "say exactly: chat A for modal tests"
wait_and_capture "$WAIT_RESPONSE" "setup-chatA.log"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_text "say exactly: chat B for modal tests"
wait_and_capture "$WAIT_RESPONSE" "setup-chatB.log"

# ── T-04: Session Modal Open/Close ──
echo "T-04: Session Modal Navigation"
send_keys C-s
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
send_keys C-s
sleep 1
capture "T-06a-modal.log"
# Date-grouped session modal should show the current-day group and prior chats.
assert_contains "T-06a-modal.log" "Today" "T-06a-prior-chat-visible" || true

# Switch to a background session (navigate down to an older chat)
send_keys Down; sleep 0.3
send_keys Down; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-06b-switched.log"
# Switched session should show the old chat content
assert_contains "T-06b-switched.log" "modal tests" "T-06b-old-content" || true

# ── T-07: Delete Session ──
echo "T-07: Delete Session"
send_keys C-s
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

# View an inactive session
send_keys C-s; sleep 1
send_keys Up; sleep 0.3
send_keys Up; sleep 0.3
send_keys Enter
wait_and_capture "$WAIT_SHORT" "T-12c-viewing.log"

# Delete the viewed session
send_keys C-s; sleep 1
send_keys Up; sleep 0.3
send_keys Up; sleep 0.3
send_keys d; sleep 0.3
send_keys d
wait_and_capture 1 "T-12d-after-delete.log"
send_keys Escape; sleep 1
capture "T-12e-restored.log"

# ── T-34: Open sessions modal via command palette ──
echo "T-34: Sessions modal via command palette"
send_text "/help"
wait_and_capture "$WAIT_SHORT" "T-34a-palette-open.log"
assert_contains "T-34a-palette-open.log" "Commands" "T-34a-palette" || true
send_keys Down; sleep 0.2
send_keys Down; sleep 0.2
send_keys Enter
wait_and_capture 1 "T-34b-sessions-via-palette.log"
assert_contains "T-34b-sessions-via-palette.log" "Sessions" "T-34b-sessions-opened" || true
assert_not_contains "T-34b-sessions-via-palette.log" "Commands" "T-34b-palette-closed" || true
send_keys Escape; sleep 1

stop_app
finish_e2e
