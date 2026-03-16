/**
 * Slash Command Parser
 *
 * Parses user input for slash commands used in both idle and work-active prompt modes.
 * Returns null if the input is not a recognized slash command.
 */

export interface SlashCommand {
  command: string;
  args: string;
}

const KNOWN_COMMANDS = new Set(["exit", "new", "stop", "help"]);

/**
 * Parse a slash command from user input.
 *
 * @param input - Raw text from the prompt
 * @returns Parsed command and args, or null if not a slash command
 */
export function parseSlashCommand(input: string): SlashCommand | null {
  const trimmed = input.trim();

  if (!trimmed.startsWith("/")) {
    return null;
  }

  // Split on first space: "/command args..."
  const spaceIndex = trimmed.indexOf(" ");
  const rawCommand = spaceIndex === -1
    ? trimmed.slice(1)
    : trimmed.slice(1, spaceIndex);
  const args = spaceIndex === -1
    ? ""
    : trimmed.slice(spaceIndex + 1).trim();

  const command = rawCommand.toLowerCase();

  if (!command || !KNOWN_COMMANDS.has(command)) {
    return null;
  }

  return { command, args };
}
