#!/bin/bash
# Detects "subtask" mentions and reminds Claude to use the skill
# KEEP IN SYNC with OpenCode version: flywheel/plugins/flywheel-hooks.ts

command -v jq &>/dev/null || exit 0

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

if echo "$PROMPT" | grep -qi "subtask"; then
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "If not already loaded, invoke Skill tool with skill: \"subtask\" to load workflow instructions."
  }
}
EOF
fi

exit 0
