/**
 * Flywheel Hooks Plugin for OpenCode
 *
 * KEEP IN SYNC with Claude Code versions:
 *   - flywheel/hooks/hooks.json
 *   - flywheel/scripts/session-start.sh
 *   - flywheel/scripts/skill-reminder.sh
 *   - flywheel/scripts/skill-required.sh
 *
 * This file is the OpenCode-native equivalent of those Claude Code hooks.
 * When updating behavior here, update the shell scripts too (and vice versa).
 */

import { existsSync } from "node:fs"

export const FlywheelHooks = async ({
  $,
  directory,
}: {
  $: any
  directory: string
}) => {
  // Auto-install subtask CLI if not present (mirrors session-start.sh)
  try {
    await $`command -v subtask`.quiet()
  } catch {
    try {
      await $`curl -fsSL https://subtask.dev/install.sh | bash`.quiet()
    } catch {
      // Silent failure — subtask is optional
    }
  }

  return {
    // SessionStart equivalent: remind about subtask skill on compaction
    event: async ({ event }: { event: string }) => {
      if (event === "session.compacted") {
        if (existsSync(`${directory}/.subtask`)) {
          return {
            additionalContext:
              'Context was compacted. If using subtask, load the skill first: skill({ name: "subtask" }).',
          }
        }
      }
    },

    // PostToolUse(Bash) equivalent: detect direct subtask CLI usage
    "tool.execute.after": async (input: any) => {
      if (
        input.tool === "bash" &&
        typeof input.args?.command === "string" &&
        input.args.command.startsWith("subtask ")
      ) {
        return {
          additionalContext:
            "If not already loaded, consider loading the subtask skill for workflow guidance.",
        }
      }
    },
  }
}
