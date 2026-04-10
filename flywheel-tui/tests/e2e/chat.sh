#!/usr/bin/env bash
# Module: Chat — basic chat lifecycle, multi-turn, interrupt, buffering
source "$(dirname "$0")/lib/harness.sh"
init_harness "chat" "$@"
start_app

# ── T-01: Basic Chat Round Trip ──
echo "T-01: Basic Chat Round Trip"
send_text "say exactly: test reply alpha"
wait_and_capture "$WAIT_RESPONSE" "T-01a-first-message.log"
assert_contains "T-01a-first-message.log" "test reply alpha" "T-01a" || true

send_text "say exactly: test reply beta"
wait_and_capture "$WAIT_RESPONSE" "T-01b-second-message.log"
assert_contains "T-01b-second-message.log" "test reply beta" "T-01b" || true
assert_contains "T-01b-second-message.log" "test reply alpha" "T-01b-history" || true

# ── T-02: New Chat (Ctrl+N) ──
echo "T-02: New Chat (Ctrl+N)"
send_keys C-n
wait_and_capture "$WAIT_MEDIUM" "T-02a-new-chat.log"
assert_not_contains "T-02a-new-chat.log" "test reply alpha" "T-02a-cleared" || true
assert_contains "T-02a-new-chat.log" "bg" "T-02a-background" || true

send_text "say exactly: new chat gamma"
wait_and_capture "$WAIT_RESPONSE" "T-02b-new-msg.log"
assert_contains "T-02b-new-msg.log" "new chat gamma" "T-02b" || true

# ── T-03: Another New Chat (Ctrl+N again) ──
echo "T-03: Another New Chat"
send_keys C-n
sleep "$WAIT_MEDIUM"
capture "T-03a-new-chat.log"
assert_not_contains "T-03a-new-chat.log" "new chat gamma" "T-03a-cleared" || true

send_text "say exactly: third chat zeta"
wait_and_capture "$WAIT_RESPONSE" "T-03b-new-msg.log"
assert_contains "T-03b-new-msg.log" "third chat zeta" "T-03b" || true

# ── T-08: Interrupt Chat (Esc) ──
echo "T-08: Interrupt Chat (Esc)"
send_text "write a 1000 word essay about the history of mathematics"
sleep 8
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-08a-interrupted.log"
assert_contains "T-08a-interrupted.log" "Interrupted" "T-08a-interrupt" || true

send_text "say exactly: after interrupt theta"
wait_and_capture "$WAIT_RESPONSE" "T-08b-after-interrupt.log"
assert_contains "T-08b-after-interrupt.log" "after interrupt theta" "T-08b-alive" || true

# ── T-10: Rapid Ctrl+N Spam ──
echo "T-10: Rapid Ctrl+N Spam"
send_keys C-n; sleep 0.2
send_keys C-n; sleep 0.2
send_keys C-n; sleep 0.2
send_keys C-n; sleep 0.2
send_keys C-n
sleep 15
capture "T-10a-after-spam.log"
assert_contains "T-10a-after-spam.log" "flywheel" "T-10a-alive" || true

send_text "say exactly: survived spam iota"
wait_and_capture "$WAIT_RESPONSE" "T-10b-msg.log"
assert_contains "T-10b-msg.log" "survived spam iota" "T-10b" || true

# ── T-11: Message During Startup (buffering) ──
echo "T-11: Message During Startup"
send_keys C-n
sleep 0.1
send_text "say exactly: buffered lambda"
wait_and_capture "$WAIT_RESPONSE" "T-11a-buffered.log"
assert_contains "T-11a-buffered.log" "buffered lambda" "T-11a" || true

# ── T-19: Esc in Idle Chat ──
echo "T-19: Esc in Idle Chat"
send_text "say exactly: before esc test"
wait_and_capture "$WAIT_RESPONSE" "T-19a-before.log"
send_keys Escape
wait_and_capture "$WAIT_SHORT" "T-19b-after-esc.log"
send_text "say exactly: after esc kappa"
wait_and_capture "$WAIT_RESPONSE" "T-19c-still-alive.log"
assert_contains "T-19c-still-alive.log" "after esc kappa" "T-19c" || true

stop_app
finish_harness
