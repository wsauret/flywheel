/**
 * Runtime bash command interception.
 *
 * When the model calls bash with a command that has a dedicated tool equivalent,
 * returns an error suggesting the correct tool. This is more effective than
 * prompt-level guidance alone (Oh-My-Pi pattern).
 *
 * Only intercepts when the suggested tool is actually available in the session.
 */

interface InterceptRule {
  pattern: RegExp;
  tool: string;
  message: string;
}

const RULES: readonly InterceptRule[] = [
  {
    pattern: /^\s*(cat|head|tail|less|more)\s+/,
    tool: "read",
    message: 'Use the `read` tool instead. Example: read(file_path="/path/to/file")',
  },
  {
    pattern: /^\s*(grep|rg|ripgrep|ag|ack)\s+/,
    tool: "text_search",
    message: 'Use the `text_search` tool instead. Example: text_search(pattern="...", path="...")',
  },
  {
    pattern: /^\s*(find|fd|locate)\s+.*(-name|-iname|-type|--type|-glob)/,
    tool: "text_search",
    message: 'Use `text_search` with glob_pattern for file discovery. Example: text_search(pattern=".", glob_pattern="*.ts")',
  },
  {
    pattern: /^\s*sed\s+(-i|--in-place)/,
    tool: "edit",
    message: "Use the `edit` tool instead. Read the file first to get LINE#HASH references, then edit.",
  },
  {
    pattern: /^\s*perl\s+.*-[pn]?i/,
    tool: "edit",
    message: "Use the `edit` tool for in-place edits. Read the file first, then use hashline references.",
  },
  {
    pattern: /^\s*awk\s+.*-i\s+inplace/,
    tool: "edit",
    message: "Use the `edit` tool for in-place edits. Read the file first, then use hashline references.",
  },
  {
    pattern: /^\s*(echo|printf)\s+.*[^|]>\s*\S/,
    tool: "write",
    message: 'Use the `write` tool instead. Example: write(file_path="...", content="...")',
  },
  {
    pattern: /^\s*cat\s*<<['"]?\w*['"]?\s*>\s*\S/,
    tool: "write",
    message: 'Use the `write` tool instead of heredoc redirects. Example: write(file_path="...", content="...")',
  },
];

export function interceptBashCommand(
  command: string,
  availableTools: ReadonlySet<string>,
): string | null {
  for (const rule of RULES) {
    if (rule.pattern.test(command) && availableTools.has(rule.tool)) {
      return `Command intercepted: a dedicated tool exists for this operation. ${rule.message}`;
    }
  }
  return null;
}
