#!/usr/bin/env bash
# Installed-binary acceptance for deterministic subscription spend consent:
# the paid-use question asks in plain words, closes on Escape as "keep off",
# and never traps input.
source "$(dirname "$0")/lib/e2e-framework.sh"
SUPPLIED_BASE="${1:-$PROJECT_DIR/tests/e2e/results/$(date +%Y%m%d-%H%M%S)}"
init_e2e "subscription-spend-consent" "$SUPPLIED_BASE"
INITIAL_UAT_DIR="$UAT_DIR"
rm -r "$INITIAL_UAT_DIR"
ROOT_SANDBOX="$SUPPLIED_BASE/subscription-spend-consent-sandbox-$$"
CONTROL_FILE="$ROOT_SANDBOX/active-scenario.json"
PROXY_CONFDIR="$ROOT_SANDBOX/mitm-conf"
PROXY_LOG="$LOG_DIR/proxy-requests.log"
PROXY_STDERR="$LOG_DIR/proxy-stderr.log"
ADDON="$ROOT_SANDBOX/subscription-consent-proxy.py"
LAUNCHER="$ROOT_SANDBOX/launch-installed.sh"
MITMDUMP=/opt/homebrew/bin/mitmdump
SCENARIO_COUNT=0
PROXY_PID=""
mkdir -p "$ROOT_SANDBOX" "$PROXY_CONFDIR"
: > "$PROXY_LOG"
: > "$PROXY_STDERR"

cleanup() {
  local exit_code=$?
  if tmux has-session -t "$SESSION" 2>/dev/null; then tmux kill-session -t "$SESSION" 2>/dev/null || true; fi
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill -TERM "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
  if [ "$exit_code" -eq 0 ]; then
    rm -rf "$ROOT_SANDBOX" 2>/dev/null || true
  else
    echo "  sandbox preserved for forensics: $ROOT_SANDBOX (exit=$exit_code)"
  fi
}
trap cleanup EXIT

if [ ! -x "$MITMDUMP" ]; then
  echo "FAIL  mitmdump was not found at $MITMDUMP" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  finish_e2e
fi

cat > "$ADDON" <<PY
import json
import os
from pathlib import Path
from mitmproxy import http

CONTROL = Path(os.environ["CONSENT_CONTROL_FILE"])
LOG = Path(os.environ["CONSENT_PROXY_LOG"])
TARGET_HOSTS = {"api.x.ai", "cli-chat-proxy.grok.com"}

def record(kind: str, flow: http.HTTPFlow) -> None:
    with LOG.open("a", encoding="utf-8") as output:
        output.write(json.dumps({"kind": kind, "method": flow.request.method, "url": flow.request.pretty_url}) + "\\n")

def json_response(status: int, payload: object) -> http.Response:
    return http.Response.make(status, json.dumps(payload), {"content-type": "application/json"})

class ConsentFixture:
    def request(self, flow: http.HTTPFlow) -> None:
        url = flow.request.pretty_url
        if url == "https://api.x.ai/v1/models":
            record("intercepted", flow)
            flow.response = json_response(200, {"data": [{"id": "grok-4.5"}]})
            return
        if url == "https://cli-chat-proxy.grok.com/v1/billing?format=credits":
            record("intercepted", flow)
            variant = json.loads(CONTROL.read_text(encoding="utf-8"))["variant"]
            if variant == "detection-failure":
                flow.response = json_response(503, {"error": {"type": "consent_fixture_failure", "message": "deterministic provider read failure"}})
                return
            automatic = variant not in {"prepaid", "unavailable"}
            config = {
                "currentPeriod": {"end": "2099-01-01T00:00:00.000Z"},
                "creditUsagePercent": 45,
                "prepaidBalance": {"val": 0 if variant == "unavailable" else 2500},
            }
            if automatic:
                config.update({"onDemandUsed": {"val": 250}, "onDemandCap": {"val": 5000}})
            flow.response = json_response(200, {"config": config})
            return
        if url == "https://cli-chat-proxy.grok.com/v1/settings":
            record("intercepted", flow)
            variant = json.loads(CONTROL.read_text(encoding="utf-8"))["variant"]
            flow.response = json_response(200, {"on_demand_enabled": variant not in {"prepaid", "unavailable"}})
            return
        if flow.request.host in TARGET_HOSTS or flow.request.host.endswith(".x.ai") or flow.request.host.endswith(".grok.com"):
            record("blocked-outbound", flow)
            flow.response = json_response(502, {"error": "unexpected provider request blocked by consent fixture"})
            return
        record("passed-unrelated", flow)

