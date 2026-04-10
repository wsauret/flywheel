#!/usr/bin/env bash
# Module: Session Recovery — stale session recovery after restart, exit flows
source "$(dirname "$0")/lib/harness.sh"
init_harness "session-recovery" "$@"
start_app

# ── BUG1: Stale Session Recovery After Restart ──
echo "BUG1: Stale Session Recovery"
send_keys C-n; sleep "$WAIT_MEDIUM"
send_text "say exactly: pre-restart A"
sleep "$WAIT_RESPONSE"
send_keys C-n; sleep "$WAIT_MEDIUM"
send_text "say exactly: pre-restart B"
sleep "$WAIT_RESPONSE"

restart_app
capture "BUG1a-after-restart.log"

send_keys C-b
wait_and_capture 1 "BUG1b-modal.log"
send_keys Escape; sleep 1

# Stale chat sessions should be Paused (❙), not Active (●)
assert_contains "BUG1b-modal.log" "Paused" "BUG1b-has-paused" || true

# ── EXIT-01: Ctrl+C Exit ──
echo "EXIT-01: Ctrl+C"
send_keys C-c; sleep "$WAIT_SHORT"
capture "EXIT-01a-exited.log"
assert_not_contains "EXIT-01a-exited.log" "Send a message" "EXIT-01a-no-tui" || true

# ── EXIT-02: /exit Command ──
echo "EXIT-02: /exit"
send_keys "FLYWHEEL_PROJECT_CWD=$UAT_DIR bun run dev 2>>$STDERR_LOG" Enter
sleep "$WAIT_MEDIUM"
send_text "/exit"
sleep "$WAIT_SHORT"
capture "EXIT-02a-slash-exit.log"

finish_harness
