# tmux + claude driver helpers.
#
# Each test case opens a detached tmux session that runs `claude` against
# a sandbox cwd with the local plugin loaded via --plugin-dir. We then
# poll the pane and the on-disk sandbox to verify behavior.

# Resolve plugin dir once. The plugin layout is:
#   plugin/flywheel/{commands,skills,agents,schemas}
# Claude's --plugin-dir wants the dir that contains commands/ and skills/.
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)/flywheel"

# tmux_start <session> <cwd>
# Spawn a detached tmux session running claude inside <cwd> with the plugin.
# Uses bypassPermissions so the session does not block on tool prompts.
tmux_start() {
  local session="$1"
  local cwd="$2"
  tmux kill-session -t "$session" 2>/dev/null || true
  # Fresh shell; explicitly cd into sandbox so claude reads sandbox cwd.
  tmux new-session -d -s "$session" -x 200 -y 50 "cd '$cwd' && exec claude --plugin-dir '$PLUGIN_ROOT' --permission-mode bypassPermissions --model claude-haiku-4-5"
}

# tmux_send <session> <text>
# Type literal text into the pane (no Enter).
tmux_send() {
  local session="$1"
  shift
  tmux send-keys -t "$session" "$*"
}

# tmux_send_line <session> <text>
# Type text, briefly flush, then press Enter as a separate keystroke.
# Sending text and Enter in the same send-keys call races on long
# strings — the TUI sometimes processes Enter before the text is in the
# input box, leaving the prompt sitting unsubmitted at 0 tokens.
tmux_send_line() {
  local session="$1"
  shift
  tmux send-keys -t "$session" -l "$*"
  sleep 0.5
  tmux send-keys -t "$session" Enter
}

# tmux_capture <session> -> stdout: full visible pane content
tmux_capture() {
  local session="$1"
  tmux capture-pane -t "$session" -p
}

# tmux_kill <session>
tmux_kill() {
  local session="$1"
  tmux kill-session -t "$session" 2>/dev/null || true
}

# wait_for_pane <session> <pattern> <timeout-seconds>
# Poll the pane every 1s for up to <timeout> seconds. Returns 0 on match,
# 1 on timeout. Pattern is a grep -E regex.
wait_for_pane() {
  local session="$1"
  local pattern="$2"
  local timeout="${3:-30}"
  local i=0
  while [ "$i" -lt "$timeout" ]; do
    if tmux_capture "$session" | grep -E -q "$pattern"; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# wait_for_file <path> <timeout-seconds>
# Poll the filesystem every 1s for up to <timeout> seconds.
wait_for_file() {
  local path="$1"
  local timeout="${2:-30}"
  local i=0
  while [ "$i" -lt "$timeout" ]; do
    if [ -e "$path" ]; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

# Autopilot: drive AskUserQuestion dialogs that would otherwise block.
#
# Three dialog shapes exist:
#   - Radio:    options are "1. Foo (Recommended)" — pressing Enter
#               selects the highlighted option AND advances the flow.
#   - Checkbox: options are "1. [ ] Foo (Recommended)" plus a wizard
#               bar like "← ☐ P3 Triage  ✔ Submit →". Pressing Enter
#               toggles the checkbox; the user must right-arrow to the
#               Submit step and Enter again to commit.
#   - Multi-question review: bundled AskUserQuestion presents each
#               question in turn, then a final "Review your answers /
#               Ready to submit your answers?" radio with "1. Submit
#               answers / 2. Cancel". Enter on the highlighted Submit
#               commits.
#
# autopilot_respond fires the correct key sequence once. Throttle via
# AUTOPILOT_COOLDOWN so we don't spam a dialog mid-render.
AUTOPILOT_COOLDOWN=6

# autopilot_respond <session>
# Returns 0 if a key sequence was sent, 1 if no dialog was visible.
autopilot_respond() {
  local session="$1"
  local pane
  pane=$(tmux_capture "$session")
  if ! echo "$pane" | grep -E -q "Enter to select|Select an option|Submit answers|Ready to submit"; then
    return 1
  fi
  # Detect checkbox dialog: option lines contain [ ] or [✓] or [x].
  # Line shape is either "  N. [...]" or "❯ N. [...]" — the cursor
  # glyph can be followed by a space before the number.
  if echo "$pane" | grep -E -q "^[[:space:]❯]*[0-9]+\.[[:space:]]*\["; then
    tmux send-keys -t "$session" Enter
    sleep 0.5
    tmux send-keys -t "$session" Right
    sleep 0.5
    tmux send-keys -t "$session" Enter
  else
    tmux send-keys -t "$session" Enter
  fi
  return 0
}

# wait_for_file_with_autopilot <session> <path> <timeout-seconds>
# Poll for <path> to appear. While polling, drive any AskUserQuestion
# dialog that shows up. Without this, skills like plan-consolidation
# deadlock on P3/open-question prompts.
wait_for_file_with_autopilot() {
  local session="$1"
  local path="$2"
  local timeout="${3:-30}"
  local i=0
  local last_fire=0
  while [ "$i" -lt "$timeout" ]; do
    if [ -e "$path" ]; then
      return 0
    fi
    local now
    now=$(date +%s)
    if [ $((now - last_fire)) -ge "$AUTOPILOT_COOLDOWN" ]; then
      if autopilot_respond "$session"; then
        last_fire="$now"
      fi
    fi
    sleep 2
    i=$((i + 2))
  done
  return 1
}

# wait_for_prompt <session> <timeout-seconds>
# Block until claude has printed its initial prompt and is ready for input.
# We look for the "?" or ">" prompt boundary the TUI shows when idle.
wait_for_prompt() {
  local session="$1"
  local timeout="${2:-30}"
  # The TUI prints a help-hint line once the input box is mounted.
  wait_for_pane "$session" "(\\? for shortcuts|\\> for shortcuts|Welcome to Claude Code)" "$timeout"
}
