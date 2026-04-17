import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export interface ToolDisplayMeta {
  displayName: string;
  getDetail?: (input: unknown, cwd: string) => string | null;
}

// ── Helpers ───────────────────────────────────────────────────────

function formatDisplayPath(filePath: string | undefined | null, cwd: string): string | null {
  if (!filePath) return null;

  let relative: string;
  if (path.isAbsolute(filePath)) {
    relative = path.relative(cwd, filePath);
    if (relative.length === 0) return ".";
  } else {
    relative = filePath;
  }

  const sessionHandoffMatch = relative.match(/\.flywheel\/sessions\/[^/]+\/handoffs\/(.+)$/);
  if (sessionHandoffMatch) {
    return `[handoff] ${sessionHandoffMatch[1]}`;
  }

  if (relative.startsWith("./")) {
    return relative.slice(2);
  }
  return relative;
}

export function singleLine(s: string | undefined | null): string | null {
  if (!s) return null;
  return s.replace(/\n/g, " ").trim();
}

function shellDetail(input: Record<string, unknown>, cwd: string): string | null {
  const cmd = input.command as string | undefined;
  if (!cmd) return null;
  const shortened = cwd ? cmd.replaceAll(cwd + "/", "").replaceAll(cwd, ".") : cmd;
  return singleLine(shortened);
}

function agentDetail(input: Record<string, unknown>, _cwd: string): string | null {
  const desc = (input.description as string | undefined) ?? (input.prompt as string | undefined);
  const agentType = input.subagent_type as string | undefined;
  return singleLine(agentType ? `[${agentType}] ${desc ?? ""}` : desc);
}

// ── Detail handler adapters ───────────────────────────────────────

function wrapDetail(
  fn: (input: Record<string, unknown>, cwd: string) => string | null,
): (input: unknown, cwd: string) => string | null {
  return (input, cwd) =>
    fn((input != null && typeof input === "object" ? input : {}) as Record<string, unknown>, cwd);
}

// ── Registry ──────────────────────────────────────────────────────

