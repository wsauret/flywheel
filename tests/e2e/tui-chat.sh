#!/usr/bin/env bash
# Module: Chat — basic chat lifecycle, multi-turn, interrupt, buffering
source "$(dirname "$0")/lib/e2e-framework.sh"
init_e2e "chat" "$@"
start_app

paste_literal_text() {
  tmux set-buffer -b "$SESSION-literal" "$1"
  tmux paste-buffer -p -t "$SESSION" -b "$SESSION-literal"
}

send_literal_text() {
  paste_literal_text "$1"
  send_keys Enter
}

type_literal_text() {
  local text="$1"
  local chunk
  while [ -n "$text" ]; do
    chunk="${text:0:12}"
    tmux send-keys -t "$SESSION" -l "$chunk"
    text="${text:12}"
    sleep 0.03
  done
}

capture_ansi() {
  local file="$LOG_DIR/$1"
  sleep "${2:-1}"
  if tmux capture-pane -t "$SESSION" -e -p > "$file" 2>/dev/null; then
    echo "  captured ANSI → $1"
  else
    echo "  FAILED ANSI capture → $1 (tmux session '$SESSION' is gone)"
    return 1
  fi
}

assert_ansi_fg_color_count() {
  local file="$LOG_DIR/$1"
  local needle="$2"
  local min_count="$3"
  local label="$4"
  local count
  count=$(NEEDLE="$needle" perl -ne '$raw = $_; $plain = $raw; $plain =~ s/\e\[[0-9;]*m//g; if (index($plain, $ENV{NEEDLE}) >= 0) { while($raw =~ /\e\[38;2;([0-9;]+)m/g){$seen{$1}=1} } END { print scalar(keys %seen) }' "$file" 2>/dev/null || echo 0)
  if [ "$count" -ge "$min_count" ]; then
    echo "PASS  $label — found $count foreground colors for '$needle' in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "FAIL  $label — found $count foreground colors for '$needle' in $1, expected at least $min_count" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

assert_blank_line_between() {
  local file="$LOG_DIR/$1"
  local needle_a="$2"
  local needle_b="$3"
  local label="$4"

  if NEEDLE_A="$needle_a" NEEDLE_B="$needle_b" perl -Mutf8 '-Mopen=:std,:encoding(UTF-8)' -ne '
    BEGIN { $a = $ENV{NEEDLE_A}; $b = $ENV{NEEDLE_B}; $seen_a = 0; $blank = 0; $ok = 0 }
    s/\r?\n\z//;
    if (!$seen_a) {
      if (index($_, $a) >= 0) { $seen_a = 1 }
      next;
    }
    if (index($_, $b) >= 0) { $ok = $blank ? 1 : 0; last }
    # User-message blank lines retain only the left quote gutter in pane captures.
    ($plain = $_) =~ s/^\s*[┃│]\s?//;
    $blank = 1 if $plain =~ /^\s*$/;
    END { exit($ok ? 0 : 1) }
  ' "$file" 2>/dev/null; then
    echo "PASS  $label — found blank line between '$needle_a' and '$needle_b' in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "FAIL  $label — missing blank line between '$needle_a' and '$needle_b' in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

assert_no_blank_line_between() {
  local file="$LOG_DIR/$1"
  local needle_a="$2"
  local needle_b="$3"
  local label="$4"

  if NEEDLE_A="$needle_a" NEEDLE_B="$needle_b" perl -Mutf8 '-Mopen=:std,:encoding(UTF-8)' -ne '
    BEGIN { $a = $ENV{NEEDLE_A}; $b = $ENV{NEEDLE_B}; $seen_a = 0; $ok = 0 }
    s/\r?\n\z//;
    if (!$seen_a) {
      if (index($_, $a) >= 0) { $seen_a = 1 }
      next;
    }
    if (index($_, $b) >= 0) { $ok = 1; last }
    ($plain = $_) =~ s/^\s*[┃│]\s?//;
    if ($plain =~ /^\s*$/) { $ok = 0; last }
    END { exit($ok ? 0 : 1) }
  ' "$file" 2>/dev/null; then
    echo "PASS  $label — found no blank line between '$needle_a' and '$needle_b' in $1" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
    return 0
  else
    echo "FAIL  $label — found blank line or missing adjacency between '$needle_a' and '$needle_b' in $1" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

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

# ── T-00: Font status command ──
echo "T-00: Font status command"
send_literal_text "/font status"
wait_and_capture "$WAIT_SHORT" "T-00a-font-status.log"
assert_contains "T-00a-font-status.log" "Monaspace Argon" "T-00a-font-status" || true

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
# After Ctrl+N the foreground chat is fresh — its tab carries the placeholder
# title `New Chat` (no first-message-derived title yet). The prior chat is
# registered as a background session (verified separately by T-02a-cleared
# above + the "1 session" footer counter).
assert_contains "T-02a-new-chat.log" "New Chat" "T-02a-background" || true

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

# ── T-04: Markdown Code Fences ──
echo "T-04: Markdown Code Fences"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_literal_text 'Reply with exactly three fenced Markdown code blocks and no prose. Block 1 info string: typescript title=demo. In block 1, write a TypeScript const declaration named e2eAnswer, typed as number, assigned to 42, with no semicolon. Block 2 info string: shell. In block 2, write one echo command whose argument is the joined token FLYWHEEL_E2E_SHELL. Block 3 info string: made-up-language. In block 3, write exactly two lines: first join alpha with -e2e and -unknown; second join beta with -e2e and -unknown.'
wait_and_capture "$WAIT_RESPONSE" "T-04a-code-fences.log"
capture_ansi "T-04a-code-fences.ansi.log" 0
assert_contains "T-04a-code-fences.log" "const e2eAnswer: number = 42" "T-04a-typescript-content" || true
assert_contains "T-04a-code-fences.log" "echo FLYWHEEL_E2E_SHELL" "T-04a-shell-content" || true
assert_contains "T-04a-code-fences.log" "alpha-e2e-unknown" "T-04a-unknown-alpha" || true
assert_contains "T-04a-code-fences.log" "beta-e2e-unknown" "T-04a-unknown-beta" || true
assert_ansi_fg_color_count "T-04a-code-fences.ansi.log" "const e2eAnswer: number = 42" 2 "T-04a-typescript-colors" || true

# ── T-05: Markdown Wide Table Layout ──
# This case is deterministic because the table is the user's own message: no
# model reply is needed. It guards the flex-grid table renderer against width
# overflow, and the 190-character unbroken cell exercises shrink-safe wrapping
# inside the cell.
echo "T-05: Markdown Wide Table Layout"
send_keys C-n
sleep "$WAIT_MEDIUM"
TABLE_RUN=$(printf 'x%.0s' $(seq 1 190))
TBL=$(printf '| A | B | C | Claims |\n| --- | --- | --- | --- |\n| left | mid | 123 | %s |\n| file | code | link | done |' "$TABLE_RUN")
send_literal_text "$TBL"

for width in 80 120 200; do
  resize_terminal "$width"
  wait_and_capture 2 "T-05-table-w${width}.log"
  assert_contains "T-05-table-w${width}.log" "Claims" "T-05-w${width}-header" || true
  assert_contains "T-05-table-w${width}.log" "┼" "T-05-w${width}-junction" || true
  assert_contains "T-05-table-w${width}.log" "left" "T-05-w${width}-left" || true
  assert_contains "T-05-table-w${width}.log" "code" "T-05-w${width}-code" || true
  assert_not_contains "T-05-table-w${width}.log" "││" "T-05-w${width}-no-doubled-borders" || true
done
resize_terminal 120

# ── T-06: Markdown Paragraph + Code-Block Spacing ──
# Deterministic: this renders the user's own markdown through MarkdownBody, so
# no model reply is needed to verify pane-visible blank-line spacing.
echo "T-06: Markdown Paragraph + Code-Block Spacing"
send_keys C-n
sleep "$WAIT_MEDIUM"
SPACING_MESSAGE=$(printf 'SpacingAlphaParagraph\n\n```ts\nconst e2eSpacing = 7\n```\n\nSpacingBetaParagraph')
send_literal_text "$SPACING_MESSAGE"
wait_and_capture 2 "T-06-markdown-spacing.log"
assert_contains "T-06-markdown-spacing.log" "SpacingAlphaParagraph" "T-06-alpha-present" || true
assert_contains "T-06-markdown-spacing.log" "const e2eSpacing = 7" "T-06-code-present" || true
assert_contains "T-06-markdown-spacing.log" "SpacingBetaParagraph" "T-06-beta-present" || true
assert_blank_line_between "T-06-markdown-spacing.log" "SpacingAlphaParagraph" "const e2eSpacing" "T-06-blank-before-code" || true
assert_blank_line_between "T-06-markdown-spacing.log" "const e2eSpacing" "SpacingBetaParagraph" "T-06-blank-after-code" || true
assert_blank_line_between "T-06-markdown-spacing.log" "SpacingAlphaParagraph" "SpacingBetaParagraph" "T-06-blank-between-paragraphs" || true
assert_not_contains "T-06-markdown-spacing.log" "SpacingAlphaParagraphSpacingBetaParagraph" "T-06-paragraphs-not-concatenated" || true

# ── T-06b: Markdown Tight List Spacing ──
# Deterministic: tight source lists preserve source spacing; loose lists own blank lines.
echo "T-06b: Markdown Tight List Spacing"
send_keys C-n
sleep "$WAIT_MEDIUM"
LIST_SPACING_MESSAGE=$(printf '1. TightListAlpha\n2. TightListBeta\n3. TightListGamma\n\n- BulletAlpha\n- BulletBeta')
send_literal_text "$LIST_SPACING_MESSAGE"
wait_and_capture 2 "T-06b-markdown-list-spacing.log"
assert_contains "T-06b-markdown-list-spacing.log" "TightListAlpha" "T-06b-number-alpha-present" || true
assert_contains "T-06b-markdown-list-spacing.log" "TightListBeta" "T-06b-number-beta-present" || true
assert_contains "T-06b-markdown-list-spacing.log" "TightListGamma" "T-06b-number-gamma-present" || true
assert_contains "T-06b-markdown-list-spacing.log" "BulletAlpha" "T-06b-bullet-alpha-present" || true
assert_contains "T-06b-markdown-list-spacing.log" "BulletBeta" "T-06b-bullet-beta-present" || true
assert_no_blank_line_between "T-06b-markdown-list-spacing.log" "TightListAlpha" "TightListBeta" "T-06b-tight-between-numbered-1-2" || true
assert_no_blank_line_between "T-06b-markdown-list-spacing.log" "TightListBeta" "TightListGamma" "T-06b-tight-between-numbered-2-3" || true
assert_no_blank_line_between "T-06b-markdown-list-spacing.log" "BulletAlpha" "BulletBeta" "T-06b-tight-between-bullets" || true

# ── T-07: Streamed Assistant Markdown Spacing ──
# Soft/model-dependent: T-06 is the deterministic guarantee. This also doubles
# as a manual long-stream responsiveness check: the full accumulated markdown is
# re-rendered on each throttled tick and should converge to the same final shape.
echo "T-07: Streamed Assistant Markdown Spacing"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_literal_text 'Reply with exactly this Markdown shape and no other prose: first a paragraph formed by joining Stream, Alpha, and Paragraph with no spaces. Then a blank line, then a fenced ts code block containing one line: a const declaration named streamedSpacing assigned to 7 with no semicolon. Then a blank line, then a paragraph formed by joining Stream, Beta, and Paragraph with no spaces.'
wait_and_capture "$WAIT_RESPONSE" "T-07-streamed-spacing.log"
assert_contains "T-07-streamed-spacing.log" "StreamAlphaParagraph" "T-07-alpha-present" || true
assert_contains "T-07-streamed-spacing.log" "const streamedSpacing = 7" "T-07-code-present" || true
assert_contains "T-07-streamed-spacing.log" "StreamBetaParagraph" "T-07-beta-present" || true
assert_blank_line_between "T-07-streamed-spacing.log" "StreamAlphaParagraph" "const streamedSpacing" "T-07-blank-before-code" || true
assert_blank_line_between "T-07-streamed-spacing.log" "const streamedSpacing" "StreamBetaParagraph" "T-07-blank-after-code" || true
assert_blank_line_between "T-07-streamed-spacing.log" "StreamAlphaParagraph" "StreamBetaParagraph" "T-07-blank-between-paragraphs" || true

# ── T-07b: Long Streamed Mixed Markdown (incremental lexer) ──
# Exercises the incremental streaming lexer with a long reply mixing a list, a
# fence, and a table: commit points stream past the guard band repeatedly and
# the final pane must converge to the same shape a full re-lex produces.
echo "T-07b: Long Streamed Mixed Markdown"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_literal_text 'Reply with exactly this Markdown and no other prose. First a paragraph formed by joining Long, Stream, and Intro with no spaces. Then a blank line, then a bulleted list of six items where item N is the word StreamItem joined to the number N (StreamItem1 through StreamItem6), one item per line. Then a blank line, then a fenced ts code block with one line: a const named longStreamConst assigned to 99 with no semicolon. Then a blank line, then a two-column Markdown table with header columns HeadA and HeadB and two data rows: first row cells CellA1 and CellB1, second row cells CellA2 and CellB2. Then a blank line, then a paragraph formed by joining Long, Stream, and Outro with no spaces.'
wait_and_capture "$WAIT_RESPONSE" "T-07b-long-stream.log"
assert_contains "T-07b-long-stream.log" "LongStreamIntro" "T-07b-intro" || true
assert_contains "T-07b-long-stream.log" "StreamItem1" "T-07b-list-first" || true
assert_contains "T-07b-long-stream.log" "StreamItem6" "T-07b-list-last" || true
assert_contains "T-07b-long-stream.log" "const longStreamConst = 99" "T-07b-fence" || true
assert_contains "T-07b-long-stream.log" "HeadA" "T-07b-table-header" || true
assert_contains "T-07b-long-stream.log" "CellB2" "T-07b-table-cell" || true
assert_contains "T-07b-long-stream.log" "LongStreamOutro" "T-07b-outro" || true
assert_blank_line_between "T-07b-long-stream.log" "StreamItem6" "const longStreamConst" "T-07b-blank-list-to-fence" || true
assert_blank_line_between "T-07b-long-stream.log" "const longStreamConst" "HeadA" "T-07b-blank-fence-to-table" || true

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

# ── T-30: Command Palette via /help ──
echo "T-30: Command Palette via /help"
send_keys C-n
sleep "$WAIT_MEDIUM"
send_literal_text "/help"
wait_and_capture "$WAIT_SHORT" "T-30a-palette-open.log"
assert_contains "T-30a-palette-open.log" "Commands" "T-30a-palette-title" || true

# ── T-31: Palette search filters results ──
echo "T-31: Palette search filter"
send_keys s; sleep 0.2
send_keys e; sleep 0.2
send_keys s; sleep 0.2
wait_and_capture 1 "T-31a-palette-filter.log"
assert_contains "T-31a-palette-filter.log" "Sessions" "T-31a-sessions-visible" || true

# ── T-32: Palette Esc closes and returns to prompt ──
echo "T-32: Palette Esc close"
send_keys Escape
wait_and_capture 1 "T-32a-palette-closed.log"
assert_not_contains "T-32a-palette-closed.log" "Commands" "T-32a-palette-gone" || true

# ── T-33: Palette Enter activates sessions command ──
echo "T-33: Palette activate sessions"
send_literal_text "/help"
wait_and_capture "$WAIT_SHORT" "T-33a-palette-reopen.log"
assert_contains "T-33a-palette-reopen.log" "Commands" "T-33a-palette-reopened" || true
# Navigate to Sessions and activate
send_keys s; sleep 0.2
send_keys e; sleep 0.2
send_keys s; sleep 0.2
sleep 0.5
send_keys Enter
wait_and_capture 1 "T-33b-sessions-opened.log"
assert_contains "T-33b-sessions-opened.log" "Sessions" "T-33b-sessions-modal" || true
assert_not_contains "T-33b-sessions-opened.log" "Commands" "T-33b-palette-dismissed" || true
send_keys Escape
sleep 1

# ── T-34: Prompt expands beyond five wrapped rows ──
echo "T-34: Prompt expands beyond five wrapped rows"
send_keys C-n
sleep "$WAIT_MEDIUM"
resize_terminal 44 40
PROMPT_EXPAND_DRAFT="PromptExpandStart $(printf 'wrapword %.0s' $(seq 1 28)) PromptExpandTailVisible"
type_literal_text "$PROMPT_EXPAND_DRAFT"
wait_and_capture 1 "T-34a-prompt-expanded.log"
assert_contains "T-34a-prompt-expanded.log" "PromptExpandTailVisible" "T-34a-tail-visible" || true
resize_terminal 120 40

# ── T-40: Inline step commands ──
echo "T-40: Inline step commands"
send_keys C-n
sleep "$WAIT_MEDIUM"
# T-40a: ghost completion renders the rest of "code-review" after the cursor.
type_literal_text "/step:co"
wait_and_capture 1 "T-40a-step-ghost.log"
assert_contains "T-40a-step-ghost.log" "code-review" "T-40a-step-ghost" || true
send_keys C-u

# T-40b: submitting /step:code-review injects the assembled step prompt as a
# user message. The message is long, so the pane scrolls past its first line
# (Step "Code Review" is now active.); assert on the deterministic inline
# postamble that remains visible at the bottom.
send_keys C-n
sleep "$WAIT_MEDIUM"
send_literal_text "/step:code-review"
wait_and_capture "$WAIT_SHORT" "T-40b-step-active.log"
assert_contains "T-40b-step-active.log" "Inline Execution" "T-40b-step-active" || true
assert_contains "T-40b-step-active.log" "running inline in the current chat session" "T-40b-step-postamble" || true

# T-40c: command palette lists the step command. The unfiltered list scrolls
# the Step category below the modal fold, so filter for "step" and assert the
# row (footer + title); the filtered view hides category headers.
send_keys C-n
sleep "$WAIT_MEDIUM"
send_literal_text "/help"
wait_and_capture "$WAIT_SHORT" "T-40c-palette-open.log"
assert_contains "T-40c-palette-open.log" "Commands" "T-40c-palette-open" || true
send_keys s; sleep 0.2
send_keys t; sleep 0.2
send_keys e; sleep 0.2
send_keys p; sleep 0.2
wait_and_capture 1 "T-40c-palette-step.log"
assert_contains "T-40c-palette-step.log" "/step:code-review Code Review" "T-40c-palette-step-row" || true
send_keys Escape
sleep 1

stop_app
finish_e2e
