#!/usr/bin/env bash
# Smoke: plugin loads and exposes /fly:* slash commands.
#
# Spawns claude in a tmux session with the local plugin loaded via
# --plugin-dir, opens the slash-command palette by typing "/fly", and
# asserts that the expected commands appear in the autocompletion list.
#
# This is the cheapest test in the suite — claude does not actually
# invoke any skill or call the model. It only confirms that
# .claude-plugin metadata + commands/ are discoverable.

set -u

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
LIB="$REPO_ROOT/tests/integration/lib"
. "$LIB/assert.sh"
. "$LIB/sandbox.sh"
. "$LIB/tmux.sh"

pass=0
fail=0
SESSION="flywheel-int-plugin-loads"
SBOX=""

cleanup() {
  tmux_kill "$SESSION"
  cleanup_sandbox "$SBOX"
}
trap cleanup EXIT

SBOX=$(make_sandbox "plugin-loads")
tmux_start "$SESSION" "$SBOX"

# Wait for the welcome screen / trust prompt.
if wait_for_pane "$SESSION" "Quick safety check|Welcome back|\\? for shortcuts" 30; then
  note_pass "claude TUI started"
else
  note_fail "claude TUI did not start within 30s"
  echo "----- pane -----"; tmux_capture "$SESSION"; echo "----- end -----"
  finalize
fi

# If the trust prompt is showing, accept it (Enter selects "Yes, I trust").
if tmux_capture "$SESSION" | grep -q "Quick safety check"; then
  tmux_send_line "$SESSION" ""
  if wait_for_pane "$SESSION" "\\? for shortcuts|Welcome back" 15; then
    note_pass "trust prompt confirmed"
  else
    note_fail "trust prompt did not advance"
    finalize
  fi
fi

# Type "/fly" to filter the slash-command palette. Do NOT press Enter; the
# palette is rendered only while the box has draft input.
tmux_send "$SESSION" "/fly"
sleep 3

palette="$(tmux_capture "$SESSION")"

assert_palette_has() {
  local cmd="$1"
  if echo "$palette" | grep -F -q "$cmd"; then
    note_pass "palette lists $cmd"
  else
    note_fail "palette missing $cmd"
  fi
}

assert_palette_has "/fly:plan"
assert_palette_has "/fly:work"
assert_palette_has "/fly:ship"
assert_palette_has "/fly:review"
assert_palette_has "/fly:debug"

# Sanity: the (flywheel) source tag appears, confirming the entries come
# from the plugin we --plugin-dir'd in (not from the user-installed copy).
if echo "$palette" | grep -F -q "(flywheel)"; then
  note_pass "palette tags entries with (flywheel) source"
else
  note_fail "palette did not tag any entry as (flywheel)"
  echo "----- palette -----"; echo "$palette"; echo "----- end palette -----"
fi

finalize