addons = [ConsentFixture()]
PY

PROXY_PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')"
CONSENT_CONTROL_FILE="$CONTROL_FILE" CONSENT_PROXY_LOG="$PROXY_LOG" "$MITMDUMP" --quiet --listen-host 127.0.0.1 --listen-port "$PROXY_PORT" --set "confdir=$PROXY_CONFDIR" -s "$ADDON" >> "$PROXY_STDERR" 2>&1 &
PROXY_PID=$!
CA_FILE="$PROXY_CONFDIR/mitmproxy-ca-cert.pem"
ready=0
for _ in $(seq 1 50); do
  if [ -s "$CA_FILE" ] && curl --silent --show-error --fail --proxy "http://127.0.0.1:$PROXY_PORT" --cacert "$CA_FILE" https://api.x.ai/v1/models > "$LOG_DIR/proxy-readiness.json" 2>> "$PROXY_STDERR"; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL  mitmdump CA or readiness probe did not become ready" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  finish_e2e
fi
cat > "$LAUNCHER" <<SH
#!/usr/bin/env bash
set -euo pipefail
uat_dir="\${1:?uat directory required}"
stderr_log="\${2:?stderr log required}"
binary="\${3:?binary required}"
cd "\$uat_dir"
# The sandbox's account service binds an ephemeral hub port so this run never collides with the operator's own \`flywheel serve\` on 41000 (src/cli/serve.ts releaseHarnessRuntimeOptions).
HOME="\$uat_dir" FLYWHEEL_PROJECT_ROOT="\$uat_dir" FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS="0" FLYWHEEL_INTERNAL_RELEASE_HARNESS="account-service-isolation-v1" FLYWHEEL_INTERNAL_RELEASE_HUB_PORT="0" HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" https_proxy="http://127.0.0.1:$PROXY_PORT" NODE_EXTRA_CA_CERTS="$CA_FILE" SSL_CERT_FILE="$CA_FILE" exec "\$binary" 2>"\$stderr_log"
SH
chmod +x "$LAUNCHER"

bun run --cwd "$PROJECT_DIR" install:local >> "$SUMMARY" 2>&1
BIN="$(command -v flywheel || true)"
if [ -z "$BIN" ] && [ -x "$HOME/.local/bin/flywheel" ]; then BIN="$HOME/.local/bin/flywheel"; fi
if [ -z "$BIN" ] && [ -x "/usr/local/bin/flywheel" ]; then BIN="/usr/local/bin/flywheel"; fi
if [ -z "$BIN" ]; then
  echo "FAIL  installed flywheel binary was not found" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
  finish_e2e
fi

new_scenario() {
  local name="${1:?scenario name required}"
  if tmux has-session -t "$SESSION" 2>/dev/null; then tmux kill-session -t "$SESSION"; fi
  SCENARIO_COUNT=$((SCENARIO_COUNT + 1))
  UAT_DIR="$ROOT_SANDBOX/$name"
  STDERR_LOG="$LOG_DIR/$name-stderr.log"
  mkdir -p "$UAT_DIR/.flywheel"
  cat > "$UAT_DIR/.flywheel/flywheel.toml" <<'TOML'
[notifications]
desktop = false
TOML
}

seed() {
  HOME="$UAT_DIR" bun run "$PROJECT_DIR/tests/e2e/seed-subscription-spend-consent.ts" "$UAT_DIR/.flywheel" "--scenario-control=$CONTROL_FILE" "$@" >> "$LOG_DIR/seed.log"
}

start_installed_app() {
  tmux new-session -d -s "$SESSION" -x 120 -y 36
  send_keys "'$LAUNCHER' '$UAT_DIR' '$STDERR_LOG' '$BIN'" Enter
  if ! wait_for_chat 15; then
    send_keys C-n
    wait_for_chat 15
  fi
  local ready=0
  for _ in $(seq 1 50); do
    if tmux capture-pane -p -t "$SESSION" | grep -Fq "Send a message"; then ready=1; break; fi
    sleep 0.2
  done
  if [ "$ready" -ne 1 ]; then echo "FAIL  app did not become ready" >> "$SUMMARY"; FAIL_COUNT=$((FAIL_COUNT + 1)); fi
}