const entries: Array<[string, ToolDisplayMeta]> = [
  // Tools with both display name and detail handler
  ["read", {
    displayName: "Read",
    getDetail: wrapDetail((input, cwd) => {
      const fp = formatDisplayPath(input.file_path as string, cwd);
      const offset = input.offset as number | undefined;
      const limit = input.limit as number | undefined;
      if (offset != null || limit != null) {
        const start = (offset ?? 0) + 1;
        const end = limit != null ? start + limit - 1 : undefined;
        const range = end != null ? `:${start}-${end}` : `:${start}+`;
        return singleLine(`${fp}${range}`);
      }
      return singleLine(fp);
    }),
  }],
  ["write", {
    displayName: "Write",
    getDetail: wrapDetail((input, cwd) => singleLine(formatDisplayPath(input.file_path as string, cwd))),
  }],
  ["edit", {
    displayName: "Edit",
    getDetail: wrapDetail((input, cwd) => {
      const fp = input.file_path as string | undefined;
      return fp ? singleLine(formatDisplayPath(fp, cwd)) : null;
    }),
  }],
  ["bash", {
    displayName: "Bash",
    getDetail: wrapDetail(shellDetail),
  }],
  ["powershell", {
    displayName: "PowerShell",
    getDetail: wrapDetail(shellDetail),
  }],
  ["repl", {
    displayName: "REPL",
    getDetail: wrapDetail(shellDetail),
  }],
  ["glob", {
    displayName: "File Search",
    getDetail: wrapDetail((input, cwd) => {
      const pat = input.pattern as string | undefined;
      const dir = input.path as string | undefined;
      const displayDir = dir ? formatDisplayPath(dir, cwd) : null;
      const quoted = pat ? `"${pat}"` : null;
      return singleLine(displayDir ? `${quoted} in ${displayDir}` : quoted);
    }),
  }],
  ["grep", {
    displayName: "Text Search",
    getDetail: wrapDetail((input, cwd) => {
      const pat = input.pattern as string | undefined;
      const dir = input.path as string | undefined;
      const fileFilter = (input.glob as string | undefined) ?? (input.type as string | undefined);
      const displayDir = dir ? formatDisplayPath(dir, cwd) : null;
      const quoted = pat ? `"${pat}"` : null;
      const parts = [quoted, displayDir && `in ${displayDir}`, fileFilter && `[${fileFilter}]`].filter(Boolean).join(" ");
      return singleLine(parts || null);
    }),
  }],
  ["agent", {
    displayName: "Subagent",
    getDetail: wrapDetail(agentDetail),
  }],
  ["task", {
    displayName: "Subagent",
    getDetail: wrapDetail(agentDetail),
  }],
  ["websearch", {
    displayName: "Web Search",
    getDetail: wrapDetail((input) => singleLine((input.query as string | undefined) ?? (input.search_query as string | undefined))),
  }],
  ["webfetch", {
    displayName: "Web Fetch",
    getDetail: wrapDetail((input) => singleLine(input.url as string)),
  }],
  ["lsp", {
    displayName: "LSP",
    getDetail: wrapDetail((input, cwd) => {
      const method = input.method as string | undefined;
      const fp = input.file_path as string | undefined;
      return singleLine(method ? `${method}${fp ? ` ${formatDisplayPath(fp, cwd)}` : ""}` : (fp ? formatDisplayPath(fp, cwd) : null));
    }),
  }],
  ["notebookedit", {
    displayName: "Notebook Edit",
    getDetail: wrapDetail((input, cwd) => {
      const fp = (input.notebook_path as string | undefined) ?? (input.file_path as string | undefined);
      return fp ? singleLine(formatDisplayPath(fp, cwd)) : null;
    }),
  }],
  ["skill", {
    displayName: "Skill",
    getDetail: wrapDetail((input) => {
      const skill = (input.skill as string | undefined) ?? (input.name as string | undefined);
      return skill ? singleLine(skill) : null;
    }),
  }],
  ["sendmessage", {
    displayName: "Send Message",
    getDetail: wrapDetail((input) => {
      const to = input.to as string | undefined;
      return to ? singleLine(`to ${to}`) : null;
    }),
  }],
  ["askuserquestion", {
    displayName: "Ask User",
    getDetail: wrapDetail((input) => {
      const q = input.question as string | undefined;
      return q ? singleLine(q) : null;
    }),
  }],
  ["toolsearch", {
    displayName: "Tool Search",
    getDetail: wrapDetail((input) => {
      const query = input.query as string | undefined;
      return query ? singleLine(query) : null;
    }),
  }],
  ["todowrite", { displayName: "Task Update" }],
  ["enterplanmode", { displayName: "Enter Plan Mode" }],
  ["exitplanmode", { displayName: "Exit Plan Mode" }],
  ["enterworktree", { displayName: "Enter Worktree" }],
  ["exitworktree", { displayName: "Exit Worktree" }],

  // Tools with detail handler only (no display name override — raw name used)
  ["todo_list", {
    displayName: "Todo List",
    getDetail: wrapDetail((input) => {
      const op = input.operation as string | undefined;
      if (op === "read") return "read";
      if (op === "write") {
        const todos = input.todos as Array<{ content?: string }> | undefined;
        return todos ? singleLine(`write (${todos.length} items)`) : "write";
      }
      return op ?? null;
    }),
  }],
  ["write_handoff", {
    displayName: "Write Handoff",
    getDetail: wrapDetail((input) => {
      const summary = input.summary as string | undefined;
      return summary ? singleLine(summary) : null;
    }),
  }],

  // Tools with display name only (no detail handler)
  ["remotetrigger", { displayName: "Remote Trigger" }],
];

const toolDisplayRegistry: ReadonlyMap<string, ToolDisplayMeta> = new Map(entries);

// ── Public API ────────────────────────────────────────────────────

export function getToolDisplay(name: string): ToolDisplayMeta | undefined {
  return toolDisplayRegistry.get(name.toLowerCase());
}

export function getToolDisplayName(name: string): string {
  const lower = name.toLowerCase();
  const meta = toolDisplayRegistry.get(lower);
  if (meta) return meta.displayName;
  if (lower.startsWith("schedulecron") || lower.startsWith("cron")) return "Cron";
  if (name.startsWith("mcp__")) return `MCP ${name.slice(5).split("__")[0]}`;
  return name;
}
