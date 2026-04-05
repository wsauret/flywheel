/**
 * Type-safe CLI argument parsing.
 *
 * `flywheel` (no args or any args) -> persistent TUI shell.
 * All workflow creation happens inside the TUI.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ParsedArgs = { command: "tui" };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse CLI arguments. Always returns `{ command: "tui" }`.
 *
 * @param _argv - Ignored (kept for API compatibility with tests)
 * @returns `{ command: "tui" }`
 */
export async function parseArgs(
  _argv?: string[],
): Promise<ParsedArgs | null> {
  return { command: "tui" };
}
