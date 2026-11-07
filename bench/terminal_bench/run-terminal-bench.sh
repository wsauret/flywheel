#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

array_field() {
  local plan="$1" field="$2"
  python3 - "$plan" "$field" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]]
if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
    raise SystemExit(f"plan field {sys.argv[2]} is not a string array")
for item in value:
    sys.stdout.buffer.write(item.encode() + b"\0")
PY
}

scalar_field() {
  python3 - "$1" "$2" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))[sys.argv[2]]
if isinstance(value, (dict, list)):
    raise SystemExit(f"plan field {sys.argv[2]} is not scalar")
print(str(value).lower() if isinstance(value, bool) else value)
PY
}

PLAN=$(bun run "$SCRIPT_DIR/run-terminal-bench.ts" prepare "$@")
PROMPT_PAYLOAD_DIRECTORY="$(dirname "$PLAN").system-prompt"
cleanup_prompt_payload() {
  rm -rf -- "$PROMPT_PAYLOAD_DIRECTORY"
}
trap cleanup_prompt_payload EXIT
DRY_RUN=$(scalar_field "$PLAN" dry_run)
GRADE=$(scalar_field "$PLAN" grade)
WARNING=$(scalar_field "$PLAN" warning)
AUTH_PROFILE=$(scalar_field "$PLAN" auth_profile)
SYSTEM_PROMPT_MODE=$(python3 - "$PLAN" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))["system_prompt"]
print(value["mode"])
PY
)
SYSTEM_PROMPT_PAYLOAD=$(python3 - "$PLAN" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8")).get("system_prompt_payload", ""))
PY
)
SYSTEM_PROMPT_SHA=$(python3 - "$PLAN" <<'PY'
import json
import sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["system_prompt"].get("sha256", ""))
PY
)
DISABLED_TOOLS_JSON=$(python3 - "$PLAN" <<'PY'
import json
import sys
value = json.load(open(sys.argv[1], encoding="utf-8"))["disabled_tools"]
if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
    raise SystemExit("plan field disabled_tools is not a string array")
print(json.dumps(value, separators=(",", ":")))
PY
)
DISABLED_TOOLS=()
while IFS= read -r -d '' item; do DISABLED_TOOLS+=("$item"); done < <(array_field "$PLAN" disabled_tools)
echo "Campaign grade: $GRADE"
echo "Campaign warning: ${WARNING:-none}"
echo "Auth profile: $AUTH_PROFILE"
echo "Disabled tools: ${DISABLED_TOOLS[*]:-none}"
echo "System prompt: $SYSTEM_PROMPT_MODE"
if [ "$(scalar_field "$PLAN" execution_mode)" = hosted ]; then
  echo "Packaged Flywheel commit: $(scalar_field "$PLAN" source_commit)"
  python3 - "$PLAN" <<'PY'
import json
import sys
package = json.load(open(sys.argv[1], encoding="utf-8"))["agent_package"]
print(f"Agent package: {package['repository']} {package['ref']} at {package['commit']}")
PY
  echo "Preparation plan: $PLAN"
  set +e
  bun run "$SCRIPT_DIR/run-terminal-bench.ts" run-hosted "$PLAN"
  HOSTED_EXIT=$?
  set -e
  exit "$HOSTED_EXIT"
fi
if [ "$DRY_RUN" = true ]; then
  echo "Preparation plan: $PLAN"
  exit 0
fi

DOWNLOAD_COMMAND=()
while IFS= read -r -d '' item; do DOWNLOAD_COMMAND+=("$item"); done < <(array_field "$PLAN" download_command)
"${DOWNLOAD_COMMAND[@]}"

PREBUILD=$(scalar_field "$PLAN" prebuild)
if [ "$PREBUILD" = true ]; then
  CONCURRENCY=$(scalar_field "$PLAN" concurrency)
  TASK_NAMES=()
  while IFS= read -r -d '' item; do TASK_NAMES+=("$item"); done < <(array_field "$PLAN" task_names)
  pids=()
  for task_ref in "${TASK_NAMES[@]}"; do
    task_name="${task_ref##*/}"
    environment=$(find "$HOME/.cache/harbor/tasks/packages/terminal-bench/$task_name" -maxdepth 4 -name Dockerfile -print -quit)
    if [ -z "$environment" ]; then
      echo "Missing Dockerfile for $task_ref" >&2
      exit 1
    fi
    environment="$(dirname "$environment")"
    (cd "$environment" && docker build -t "terminal-bench-$task_name:latest" .) &
    pids+=("$!")
    if [ "${#pids[@]}" -ge "$CONCURRENCY" ]; then
      for pid in "${pids[@]}"; do wait "$pid"; done
      pids=()
    fi
  done
  for pid in "${pids[@]}"; do wait "$pid"; done
fi

WHEELHOUSE_COMMAND=()
while IFS= read -r -d '' item; do WHEELHOUSE_COMMAND+=("$item"); done < <(array_field "$PLAN" wheelhouse_command)
WHEELHOUSE=$("${WHEELHOUSE_COMMAND[@]}")
bun run "$SCRIPT_DIR/run-terminal-bench.ts" add-wheelhouse "$PLAN" "$WHEELHOUSE"

HARBOR_COMMAND=()
while IFS= read -r -d '' item; do HARBOR_COMMAND+=("$item"); done < <(array_field "$PLAN" harbor_command)
HARBOR_ENV=(
  "PATH=$PATH"
  "HOME=$HOME"
  "PYTHONPATH=$REPO_ROOT"
  "FLYWHEEL_TERMINAL_BENCH_AUTH_PROFILE=$AUTH_PROFILE"
  "FLYWHEEL_TERMINAL_BENCH_DISABLED_TOOLS=$DISABLED_TOOLS_JSON"
)
if [ "$SYSTEM_PROMPT_MODE" = override ]; then
  HARBOR_ENV+=("FLYWHEEL_TERMINAL_BENCH_SYSTEM_PROMPT_PATH=$SYSTEM_PROMPT_PAYLOAD" "FLYWHEEL_TERMINAL_BENCH_SYSTEM_PROMPT_SHA256=$SYSTEM_PROMPT_SHA")
fi
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_CERT_PATH DOCKER_TLS_VERIFY XDG_CACHE_HOME PIP_CACHE_DIR UV_CACHE_DIR SSL_CERT_FILE SSL_CERT_DIR REQUESTS_CA_BUNDLE CURL_CA_BUNDLE TMPDIR TMP TEMP; do
  if [ -n "${!name-}" ]; then HARBOR_ENV+=("$name=${!name}"); fi
done
set +e
env -i "${HARBOR_ENV[@]}" "${HARBOR_COMMAND[@]}"
HARBOR_EXIT=$?
set -e

MANIFEST=$(scalar_field "$PLAN" manifest)
TRIALS_DIRECTORY=$(scalar_field "$PLAN" trials_directory)
set +e
bun run "$SCRIPT_DIR/run-terminal-bench.ts" finalize "$MANIFEST" "$TRIALS_DIRECTORY" "$HARBOR_EXIT"
FINAL_EXIT=$?
set -e
exit "$FINAL_EXIT"