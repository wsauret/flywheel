/**
 * Spawn argument validation and command resolution.
 */

const SHELL_METACHAR_REGEX = /[;&|`$(){}!<>]/;

/**
 * Validate that the spawn command contains no shell metacharacters.
 *
 * Only the command name is validated — argument content (e.g., prompts)
 * can legitimately contain characters like `<`, `>`, `()`, etc.
 * Since `Bun.spawn()` uses `execve` directly (no shell), arguments are
 * passed safely regardless of content.
 */
export function validateSpawnArgs(command: string, _args: readonly string[]): void {
  if (SHELL_METACHAR_REGEX.test(command)) {
    throw new Error(`Shell metacharacter detected in command: ${command}`);
  }
}

/**
 * Resolve a command name to its full executable path using Bun.which().
 */
export function resolveCommandExecutable(command: string): string {
  if (command.includes("/") || command.includes("\\")) {
    return command;
  }

  try {
    const resolved = Bun.which(command);
    if (resolved) return resolved;
  } catch {
    // Bun.which() can throw — fall through to fallbacks
  }

  if (command === "bun" && typeof process.execPath === "string" && process.execPath.length > 0) {
    return process.execPath;
  }

  return command;
}