capture_geometries() {
  local stem="${1:?capture stem required}"
  resize_terminal 120 36
  capture "$stem-normal.log"
  resize_terminal 58 18
  capture "$stem-narrow.log"
  resize_terminal 120 36
}

wait_for_pane_text() {
  local text="${1:?text required}" ready=0
  for _ in $(seq 1 50); do
    if tmux capture-pane -p -t "$SESSION" | grep -Fq "$text"; then ready=1; break; fi
    sleep 0.2
  done
  [ "$ready" -eq 1 ]
}

expect_pane_text() {
  local text="${1:?text required}" id="${2:?assertion id required}"
  if wait_for_pane_text "$text"; then
    echo "PASS  $id" >> "$SUMMARY"
    return
  fi
  echo "FAIL  $id (pane missing: $text)" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

expect_pane_absent() {
  local text="${1:?text required}" id="${2:?assertion id required}"
  for _ in $(seq 1 50); do
    if ! tmux capture-pane -p -t "$SESSION" | grep -Fq "$text"; then
      echo "PASS  $id" >> "$SUMMARY"
      return
    fi
    sleep 0.2
  done
  echo "FAIL  $id (pane still contains: $text)" >> "$SUMMARY"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

trigger_review() {
  expect_pane_text "Paid Use" "paid-use-question-ready"
}

assert_modal_pair() {
  local stem="$1" text="$2" id="$3"
  assert_contains "$stem-normal.log" "$text" "$id-normal"
  assert_contains "$stem-narrow.log" "$text" "$id-narrow"
}

exit_app() {
  send_keys q
  sleep 1
  tmux kill-session -t "$SESSION" 2>/dev/null || true
}

new_scenario later-automatic-question
seed --single --prepaid-only --consent=accepted
start_installed_app
send_text "/auth"
expect_pane_text "SuperGrok Subscription" "S01-startup-auth-ready"
send_keys Escape
expect_pane_absent "Settings › Auth" "S01-startup-auth-closed"
sleep 1
# The provider now reports automatic billing. A usage refresh brings the evidence in, and the
# question asks itself once the usage sheet is closed and nothing else is on screen.
printf '%s' '{"variant":"automatic"}' > "$CONTROL_FILE"
billing_reads_before="$(grep -c 'billing?format=credits' "$PROXY_LOG" || true)"
send_text "/usage"
expect_pane_text "Usage" "S01-usage-open"
sleep 2
send_keys r
for _ in $(seq 1 150); do
  if [ "$(grep -c 'billing?format=credits' "$PROXY_LOG" || true)" -gt "$billing_reads_before" ]; then break; fi
  sleep 0.2
done
sleep 2
send_keys Escape
expect_pane_text "Paid Use" "S01-question-asks-itself"
capture_geometries "S01-question"
assert_contains "S01-question-normal.log" "Settings › Auth › SuperGrok Subscription › Paid Use" "S01-question-navigation"
# The narrow capture's top rows sit under the notification toast, so the first sentence is asserted at normal width only.
assert_contains "S01-question-normal.log" "is connected as" "S01-question-explains-account"
assert_modal_pair "S01-question" "keep paid use off" "S01-question-explains-closing"
assert_contains "S01-question-normal.log" "Automatic billing  Enabled" "S01-automatic-capability"
assert_contains "S01-question-normal.log" "> [ ] " "S01-focused-unreviewed-capability"
assert_contains "S01-question-normal.log" "esc keep off" "S01-question-footer"
assert_not_contains "S01-question-normal.log" "exit Flywheel" "S01-no-exit-path"
assert_not_contains "S01-question-normal.log" "SuperGrok Subscription · Sibling" "S01-account-isolation"
send_keys Escape
expect_pane_absent "Paid Use" "S01-escape-closes-question"
send_text "/auth"
expect_pane_text "SuperGrok Subscription" "S01-auth-reopens"
expect_pane_absent "Paid Use" "S01-question-answered-once"
exit_app

new_scenario question-per-account
seed --single
seed --append-sibling
start_installed_app
trigger_review
capture_geometries "S02-question"
assert_contains "S02-question-normal.log" "Settings › Auth › SuperGrok Subscription › Paid Use" "S02-question-navigation"
assert_modal_pair "S02-question" "keep paid use off" "S02-question-explains-closing"
assert_modal_pair "S02-question" "Exact" "S02-first-account-target"
assert_contains "S02-question-normal.log" "> [ ] " "S02-first-account-consent"
assert_not_contains "S02-question-normal.log" "SuperGrok Subscription · Sibling" "S02-first-account-isolation"
send_keys Escape
expect_pane_text "Sibling" "S02-next-account-ready"
capture_geometries "S02-question-next"
assert_modal_pair "S02-question-next" "Sibling" "S02-next-account-target"
assert_contains "S02-question-next-normal.log" "> [ ] " "S02-next-account-consent"
assert_not_contains "S02-question-next-normal.log" "SuperGrok Subscription · Exact" "S02-next-account-isolation"
send_keys Escape
expect_pane_absent "Paid Use" "S02-second-escape-closes"
exit_app

new_scenario accepted-unavailable
seed --accepted-unavailable --consent=accepted
start_installed_app
send_text "/auth"
sleep 2
send_keys Down Down Enter
sleep 2
capture_geometries "S03-accepted-unavailable"
assert_modal_pair "S03-accepted-unavailable" "Settings › Auth › SuperGrok" "S03-auth-detail"
assert_contains "S03-accepted-unavailable-normal.log" "Empty · on, currently unavailable" "S03-prepaid-unavailable"
assert_contains "S03-accepted-unavailable-normal.log" "Automatic billing  Disabled" "S03-automatic-unavailable"
assert_contains "S03-accepted-unavailable-normal.log" "[x] Prepaid" "S03-accepted-revoked"
send_keys Escape Escape
send_text "/usage"
sleep 2
capture_geometries "S03-unavailable-usage"
assert_modal_pair "S03-unavailable-usage" "Primary Window" "S03-included-quota-remains"
assert_not_contains "S03-unavailable-usage-normal.log" "Prepaid Credits" "S03-hide-unavailable-prepaid"
assert_not_contains "S03-unavailable-usage-normal.log" "Automatic Billing" "S03-hide-unavailable-automatic"
exit_app

new_scenario settings
seed --single --consent=accepted
start_installed_app
send_text "/settings"
sleep 2
capture_geometries "S04-settings"
assert_modal_pair "S04-settings" "Auth" "S04-auth-management-center"
assert_not_contains "S04-settings-normal.log" "Models & spend" "S04-models-spend-action-removed"
assert_not_contains "S04-settings-normal.log" "Paid capacity" "S04-paid-capacity-action-removed"
exit_app

for scenario_dir in "$ROOT_SANDBOX"/*; do
  [ -d "$scenario_dir/.flywheel" ] || continue
  scenario_name="$(basename "$scenario_dir")"
  HOME="$scenario_dir" FLYWHEEL_PROJECT_ROOT="$scenario_dir" HTTPS_PROXY="http://127.0.0.1:$PROXY_PORT" https_proxy="http://127.0.0.1:$PROXY_PORT" NODE_EXTRA_CA_CERTS="$CA_FILE" SSL_CERT_FILE="$CA_FILE" "$BIN" events search --json > "$LOG_DIR/$scenario_name-events.jsonl"
done
assert_not_contains_regex "seed.log" "model request issued|paid provider call issued|purchase issued|billing toggle issued|budget mutation issued" "S05-safe-seed"
for events in "$LOG_DIR"/*-events.jsonl; do
  assert_not_contains "$(basename "$events")" "model.requested" "S05-no-model-request-$(basename "$events")"
  assert_not_contains_regex "$(basename "$events")" 'purchase|billing[._ -]?toggle|budget[._ -]?mutat|provider.requested' "S05-no-paid-side-effect-$(basename "$events")"
done
assert_not_contains "proxy-requests.log" '"kind": "blocked-outbound"' "S05-no-outbound-provider-request"
assert_contains "proxy-requests.log" 'https://api.x.ai/v1/models' "S05-model-catalog-intercepted"
assert_contains "proxy-requests.log" 'https://cli-chat-proxy.grok.com/v1/billing?format=credits' "S05-billing-intercepted"

echo "SCENARIOS: $SCENARIO_COUNT" >> "$SUMMARY"
echo "ARTIFACTS: $LOG_DIR" >> "$SUMMARY"
UAT_DIR="$ROOT_SANDBOX"
finish_e2e
