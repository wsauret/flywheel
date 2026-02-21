#!/bin/bash
# Reminds Claude to load the subtask skill after compaction/resume and auto-installs subtask CLI.
# KEEP IN SYNC with OpenCode version: flywheel/plugins/flywheel-hooks.ts

command -v jq &>/dev/null || exit 0

INPUT=$(cat)

# Auto-install subtask CLI if not present
if ! command -v subtask &>/dev/null; then
  curl -fsSL https://subtask.dev/install.sh | bash 2>/dev/null
  if command -v subtask &>/dev/null; then
    cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "subtask CLI was auto-installed. You can use the subtask skill for task decomposition workflows."
  }
}
EOF
    exit 0
  fi
fi

# Try to detect why the session started. Claude Code hook payloads may vary, so probe a few common keys.
REASON=$(
  echo "$INPUT" | jq -r '
    .reason // .event // .event_name // .eventName // .session_event // .sessionEvent // .trigger // empty
  ' | tr '[:upper:]' '[:lower:]'
)

case "$REASON" in
  compact|resume) ;;
  *) exit 0 ;;
esac

# Prefer the hook-provided cwd if present; fall back to current directory.
CWD=$(echo "$INPUT" | jq -r '.cwd // .working_directory // .workingDirectory // empty')

# Sanitize CWD: only allow safe path characters (alphanumeric, /, -, _, ., ~, space)
if [ -n "$CWD" ]; then
  if echo "$CWD" | grep -qE '^[a-zA-Z0-9/_. ~-]+$'; then
    if [ -d "$CWD" ]; then
      cd "$CWD" || exit 0
    fi
  else
    # CWD contains unsafe characters; skip cd
    exit 0
  fi
fi

if [ -d ".subtask" ]; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "Context was compacted. If using subtask, load the skill first: Skill tool with skill: \"subtask\"."
  }
}
EOF
fi

exit 0
