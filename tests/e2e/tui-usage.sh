#!/usr/bin/env bash
# Installed-binary acceptance for the unified Usage modal.
source "$(dirname "$0")/lib/e2e-framework.sh"
init_e2e "usage" "$@"

BIN="$(command -v flywheel || true)"
if [ -z "$BIN" ] && [ -x "$HOME/.local/bin/flywheel" ]; then BIN="$HOME/.local/bin/flywheel"; fi
if [ -z "$BIN" ] && [ -x "/usr/local/bin/flywheel" ]; then BIN="/usr/local/bin/flywheel"; fi
if [ -z "$BIN" ]; then
  echo "FAIL  installed flywheel binary was not found" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  finish_e2e
fi

cat > "$UAT_DIR/.flywheel/flywheel.toml" <<'TOML'
[notifications]
desktop = false
TOML
HOME="$UAT_DIR" bun run "$PROJECT_DIR/tests/e2e/seed-usage.ts" "$UAT_DIR/.flywheel" > "$LOG_DIR/seed.log"
assert_contains "seed.log" "two isolated Usage profiles" "T-00-unified-fixture"
assert_contains "seed.log" "No provider or model request was issued" "T-00-safe-fixture"

wait_for_marker() {
  local marker="${1:?marker required}"
  local max_wait="${2:-15}"
  local waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    if tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -Fq "$marker"; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

wait_for_absence() {
  local marker="${1:?marker required}"
  local max_wait="${2:-15}"
  local waited=0
  while [ "$waited" -lt "$max_wait" ]; do
    if ! tmux capture-pane -t "$SESSION" -p 2>/dev/null | grep -Fq "$marker"; then return 0; fi
    sleep 1
    waited=$((waited + 1))
  done
  return 1
}

capture_when() {
  local marker="$1"
  local file="$2"
  if ! wait_for_marker "$marker" 15; then
    echo "FAIL  readiness marker '$marker' did not appear" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  capture "$file" 0
}

start_installed_app() {
  tmux new-session -d -s "$SESSION" -x 120 -y 36
  send_keys "cd '$UAT_DIR' && HOME='$UAT_DIR' FLYWHEEL_PROJECT_ROOT='$UAT_DIR' FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS='${FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS:-1}' HTTPS_PROXY='http://127.0.0.1:1' https_proxy='http://127.0.0.1:1' HTTP_PROXY='http://127.0.0.1:1' http_proxy='http://127.0.0.1:1' ALL_PROXY='http://127.0.0.1:1' all_proxy='http://127.0.0.1:1' NO_PROXY='' no_proxy='' '$BIN' 2>'$STDERR_LOG'" Enter
  wait_for_chat 30
  capture "00-boot.log" 0
}

start_installed_app
send_text "/usage"
capture_when "Alpha Exact" "T-01-accounts-standard.log"
assert_contains "T-01-accounts-standard.log" "[Accounts]" "T-01-accounts-default"
assert_not_contains "T-01-accounts-standard.log" "24h" "T-01-accounts-no-ranges"
assert_contains "T-01-accounts-standard.log" "PROVIDER ALLOWANCE" "T-01-provider-allowance"
assert_contains "T-01-accounts-standard.log" "Weekly quota" "T-01-exact-provider-window"
assert_not_contains "T-01-accounts-standard.log" "Spark weekly" "T-01-detail-hidden"

resize_terminal 58 36
capture_when "Alpha Exact" "T-02-accounts-narrow.log"
assert_contains "T-02-accounts-narrow.log" "Alpha Exact" "T-02-narrow-card"
send_keys PageDown PageDown
capture_when "FLYWHEEL ACTIVITY" "T-02-detail-scroll.log"
assert_contains "T-02-detail-scroll.log" "15,758 tokens" "T-02-exact-flywheel-tokens"
assert_contains "T-02-detail-scroll.log" "Cache read 345" "T-02-exact-cache-read"
assert_contains "T-02-detail-scroll.log" "Reasoning 678" "T-02-exact-reasoning"

send_keys c
send_keys PageDown
capture_when "Spark weekly" "T-03-detail.log"
assert_contains "T-03-detail.log" "Spark weekly" "T-03-detail-toggle"

resize_terminal 160 36
capture_when "Charlie Paid Boundary" "T-04-accounts-wide.log"
assert_contains "T-04-accounts-wide.log" "Alpha Exact" "T-04-wide-first-card"
assert_contains "T-04-accounts-wide.log" "Bravo Included Boundary" "T-04-wide-second-card"
assert_contains "T-04-accounts-wide.log" "Charlie Paid Boundary" "T-04-wide-third-card"
send_keys Down Down Down Down Down Down Down Down
capture_when "Copilot Timing Unavailable" "T-05-unavailable-source.log"
assert_contains "T-05-unavailable-source.log" "Window usage unavailable" "T-05-unavailable-window"
assert_contains "T-05-unavailable-source.log" "Resets in" "T-05-relative-reset"

send_keys s
capture_when "Estimated billed spend" "T-06-spend-month.log"
assert_contains "T-06-spend-month.log" "[Month]" "T-06-spend-default-month"
assert_contains "T-06-spend-month.log" "Included value" "T-06-included-total"
assert_contains "T-06-spend-month.log" "Partial range" "T-06-partial-tracking"
assert_contains "T-06-spend-month.log" "Usage incomplete" "T-06-incomplete-ledger"
assert_contains "T-06-spend-month.log" "billed" "T-06-phase6-billed-copy"
send_keys Left Left
capture_when "[24h]" "T-06-spend-24h.log"
assert_contains "T-06-spend-24h.log" "[24h]" "T-06-spend-24h"
send_keys Right
capture_when "[7d]" "T-06-spend-7d.log"
send_keys Right
capture_when "[Month]" "T-06-spend-month-again.log"
send_keys Right
capture_when "[All]" "T-06-spend-all.log"

send_keys h
capture_when "[24h]" "T-07-history-24h.log"
assert_contains "T-07-history-24h.log" "provider observation" "T-07-history-observations"
send_keys Right
capture_when "[7d]" "T-07-history-7d.log"
send_keys Right
capture_when "[Month]" "T-07-history-month.log"
send_keys Right
capture_when "[All]" "T-07-history-all.log"

send_keys a
capture_when "[Accounts]" "T-08-accounts-return.log"
assert_not_contains "T-08-accounts-return.log" "24h" "T-08-accounts-still-no-ranges"

send_keys Escape
if ! wait_for_absence "[Accounts]" 10; then
  echo "FAIL  Usage modal did not close" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
fi
send_text "/profile Usage Isolated"
capture_when "Usage Isolated" "T-09-profile.log"
send_text "/usage"
capture_when "Isolated Account" "T-09-isolation.log"
assert_not_contains "T-09-isolation.log" "Alpha Exact" "T-09-profile-isolation"

send_keys Escape
stop_app
HOME="$UAT_DIR" FLYWHEEL_PROJECT_ROOT="$UAT_DIR" "$BIN" events search --type provider.requested --type model.requested --json > "$LOG_DIR/provider-model-requests.jsonl"
assert_not_contains "provider-model-requests.jsonl" "provider.requested" "T-10-no-provider-requests"
assert_not_contains "provider-model-requests.jsonl" "model.requested" "T-10-no-model-requests"
finish_e2e
