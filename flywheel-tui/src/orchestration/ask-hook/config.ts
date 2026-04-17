import { fileURLToPath } from "node:url";

/** Dev fallback: absolute path to the standalone hook entry script. */
const HOOK_SCRIPT_PATH = fileURLToPath(new URL("./hook.ts", import.meta.url));

/**
 * Resolve the command Claude's PreToolUse hook will execute. Prefers the
 * `flywheel ask-hook` subcommand via FLYWHEEL_CLI (set by bin/flywheel) so
 * the hook works across npm installs, compiled binaries, and dev — anywhere
 * the wrapper exports its own path. Falls back to `bun <hook-script>` for
 * contexts where FLYWHEEL_CLI isn't set (e.g. direct `bun src/cli/index.ts`).
 */
function resolveHookCommand(): string {
  const cli = process.env.FLYWHEEL_CLI;
  if (cli?.trim()) return `${cli} ask-hook`;
  return `bun ${HOOK_SCRIPT_PATH}`;
}

/**
 * Build the `--settings` JSON string that registers our PreToolUse hook for
 * `AskUserQuestion` only. PreToolUse runs before Claude's permission machinery —
 * we short-circuit with `permissionDecision: "allow"` and `updatedInput.answers`,
 * which makes Claude skip the AskUserQuestion-requires-user-interaction path
 * that would otherwise auto-deny under `--dangerously-skip-permissions`.
 *
 * Other tools are unaffected — the matcher restricts us to AskUserQuestion.
 */
export function buildAskHookSettings(): string {
  return JSON.stringify({
    hooks: {
      PreToolUse: [
        {
          matcher: "AskUserQuestion",
          hooks: [{ type: "command", command: resolveHookCommand() }],
        },
      ],
    },
  });
}
