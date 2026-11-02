#!/usr/bin/env bash
# Module: Session Recovery — stale session recovery after restart, exit flows,
# durable chat history via SQLite chat tree facts (ARCH-SESSIONS-047).
source "$(dirname "$0")/lib/e2e-framework.sh"
init_e2e "session-recovery" "$@"
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

send_keys C-s
wait_and_capture 1 "BUG1b-modal.log"
send_keys Escape; sleep 1

# Stale chat sessions should be inactive (○), not active/current (●)
assert_contains "BUG1b-modal.log" "○" "BUG1b-has-inactive-marker" || true
assert_not_contains "BUG1b-modal.log" "●" "BUG1b-no-active-marker" || true

# ── TREE-01: Chat resume reads from SQLite chat tree facts (ARCH-SESSIONS-047, ARCH-CONTEXT-002) ──
# After a chat turn lands, the event store must contain chat tree facts with
# the user message we sent. Chat resume on restart reads this tree (not
# conversations/<id>.jsonl) to reconstruct the model-visible context.
echo "TREE-01: Durable Session Tree"
EVENT_DB="$UAT_DIR/.flywheel/flywheel.sqlite"
TREE_EVENTS="$LOG_DIR/TREE-01a-chat-tree-events.jsonl"
if [ -f "$EVENT_DB" ]; then
  (cd "$PROJECT_DIR" && bun -e "
    import { Database } from 'bun:sqlite';
    const db = new Database(process.argv[1], { readonly: true });
    for (const row of db.query(\"select type, payload from event where type in ('chat.tree.created', 'chat.entries.appended') order by position\").all()) {
      console.log(JSON.stringify({ type: row.type, payload: JSON.parse(row.payload) }));
    }
    db.close();
  " "$EVENT_DB") > "$TREE_EVENTS"
  if [ -s "$TREE_EVENTS" ]; then
    echo "PASS  TREE-01a-tree-exists — found SQLite chat tree facts" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    # The user message text must appear in the tree facts (proxy for model context)
    if grep -q "pre-restart" "$TREE_EVENTS" 2>/dev/null; then
      echo "PASS  TREE-01b-tree-has-user-content — pre-restart message in tree" >> "$SUMMARY"
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo "FAIL  TREE-01b-tree-has-user-content — pre-restart message missing from chat tree facts" >> "$SUMMARY"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
    # Entries should declare the durable schema's `kind` discriminant.
    if grep -q '"kind":"message"' "$TREE_EVENTS" 2>/dev/null; then
      echo "PASS  TREE-01c-tree-message-kind — message kind entries present" >> "$SUMMARY"
      PASS_COUNT=$((PASS_COUNT + 1))
    else
      echo "FAIL  TREE-01c-tree-message-kind — no message kind entries in chat tree facts" >> "$SUMMARY"
      FAIL_COUNT=$((FAIL_COUNT + 1))
    fi
  else
    echo "FAIL  TREE-01a-tree-exists — no chat tree facts in $EVENT_DB" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
else
  echo "FAIL  TREE-01a-tree-exists — event store missing: $EVENT_DB" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi

# Resume one of the chats and send a follow-up. The follow-up must append to
# the chat tree facts, proving resume re-uses the tree as history.
send_keys C-s
wait_and_capture 1 "TREE-02a-modal.log"
send_keys Down; sleep 0.3
send_keys Enter; sleep "$WAIT_MEDIUM"
send_text "say exactly: post-resume turn"
sleep "$WAIT_RESPONSE"
capture "TREE-02b-resumed.log"

if [ -f "$EVENT_DB" ]; then
  (cd "$PROJECT_DIR" && bun -e "
    import { Database } from 'bun:sqlite';
    const db = new Database(process.argv[1], { readonly: true });
    for (const row of db.query(\"select type, payload from event where type = 'chat.entries.appended' order by position\").all()) {
      console.log(JSON.stringify({ type: row.type, payload: JSON.parse(row.payload) }));
    }
    db.close();
  " "$EVENT_DB") > "$LOG_DIR/TREE-02-chat-tree-events.jsonl"
  if grep -q "post-resume turn" "$LOG_DIR/TREE-02-chat-tree-events.jsonl" 2>/dev/null; then
    echo "PASS  TREE-02-resume-appends-tree — follow-up turn in chat tree facts" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  TREE-02-resume-appends-tree — follow-up turn missing from chat tree facts" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
fi

# ── EXIT-01: Ctrl+C Ignored ──
echo "EXIT-01: Ctrl+C ignored"
send_keys C-c; sleep "$WAIT_SHORT"
capture "EXIT-01a-ctrl-c-ignored.log"
assert_contains_regex "EXIT-01a-ctrl-c-ignored.log" "Send a message|/new for fresh chat" "EXIT-01a-still-running" || true

# ── EXIT-02: /exit Command ──
echo "EXIT-02: /exit"
send_text "/exit"
sleep "$WAIT_SHORT"
capture "EXIT-02a-slash-exit.log"
assert_not_contains_regex "EXIT-02a-slash-exit.log" "Send a message|/new for fresh chat" "EXIT-02a-no-tui" || true

finish_e2e
