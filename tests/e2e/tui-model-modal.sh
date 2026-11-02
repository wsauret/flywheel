#!/usr/bin/env bash
# Module: Model Modal - role assignment, effort selection, reset defaults
source "$(dirname "$0")/lib/e2e-framework.sh"
init_e2e "model-modal" "$@"

cat > "$UAT_DIR/.flywheel/flywheel.toml" <<'TOML'
[profiles.model-modal-fixture.roles.chat]
model = "gpt-5.5"
effort = "medium"

[profiles.model-modal-fixture.roles.workflow-agent]
model = "gpt-5.5"
effort = "medium"

[profiles.model-modal-fixture.roles."brief.plan"]
model = "gpt-4.1"
effort = "high"

[custom_providers.fixture]
base_url = "http://127.0.0.1:9/v1"
models = ["gpt-5.5", "gpt-5.4", "gpt-5-mini", "gpt-5-nano", "gpt-5.3-chat-latest", "gpt-4.1", "gpt-4o"]
catalog_id = "openai"
TOML

OPENAI_API_KEY_VALUE="sk-flywheel-e2e-placeholder"
E2E_HOME="$UAT_DIR"
MODELS_CACHE_DIR="$E2E_HOME/.flywheel/models"
AUTH_PROFILE="model-modal-fixture"
AUTH_PROFILE_DIR="$E2E_HOME/.flywheel/auth/profiles/$AUTH_PROFILE"
mkdir -p "$MODELS_CACHE_DIR" "$AUTH_PROFILE_DIR"
cat > "$AUTH_PROFILE_DIR/profile.json" <<JSON
{"id":"$AUTH_PROFILE","displayName":"Model Modal Fixture"}
JSON
cat > "$AUTH_PROFILE_DIR/auth.json" <<JSON
{"fixture":{"type":"api_key","key":"fixture-placeholder-key","lineageId":"10000000-0000-4000-8000-000000000001"}}
JSON
chmod 600 "$AUTH_PROFILE_DIR/profile.json" "$AUTH_PROFILE_DIR/auth.json"
OPENAI_AUTH_HASH=$(printf 'openai_api:%s' "$OPENAI_API_KEY_VALUE" | shasum -a 256 | awk '{print substr($1, 1, 16)}')

cat > "$MODELS_CACHE_DIR/available-openai_api-$OPENAI_AUTH_HASH.json" <<JSON
{"models":["gpt-5.5","gpt-5.4","gpt-5-mini","gpt-5-nano","gpt-5.3-chat-latest","gpt-4.1","gpt-4o"],"fetchedAt":$(date +%s000),"authHash":"$OPENAI_AUTH_HASH"}
JSON

cat > "$MODELS_CACHE_DIR/models.json" <<'JSON'
{
  "openai": {
    "name": "OpenAI",
    "models": {
      "gpt-5.5": {
        "id": "gpt-5.5",
        "name": "gpt-5.5",
        "family": "gpt",
        "release_date": "2026-04-01",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 8192 },
        "cost": { "input": 5, "cache_read": 0.5, "output": 30 },
        "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }]
      },
      "gpt-5.4": {
        "id": "gpt-5.4",
        "name": "gpt-5.4",
        "family": "gpt",
        "release_date": "2026-03-01",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 8192 },
        "cost": { "input": 2.5, "cache_read": 0.25, "output": 15 },
        "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }]
      },
      "gpt-5-mini": {
        "id": "gpt-5-mini",
        "name": "gpt-5-mini",
        "family": "gpt-mini",
        "release_date": "2026-01-01",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 8192 },
        "cost": { "input": 0.25, "cache_read": 0.025, "output": 2 },
        "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }]
      },
      "gpt-5-nano": {
        "id": "gpt-5-nano",
        "name": "gpt-5-nano",
        "family": "gpt-nano",
        "release_date": "2026-01-01",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 8192 },
        "cost": { "input": 0.05, "cache_read": 0.005, "output": 0.4 },
        "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }]
      },
      "gpt-5.3-chat-latest": {
        "id": "gpt-5.3-chat-latest",
        "name": "gpt-5.3-chat-latest",
        "family": "gpt",
        "release_date": "2026-02-01",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 8192 },
        "cost": { "input": 2.5, "cache_read": 0.25, "output": 15 },
        "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }]
      },
      "gpt-4.1": {
        "id": "gpt-4.1",
        "name": "gpt-4.1",
        "family": "gpt",
        "release_date": "2026-01-01",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 8192 },
        "cost": { "input": 2, "cache_read": 0.2, "output": 8 },
        "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }]
      },
      "gpt-4o": {
        "id": "gpt-4o",
        "name": "gpt-4o",
        "family": "gpt",
        "release_date": "2026-01-01",
        "tool_call": true,
        "modalities": { "input": ["text"], "output": ["text"] },
        "limit": { "context": 200000, "output": 8192 },
        "cost": { "input": 2.5, "cache_read": 1.25, "output": 10 },
        "reasoning_options": [{ "type": "effort", "values": ["low", "medium", "high"] }]
      }
    }
  }
}
JSON

