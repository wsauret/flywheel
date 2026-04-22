import * as path from "node:path";
import { canonicalize } from "./canonical-name.js";
import { isHandoffPath } from "./paths.js";


type ToolCategory = "exploration" | "mutation" | "execution" | "subagent" | "standalone";

interface ToolDisplayMeta {
  displayName: string;
  category: ToolCategory;
  getDetail?: (input: Record<string, unknown>, cwd: string) => string | null;
}


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

function extractToolPath(input: unknown): string | undefined {
  if (input == null || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  const raw = (record.filePath as string | undefined)
    ?? (record.file_path as string | undefined)
    ?? (record.notebook_path as string | undefined);
  return typeof raw === "string" ? raw : undefined;
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

function searchDetail(input: Record<string, unknown>, cwd: string, ...filterKeys: string[]): string | null {
  const pat = input.pattern as string | undefined;
  const dir = input.path as string | undefined;
  let extra: string | undefined;
  for (const key of filterKeys) {
    extra = input[key] as string | undefined;
    if (extra) break;
  }
  const displayDir = dir ? formatDisplayPath(dir, cwd) : null;
  const quoted = pat ? `"${pat}"` : null;
  const parts = [quoted, displayDir && `in ${displayDir}`, extra && `[${extra}]`].filter(Boolean).join(" ");
  return singleLine(parts || null);
}


const entries: Array<[string, ToolDisplayMeta]> = [
  ["read", {
    displayName: "Read",
    category: "exploration",
    getDetail: (input, cwd) => {
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
    },
  }],
  ["glob", {
    displayName: "File Search",
    category: "exploration",
    getDetail: (input, cwd) => {
      const pat = input.pattern as string | undefined;
      const dir = input.path as string | undefined;
      const displayDir = dir ? formatDisplayPath(dir, cwd) : null;
      const quoted = pat ? `"${pat}"` : null;
      return singleLine(displayDir ? `${quoted} in ${displayDir}` : quoted);
    },
  }],
  ["grep", {
    displayName: "Text Search",
    category: "exploration",
    getDetail: (input, cwd) => searchDetail(input, cwd, "glob", "type"),
  }],
  ["text_search", {
    displayName: "Text Search",
    category: "exploration",
    getDetail: (input, cwd) => searchDetail(input, cwd, "glob_pattern", "type"),
  }],
  ["ast_search", {
    displayName: "AST Search",
    category: "exploration",
    getDetail: (input, cwd) => searchDetail(input, cwd, "language"),
  }],

  ["write", {
    displayName: "Write",
    category: "mutation",
    getDetail: (input, cwd) => singleLine(formatDisplayPath(input.file_path as string, cwd)),
  }],
  ["edit", {
    displayName: "Edit",
    category: "mutation",
    getDetail: (input, cwd) => {
      const fp = input.file_path as string | undefined;
      return fp ? singleLine(formatDisplayPath(fp, cwd)) : null;
    },
  }],

  ["bash", {
    displayName: "Bash",
    category: "execution",
    getDetail: shellDetail,
  }],
  ["powershell", {
    displayName: "PowerShell",
    category: "execution",
    getDetail: shellDetail,
  }],
  ["repl", {
    displayName: "REPL",
    category: "execution",
    getDetail: shellDetail,
  }],
  ["websearch", {
    displayName: "Web Search",
    category: "execution",
    getDetail: (input) => singleLine((input.query as string | undefined) ?? (input.search_query as string | undefined)),
  }],
  ["webfetch", {
    displayName: "Web Fetch",
    category: "execution",
    getDetail: (input) => singleLine(input.url as string),
  }],
  ["lsp", {
    displayName: "LSP",
    category: "execution",
    getDetail: (input, cwd) => {
      const method = input.method as string | undefined;
      const fp = input.file_path as string | undefined;
      return singleLine(method ? `${method}${fp ? ` ${formatDisplayPath(fp, cwd)}` : ""}` : (fp ? formatDisplayPath(fp, cwd) : null));
    },
  }],
  ["notebookedit", {
    displayName: "Notebook Edit",
    category: "execution",
    getDetail: (input, cwd) => {
      const fp = (input.notebook_path as string | undefined) ?? (input.file_path as string | undefined);
      return fp ? singleLine(formatDisplayPath(fp, cwd)) : null;
    },
  }],
  ["sendmessage", {
    displayName: "Send Message",
    category: "execution",
    getDetail: (input) => {
      const to = input.to as string | undefined;
      return to ? singleLine(`to ${to}`) : null;
    },
  }],
  ["enterplanmode", { displayName: "Enter Plan Mode", category: "execution" }],
  ["exitplanmode", { displayName: "Exit Plan Mode", category: "execution" }],
  ["enterworktree", { displayName: "Enter Worktree", category: "execution" }],
  ["exitworktree", { displayName: "Exit Worktree", category: "execution" }],
  ["write_handoff", {
    displayName: "Write Handoff",
    category: "execution",
    getDetail: (input) => {
      const summary = input.summary as string | undefined;
      return summary ? singleLine(summary) : null;
    },
  }],
  ["remotetrigger", { displayName: "Remote Trigger", category: "execution" }],

  ["agent", {
    displayName: "Subagent",
    category: "subagent",
    getDetail: agentDetail,
  }],
  ["task", {
    displayName: "Subagent",
    category: "subagent",
    getDetail: agentDetail,
  }],
  ["dispatch_agent", {
    displayName: "Subagent",
    category: "subagent",
    getDetail: agentDetail,
  }],

  ["askuserquestion", {
    displayName: "Ask User",
    category: "standalone",
    getDetail: (input) => {
      const q = input.question as string | undefined;
      return q ? singleLine(q) : null;
    },
  }],
  ["toolsearch", {
    displayName: "Tool Search",
    category: "standalone",
    getDetail: (input) => {
      const query = input.query as string | undefined;
      return query ? singleLine(query) : null;
    },
  }],
  ["todowrite", { displayName: "Todo List", category: "standalone" }],
  ["skill", {
    displayName: "Skill",
    category: "standalone",
    getDetail: (input) => {
      const skill = (input.skill as string | undefined) ?? (input.name as string | undefined);
      return skill ? singleLine(skill) : null;
    },
  }],
  ["todo_list", {
    displayName: "Todo List",
    category: "standalone",
    getDetail: (input) => {
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
    },
  }],
];

const toolDisplayRegistry: ReadonlyMap<string, ToolDisplayMeta> = new Map(entries);


export function getToolDisplay(name: string): ToolDisplayMeta | undefined {
  return toolDisplayRegistry.get(canonicalize(name));
}

export function getToolDisplayName(name: string, input?: unknown): string {
  const cn = canonicalize(name);
  const filePath = extractToolPath(input);
  if ((cn === "write" || cn === "edit") && isHandoffPath(filePath)) {
    return "Write Handoff";
  }
  const meta = toolDisplayRegistry.get(cn);
  if (meta) return meta.displayName;
  if (cn.startsWith("schedulecron") || cn.startsWith("cron")) return "Cron";
  if (cn.startsWith("mcp__")) return `MCP ${cn.slice(5).split("__")[0]}`;
  return name;
}


export function classifyTool(name: string): ToolCategory {
  return toolDisplayRegistry.get(canonicalize(name))?.category ?? "execution";
}

export const SUBAGENT_TOOL_NAMES: ReadonlySet<string> = new Set(
  entries.filter(([, meta]) => meta.category === "subagent").map(([name]) => name),
);
