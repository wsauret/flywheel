import * as path from "node:path";

// ── Types ─────────────────────────────────────────────────────────

export type ToolCategory = "exploration" | "mutation" | "execution" | "subagent" | "standalone";

export interface ToolDisplayMeta {
  displayName: string;
  category: ToolCategory;
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
  // Exploration tools — read-only information gathering
  ["read", {
    displayName: "Read",
    category: "exploration",
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
  ["glob", {
    displayName: "File Search",
    category: "exploration",
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
    category: "exploration",
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

  // Mutation tools — file modifications
  ["write", {
    displayName: "Write",
    category: "mutation",
    getDetail: wrapDetail((input, cwd) => singleLine(formatDisplayPath(input.file_path as string, cwd))),
  }],
  ["edit", {
    displayName: "Edit",
    category: "mutation",
    getDetail: wrapDetail((input, cwd) => {
      const fp = input.file_path as string | undefined;
      return fp ? singleLine(formatDisplayPath(fp, cwd)) : null;
    }),
  }],

  // Execution tools — shell, external services, mode transitions
  ["bash", {
    displayName: "Bash",
    category: "execution",
    getDetail: wrapDetail(shellDetail),
  }],
  ["powershell", {
    displayName: "PowerShell",
    category: "execution",
    getDetail: wrapDetail(shellDetail),
  }],
  ["repl", {
    displayName: "REPL",
    category: "execution",
    getDetail: wrapDetail(shellDetail),
  }],
  ["websearch", {
    displayName: "Web Search",
    category: "execution",
    getDetail: wrapDetail((input) => singleLine((input.query as string | undefined) ?? (input.search_query as string | undefined))),
  }],
  ["webfetch", {
    displayName: "Web Fetch",
    category: "execution",
    getDetail: wrapDetail((input) => singleLine(input.url as string)),
  }],
  ["lsp", {
    displayName: "LSP",
    category: "execution",
    getDetail: wrapDetail((input, cwd) => {
      const method = input.method as string | undefined;
      const fp = input.file_path as string | undefined;
      return singleLine(method ? `${method}${fp ? ` ${formatDisplayPath(fp, cwd)}` : ""}` : (fp ? formatDisplayPath(fp, cwd) : null));
    }),
  }],
  ["notebookedit", {
    displayName: "Notebook Edit",
    category: "execution",
    getDetail: wrapDetail((input, cwd) => {
      const fp = (input.notebook_path as string | undefined) ?? (input.file_path as string | undefined);
      return fp ? singleLine(formatDisplayPath(fp, cwd)) : null;
    }),
  }],
  ["sendmessage", {
    displayName: "Send Message",
    category: "execution",
    getDetail: wrapDetail((input) => {
      const to = input.to as string | undefined;
      return to ? singleLine(`to ${to}`) : null;
    }),
  }],
  ["enterplanmode", { displayName: "Enter Plan Mode", category: "execution" }],
  ["exitplanmode", { displayName: "Exit Plan Mode", category: "execution" }],
  ["enterworktree", { displayName: "Enter Worktree", category: "execution" }],
  ["exitworktree", { displayName: "Exit Worktree", category: "execution" }],
  ["write_handoff", {
    displayName: "Write Handoff",
    category: "execution",
    getDetail: wrapDetail((input) => {
      const summary = input.summary as string | undefined;
      return summary ? singleLine(summary) : null;
    }),
  }],
  ["remotetrigger", { displayName: "Remote Trigger", category: "execution" }],

  // Subagent tools — spawn child agents
  ["agent", {
    displayName: "Subagent",
    category: "subagent",
    getDetail: wrapDetail(agentDetail),
  }],
  ["task", {
    displayName: "Subagent",
    category: "subagent",
    getDetail: wrapDetail(agentDetail),
  }],
  ["dispatch_agent", {
    displayName: "Subagent",
    category: "subagent",
    getDetail: wrapDetail(agentDetail),
  }],

  // Standalone tools — bypass row-in-group, produce their own block
  ["askuserquestion", {
    displayName: "Ask User",
    category: "standalone",
    getDetail: wrapDetail((input) => {
      const q = input.question as string | undefined;
      return q ? singleLine(q) : null;
    }),
  }],
  ["toolsearch", {
    displayName: "Tool Search",
    category: "standalone",
    getDetail: wrapDetail((input) => {
      const query = input.query as string | undefined;
      return query ? singleLine(query) : null;
    }),
  }],
  ["todowrite", { displayName: "Task Update", category: "standalone" }],
  ["skill", {
    displayName: "Skill",
    category: "standalone",
    getDetail: wrapDetail((input) => {
      const skill = (input.skill as string | undefined) ?? (input.name as string | undefined);
      return skill ? singleLine(skill) : null;
    }),
  }],
  ["todo_list", {
    displayName: "Todo List",
    category: "standalone",
    getDetail: wrapDetail((input) => {
      const op = input.operation as string | undefined;
      if (op === "read") return "read";
      if (op === "write") {
        const todos = input.todos as Array<{ content?: string }> | undefined;
        return todos ? singleLine(`write (${todos.length} items)`) : "write";
      }
      if (op === "complete" || op === "abandon") {
        const ids = input.ids as string[] | undefined;
        return ids ? singleLine(`${op} ${ids.join(", ")}`) : op;
      }
      if (op === "start") {
        const id = input.id as string | undefined;
        return id ? singleLine(`start ${id}`) : "start";
      }
      if (op === "add_tasks") {
        const tasks = input.tasks as Array<unknown> | undefined;
        return tasks ? singleLine(`add ${tasks.length} task${tasks.length !== 1 ? "s" : ""}`) : "add_tasks";
      }
      if (op === "add_notes") {
        const id = input.id as string | undefined;
        return id ? singleLine(`note on ${id}`) : "add_notes";
      }
      return op ?? null;
    }),
  }],
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

// ── Classification API ───────────────────────────────────────────

export function classifyTool(name: string): ToolCategory {
  return toolDisplayRegistry.get(name.toLowerCase())?.category ?? "execution";
}

/** Derived from registry entries where `category === "subagent"`. */
export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  entries.filter(([, meta]) => meta.category === "subagent").map(([name]) => name),
);