assert_section_field() {
  local section="$1" field="$2" value="$3" label="$4"
  if awk -v section="[$section]" -v field="$field" -v value="$value" '
    $0 == section { in_section = 1; next }
    /^\[/ { in_section = 0 }
    in_section && $0 == field " = \"" value "\"" { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$UAT_DIR/.flywheel/flywheel.toml"; then
    echo "PASS  $label - $section.$field is $value" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  $label - $section.$field is not $value" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

assert_section_field_absent() {
  local section="$1" field="$2" label="$3"
  if awk -v section="[$section]" -v field="$field" '
    $0 == section { in_section = 1; next }
    /^\[/ { in_section = 0 }
    in_section && $0 ~ "^" field " = " { found = 1 }
    END { exit found ? 1 : 0 }
  ' "$UAT_DIR/.flywheel/flywheel.toml"; then
    echo "PASS  $label - $section.$field absent" >> "$SUMMARY"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "FAIL  $label - $section.$field still present" >> "$SUMMARY"
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi
}

open_models_modal() {
  for key in / m o d e l; do
    send_keys "$key"
    sleep 0.05
  done
  send_keys Enter
}

start_app \
  "HOME=$E2E_HOME" \
  "OPENAI_API_KEY=" \
  "ANTHROPIC_API_KEY=" \
  "GEMINI_API_KEY=" \
  "GOOGLE_API_KEY=" \
  "FLYWHEEL_CHAT_MODEL=gpt-5.5" \
  "FLYWHEEL_CHAT_EFFORT=medium" \
  "FLYWHEEL_WORKER_MODEL=gpt-5.5" \
  "FLYWHEEL_WORKER_EFFORT=medium" \
  "FLYWHEEL_OPENAI_AUTH=api_key" \
  "FLYWHEEL_AUTH_PROFILE=$AUTH_PROFILE"
sleep 2

echo "T-01: /model opens role assignments"
send_text "/model"
wait_and_capture 1 "T-01a-session-scope.log"
send_keys "g"
wait_and_capture 2 "T-01a-models-open.log"
assert_contains "T-01a-models-open.log" "New Session Defaults" "T-01a-title" || true
assert_contains "T-01a-models-open.log" "New sessions and this tab; other tabs keep their models." "T-01a-defaults-context" || true
assert_contains "T-01a-models-open.log" "Chat" "T-01a-chat" || true
assert_contains "T-01a-models-open.log" "Agents" "T-01a-agents" || true
assert_contains "T-01a-models-open.log" "Reviewer" "T-01a-reviewer" || true
assert_not_contains "T-01a-models-open.log" "Workflows" "T-01a-no-workflows-group" || true
assert_not_contains "T-01a-models-open.log" "Subagents" "T-01a-no-subagents-group" || true
assert_contains "T-01a-models-open.log" "ctrl+r reset defaults" "T-01a-reset-help" || true
send_keys Escape
sleep 0.5

echo "T-02: Steps effort edit persists"
send_text "/models"
wait_and_capture 1 "T-02-open-session-scope.log"
send_keys "g"
wait_and_capture 2 "T-02-open.log"
nav_down 1
sleep 0.2
send_keys Enter
wait_and_capture 2 "T-02a-worker-model.log"
assert_contains "T-02a-worker-model.log" "New Session Defaults / Workflow / Model" "T-02a-model-view" || true
assert_not_contains "T-02a-worker-model.log" "Choose the model for this assignment" "T-02a-no-generic-helper" || true
assert_contains "T-02a-worker-model.log" "Powerful" "T-02a-tier-heading" || true
assert_not_contains "T-02a-worker-model.log" "Powerful newest first" "T-02a-no-redundant-tier-sort-copy" || true
assert_contains "T-02a-worker-model.log" "enter confirm" "T-02a-footer-confirm" || true
assert_contains "T-02a-worker-model.log" "gpt-5.5" "T-02a-current-model" || true
assert_not_contains "T-02a-worker-model.log" "no provider connected" "T-02a-configured-provider-not-disconnected" || true
assert_contains "T-02a-worker-model.log" "gpt-5.4" "T-02a-gpt5-option" || true
assert_not_contains "T-02a-worker-model.log" "high cost" "T-02a-no-high-cost-prefix" || true
assert_not_contains "T-02a-worker-model.log" "chat-latest" "T-02a-no-chat-latest" || true
assert_not_contains "T-02a-worker-model.log" "o3" "T-02a-no-legacy-o-series" || true
assert_not_contains "T-02a-worker-model.log" "gpt-4" "T-02a-no-legacy-gpt4" || true
assert_contains_regex "T-02a-worker-model.log" "gpt-5\.5 +■+ +Medium +current" "T-02a-inline-effort-meter" || true
assert_contains "T-02a-worker-model.log" "●" "T-02a-price-marker" || true
assert_contains "T-02a-worker-model.log" "Input" "T-02a-price-input-heading" || true
assert_contains "T-02a-worker-model.log" "Cached input" "T-02a-price-cached-heading" || true
assert_contains "T-02a-worker-model.log" "Output" "T-02a-price-output-heading" || true
assert_contains "T-02a-worker-model.log" '$5 / 1M' "T-02a-input-price" || true
assert_contains "T-02a-worker-model.log" '$0.50 / 1M' "T-02a-cached-price" || true
assert_contains "T-02a-worker-model.log" '$30 / 1M' "T-02a-output-price" || true
assert_contains "T-02a-worker-model.log" "↑↓ select · ←→ effort · enter confirm" "T-02a-inline-footer" || true
assert_not_contains "T-02a-worker-model.log" "Sidekick" "T-02a-no-sidekick" || true
assert_not_contains "T-02a-worker-model.log" "Fast Mode" "T-02a-no-fast-mode" || true
assert_not_contains "T-02a-worker-model.log" "more below" "T-02a-no-more-below" || true
assert_not_contains "T-02a-worker-model.log" "New Session Defaults / Steps / Effort" "T-02a-no-effort-screen" || true

send_keys Left
wait_and_capture 1 "T-02b-worker-effort-inline.log"
assert_contains_regex "T-02b-worker-effort-inline.log" "gpt-5\.5 +■+ +Low +current" "T-02b-low-inline" || true
assert_contains "T-02b-worker-effort-inline.log" "New Session Defaults / Workflow / Model" "T-02b-remains-model-view" || true
send_keys Enter
wait_and_capture 2 "T-02c-worker-saved.log"
assert_contains "T-02c-worker-saved.log" "Workflow" "T-02c-back-to-assignments" || true
assert_section_field "profiles.$AUTH_PROFILE.roles.workflow-agent" "model" "gpt-5.5" "T-02c-worker-model-persisted" || true
assert_section_field "profiles.$AUTH_PROFILE.roles.workflow-agent" "effort" "low" "T-02c-worker-effort-persisted" || true
assert_section_field "profiles.$AUTH_PROFILE.roles.chat" "effort" "medium" "T-02c-chat-effort-unchanged" || true

send_keys Enter
wait_and_capture 2 "T-02d-worker-reopened.log"
assert_contains "T-02d-worker-reopened.log" "gpt-5.5" "T-02d-role-model-reopened" || true
assert_contains_regex "T-02d-worker-reopened.log" "gpt-5\.5 +■+ +Low +current" "T-02d-role-effort-reopened" || true
send_keys Backspace
wait_and_capture 1 "T-02e-worker-back.log"
assert_contains "T-02e-worker-back.log" "New Session Defaults" "T-02e-back-to-assignments" || true

echo "T-03: Ctrl+R reset restores role defaults and clears step overrides"
send_keys C-r
wait_and_capture 1 "T-03a-reset-confirm.log"
assert_contains "T-03a-reset-confirm.log" "Ctrl+R again reset" "T-03a-reset-confirm" || true

send_keys C-r
wait_and_capture 3 "T-03b-reset-done.log"
assert_contains "T-03b-reset-done.log" "Workflow" "T-03b-back-to-assignments" || true
assert_section_field_absent "profiles.$AUTH_PROFILE.roles.workflow-agent" "model" "T-03b-worker-model-reset" || true
assert_section_field_absent "profiles.$AUTH_PROFILE.roles.workflow-agent" "effort" "T-03b-worker-effort-reset" || true
assert_section_field_absent "profiles.$AUTH_PROFILE.roles.\"brief.plan\"" "model" "T-03b-step-model-cleared" || true
assert_section_field_absent "profiles.$AUTH_PROFILE.roles.\"brief.plan\"" "effort" "T-03b-step-effort-cleared" || true

send_keys Escape
sleep 1
sleep 2
echo "T-04: Model modal scope chrome"
open_models_modal
wait_and_capture 2 "T-04a-scope-session.log"
assert_contains "T-04a-scope-session.log" "This Tab" "T-04a-session-title-root" || true
assert_contains "T-04a-scope-session.log" "Changes apply to this tab only." "T-04a-session-context" || true
assert_contains "T-04a-scope-session.log" "g defaults" "T-04a-session-help" || true
send_keys "g"
wait_and_capture 2 "T-04b-scope-defaults.log"
assert_contains "T-04b-scope-defaults.log" "New Session Defaults" "T-04b-defaults-title-root" || true
assert_contains "T-04b-scope-defaults.log" "New sessions and this tab; other tabs keep their models." "T-04b-defaults-context" || true
assert_contains "T-04b-scope-defaults.log" "g this tab" "T-04b-defaults-help" || true
send_keys "g"
wait_and_capture 2 "T-04c-scope-session-again.log"
assert_contains "T-04c-scope-session-again.log" "This Tab" "T-04c-session-title-root" || true
assert_contains "T-04c-scope-session-again.log" "Changes apply to this tab only." "T-04c-session-context" || true
send_keys Escape
sleep 0.5

echo "T-05: This Tab chat model change does not write TOML or affect another open chat"
send_text "snapshot isolation original"
wait_and_capture "$WAIT_SHORT" "T-05a-original-chat-seeded.log"
assert_contains "T-05a-original-chat-seeded.log" "snapshot isolation original" "T-05a-original-chat-non-empty" || true
send_keys Escape
sleep 1
send_keys C-n
wait_and_capture "$WAIT_MEDIUM" "T-05b-second-chat-created.log"
assert_contains "T-05b-second-chat-created.log" "gpt-5.5 medium" "T-05b-second-chat-default-model" || true
send_text "snapshot isolation second"
wait_and_capture "$WAIT_SHORT" "T-05c-second-chat-seeded.log"
assert_contains "T-05c-second-chat-seeded.log" "snapshot isolation second" "T-05c-second-chat-non-empty" || true
send_keys Escape
sleep 1
send_keys M-1
wait_and_capture "$WAIT_SHORT" "T-05d-original-chat-foregrounded.log"
open_models_modal
wait_and_capture 2 "T-05c-open-session-scope.log"
send_keys Enter
wait_and_capture 2 "T-05d-chat-model-list.log"
assert_contains "T-05d-chat-model-list.log" "This Tab / Chat / Model" "T-05d-chat-model-title" || true
nav_down 1
send_keys Left
wait_and_capture 1 "T-05e-chat-effort-inline.log"
assert_contains "T-05e-chat-effort-inline.log" "gpt-5.4" "T-05e-chat-model-inline" || true
assert_contains_regex "T-05e-chat-effort-inline.log" "gpt-5\.4 +■+ +Low" "T-05e-chat-low-inline" || true
send_keys Enter
wait_and_capture 1 "T-05f-chat-session-saved.log"
assert_contains "T-05f-chat-session-saved.log" "Updated Chat for this tab" "T-05f-session-save-toast" || true
assert_not_contains "T-05f-chat-session-saved.log" "Updated Chat default for new sessions" "T-05f-no-default-save-toast" || true
assert_section_field_absent "profiles.$AUTH_PROFILE.roles.chat" "model" "T-05f-chat-model-default-unchanged" || true

echo "T-06: Footer marks chat model divergence and other open chat stays unchanged"
send_keys Escape
wait_and_capture 2 "T-06a-footer-divergence.log"
assert_contains "T-06a-footer-divergence.log" "gpt-5.4 low*" "T-06a-footer-divergence-marker" || true
send_keys M-2
wait_and_capture "$WAIT_SHORT" "T-06b-second-chat-foregrounded.log"
assert_contains "T-06b-second-chat-foregrounded.log" "gpt-5.5 medium" "T-06b-second-chat-unchanged-by-session-edit" || true
assert_not_contains "T-06b-second-chat-foregrounded.log" "gpt-5.4 low*" "T-06b-second-chat-no-session-leak" || true
echo "T-07: New Session Defaults chat model change writes TOML"
open_models_modal
wait_and_capture 2 "T-07a-open-session-scope.log"
send_keys "g"
wait_and_capture 2 "T-07b-defaults-scope.log"
assert_contains "T-07b-defaults-scope.log" "New Session Defaults" "T-07b-defaults-title-root" || true
send_keys Enter
wait_and_capture 2 "T-07c-default-chat-model-list.log"
assert_contains "T-07c-default-chat-model-list.log" "New Session Defaults / Chat / Model" "T-07c-default-chat-model-title" || true
nav_down 3
send_keys Left
wait_and_capture 1 "T-07d-default-chat-effort-inline.log"
assert_contains "T-07d-default-chat-effort-inline.log" "gpt-5-mini" "T-07d-default-chat-model-inline" || true
assert_contains_regex "T-07d-default-chat-effort-inline.log" "■+ +Low" "T-07d-default-chat-low-inline" || true
send_keys Enter
wait_and_capture 1 "T-07e-default-chat-saved.log"
assert_contains "T-07e-default-chat-saved.log" "Updated Chat default for new sessions" "T-07e-default-save-toast" || true
assert_section_field "profiles.$AUTH_PROFILE.roles.chat" "model" "gpt-5-mini" "T-07e-chat-model-default-persisted" || true
assert_section_field "profiles.$AUTH_PROFILE.roles.chat" "effort" "low" "T-07e-chat-effort-default-persisted" || true
send_keys Escape
wait_and_capture 1 "T-07f-defaults-closed.log"
assert_not_contains "T-07f-defaults-closed.log" "New Session Defaults" "T-07f-defaults-modal-closed" || true
echo "T-07g: Global defaults do not rewrite open chat snapshots"
wait_and_capture 2 "T-07g-second-chat-after-default-change.log"
assert_contains "T-07g-second-chat-after-default-change.log" "gpt-5.5 medium" "T-07g-second-chat-still-original-snapshot" || true
assert_not_contains "T-07g-second-chat-after-default-change.log" "gpt-5-mini low" "T-07g-second-chat-not-global-default" || true
send_keys M-1
wait_and_capture "$WAIT_SHORT" "T-07h-original-chat-after-default-change.log"
assert_contains "T-07h-original-chat-after-default-change.log" "gpt-5.4 low*" "T-07h-original-chat-still-session-snapshot" || true
# Seed a durable turn without hitting a provider; blank chat shells are pruned on restart.
(cd "$PROJECT_DIR" && bun --conditions=browser -e '
  import { createSqliteEventStore } from "./src/infra/sqlite-event-store.js";
  import { resolveEventStoreDbFile } from "./src/infra/paths.js";
  import { createConversationTreeWriterController } from "./src/orchestration/chat/tree-writer.js";
  import { createSessionManager } from "./src/orchestration/session/manager.js";

  const baseDir = process.argv[1];
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir));
  try {
    const manager = createSessionManager({ baseDir, store });
    const session = manager.listMetadata().sessions.find((entry) => entry.kind === "chat" && entry.lifecycleState === "active");
    if (!session?.conversationId) throw new Error("Active chat session not found");
    const writer = createConversationTreeWriterController({
      conversationId: session.conversationId,
      sessionId: session.id,
      projectRoot: baseDir,
      store,
    });
    try {
      await writer.commitUserTurn("snapshot persistence seed");
    } finally {
      await writer.dispose();
    }
  } finally {
    store.close();
  }
' "$E2E_HOME")

echo "T-08: Restart preserves tab model snapshot"
send_keys Escape
sleep 0.5
restart_app \
  "HOME=$E2E_HOME" \
  "OPENAI_API_KEY=" \
  "ANTHROPIC_API_KEY=" \
  "GEMINI_API_KEY=" \
  "GOOGLE_API_KEY=" \
  "FLYWHEEL_CHAT_MODEL=gpt-5.5" \
  "FLYWHEEL_CHAT_EFFORT=medium" \
  "FLYWHEEL_WORKER_MODEL=gpt-5.5" \
  "FLYWHEEL_WORKER_EFFORT=medium" \
  "FLYWHEEL_OPENAI_AUTH=api_key" \
  "FLYWHEEL_AUTH_PROFILE=$AUTH_PROFILE"
wait_and_capture 3 "T-08a-after-restart.log"
send_keys C-s
wait_and_capture 2 "T-08b-sessions-after-restart.log"
send_keys Down Down
wait_and_capture 1 "T-08b-saved-session-selected.log"
send_keys Enter
wait_and_capture "$WAIT_MEDIUM" "T-08c-session-foregrounded.log"
open_models_modal
wait_and_capture 2 "T-08d-open-after-restart.log"
send_keys Enter
wait_and_capture 2 "T-08e-chat-model-after-restart.log"
assert_contains "T-08e-chat-model-after-restart.log" "This Tab / Chat / Model" "T-08e-chat-model-title" || true
assert_contains_regex "T-08e-chat-model-after-restart.log" "gpt-5\.4 +■+ +[A-Za-z-]+ +current" "T-08e-session-model-current-after-restart" || true
assert_not_contains "T-08e-chat-model-after-restart.log" "gpt-5.4 OpenAI" "T-08e-current-model-provider-free-after-restart" || true
assert_not_contains_regex "T-08e-chat-model-after-restart.log" "gpt-5\.5 +■+ +[A-Za-z-]+ +current" "T-08e-boot-model-not-current-after-restart" || true
assert_not_contains_regex "T-08e-chat-model-after-restart.log" "gpt-5-mini +■+ +[A-Za-z-]+ +current" "T-08e-default-model-not-current-after-restart" || true
send_keys Escape
sleep 0.5

stop_app
finish_e2e
