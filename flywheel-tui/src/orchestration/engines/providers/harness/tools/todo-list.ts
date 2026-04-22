/**
 * Requirements tracking via in-memory todo list with granular operations.
 *
 * State lives on ToolContext.todoList, surviving context summarization
 * because the model calls todo_list(read) after recovery.
 *
 * Operations: read, write (full replace), complete, start, abandon,
 * add_tasks, add_notes. Auto-promotes the next pending task after
 * completing the current in_progress task.
 */

import type { ToolDefinition, ToolResult, ToolContext, TodoItem } from "./types.js";

const MAX_ITEMS = 50;
const MAX_CONTENT_LENGTH = 500;
const MAX_NOTES_LENGTH = 500;

let nextId = 1;

function generateId(): string {
  return `task-${nextId++}`;
}

function deriveNextId(items: ReadonlyArray<TodoItem>): void {
  let max = 0;
  for (const item of items) {
    const match = item.id.match(/^task-(\d+)$/);
    if (match) max = Math.max(max, parseInt(match[1]!, 10));
  }
  nextId = max + 1;
}

function normalizeInProgress(items: TodoItem[]): void {
  const inProgress = items.filter((t) => t.status === "in_progress");
  if (inProgress.length > 1) {
    for (let i = 1; i < inProgress.length; i++) inProgress[i]!.status = "pending";
  }
  if (inProgress.length === 0) {
    const next = items.find((t) => t.status === "pending");
    if (next) next.status = "in_progress";
  }
}

function findById(items: TodoItem[], id: string): TodoItem | undefined {
  return items.find((t) => t.id === id);
}

export function formatList(items: ReadonlyArray<TodoItem>): string {
  if (items.length === 0) return "Todo list is empty.";

  const remaining = items.filter((t) => t.status === "pending" || t.status === "in_progress");
  const completedCount = items.filter((t) => t.status === "completed").length;
  const abandonedCount = items.filter((t) => t.status === "abandoned").length;

  const lines: string[] = [];

  if (remaining.length > 0) {
    lines.push(`Remaining items (${remaining.length}):`);
    for (const item of remaining) {
      const marker = item.status === "in_progress" ? "→" : "○";
      lines.push(`  ${marker} ${item.id} ${item.content} [${item.status}]`);
      if (item.notes) {
        for (const noteLine of item.notes.split("\n")) {
          lines.push(`      Note: ${noteLine}`);
        }
      }
    }
  } else {
    lines.push("Remaining items: none.");
  }

  lines.push(`Progress: ${completedCount}/${items.length} tasks complete${abandonedCount > 0 ? `, ${abandonedCount} abandoned` : ""}`);

  lines.push("");
  for (const item of items) {
    const sym =
      item.status === "completed" ? "✓"
      : item.status === "in_progress" ? "→"
      : item.status === "abandoned" ? "✗"
      : "○";
    lines.push(`  ${sym} ${item.id} ${item.content}`);
  }

  return lines.join("\n");
}

export const todoListDefinition: ToolDefinition = {
  name: "todo_list",
  description:
    "Track and display progress on multi-step work. The todo list is rendered to the user in real time " +
    "as a live progress indicator — they see each task appear, see the active task highlighted, and see " +
    "tasks checked off as you complete them. Keep it current so the user can follow your progress. " +
    "Use write to create the initial list. Use complete/start/abandon for incremental updates " +
    "(the next pending task auto-promotes to in_progress). " +
    "Create a todo list when the task requires 3+ distinct steps. " +
    "Your todo state is preserved across context recovery.",
  input_schema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["read", "write", "complete", "start", "abandon", "add_tasks", "add_notes"],
        description:
          "read: view current list. " +
          "write: replace entire list (initial setup or full restructure). " +
          "complete: mark task(s) done by ID. " +
          "start: set a specific task as in_progress. " +
          "abandon: drop task(s) by ID. " +
          "add_tasks: append new tasks. " +
          "add_notes: attach observations to a task.",
      },
      todos: {
        type: "array",
        description: "For write: full replacement list. Each item needs content and status.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", maxLength: 500 },
            status: { type: "string", enum: ["pending", "in_progress", "completed", "abandoned"] },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["content", "status"],
        },
      },
      ids: {
        type: "array",
        description: "For complete/abandon: task IDs to update (e.g. [\"task-1\", \"task-3\"]).",
        items: { type: "string" },
      },
      id: {
        type: "string",
        description: "For start: single task ID to mark as in_progress. For add_notes: task ID to annotate.",
      },
      tasks: {
        type: "array",
        description: "For add_tasks: new tasks to append.",
        items: {
          type: "object",
          properties: {
            content: { type: "string", maxLength: 500 },
            priority: { type: "string", enum: ["high", "medium", "low"] },
          },
          required: ["content"],
        },
      },
      notes: {
        type: "string",
        description: "For add_notes: observation text to append to the task.",
      },
    },
    required: ["operation"],
  },
  execute: (input: Record<string, unknown>, context: ToolContext) =>
    Promise.resolve(executeTodoList(input, context)),
};

function applyWrite(input: Record<string, unknown>, context: ToolContext): ToolResult {
  if (!Array.isArray(input.todos)) {
    return { content: "write operation requires a 'todos' array", isError: true };
  }
  const todos = input.todos as Array<Record<string, unknown>>;

  nextId = 1;
  const enforced: TodoItem[] = todos.slice(0, MAX_ITEMS).map((item) => ({
    id: generateId(),
    content: String(item.content ?? "").slice(0, MAX_CONTENT_LENGTH),
    status: (item.status as TodoItem["status"]) ?? "pending",
    ...(item.priority ? { priority: item.priority as TodoItem["priority"] } : {}),
  }));

  normalizeInProgress(enforced);
  context.todoList.length = 0;
  context.todoList.push(...enforced);
  return { content: formatList(context.todoList), isError: false };
}

function applyComplete(input: Record<string, unknown>, context: ToolContext): ToolResult {
  const ids = Array.isArray(input.ids) ? (input.ids as string[]) : [];
  if (ids.length === 0) return { content: "complete requires an 'ids' array of task IDs", isError: true };

  const errors: string[] = [];
  for (const id of ids) {
    const task = findById(context.todoList, id);
    if (task) task.status = "completed";
    else errors.push(`${id} not found`);
  }

  normalizeInProgress(context.todoList);
  const msg = errors.length > 0 ? `Errors: ${errors.join("; ")}\n\n` : "";
  return { content: msg + formatList(context.todoList), isError: false };
}

function applyStart(input: Record<string, unknown>, context: ToolContext): ToolResult {
  const id = typeof input.id === "string" ? input.id : "";
  if (!id) return { content: "start requires an 'id' string", isError: true };

  const task = findById(context.todoList, id);
  if (!task) return { content: `Task ${id} not found`, isError: true };

  for (const t of context.todoList) {
    if (t.status === "in_progress") t.status = "pending";
  }
  task.status = "in_progress";
  return { content: formatList(context.todoList), isError: false };
}

function applyAbandon(input: Record<string, unknown>, context: ToolContext): ToolResult {
  const ids = Array.isArray(input.ids) ? (input.ids as string[]) : [];
  if (ids.length === 0) return { content: "abandon requires an 'ids' array of task IDs", isError: true };

  const errors: string[] = [];
  for (const id of ids) {
    const task = findById(context.todoList, id);
    if (task) task.status = "abandoned";
    else errors.push(`${id} not found`);
  }

  normalizeInProgress(context.todoList);
  const msg = errors.length > 0 ? `Errors: ${errors.join("; ")}\n\n` : "";
  return { content: msg + formatList(context.todoList), isError: false };
}

function applyAddTasks(input: Record<string, unknown>, context: ToolContext): ToolResult {
  const tasks = Array.isArray(input.tasks) ? (input.tasks as Array<Record<string, unknown>>) : [];
  if (tasks.length === 0) return { content: "add_tasks requires a 'tasks' array", isError: true };

  deriveNextId(context.todoList);
  const toAdd = tasks.slice(0, MAX_ITEMS - context.todoList.length).map((t) => ({
    id: generateId(),
    content: String(t.content ?? "").slice(0, MAX_CONTENT_LENGTH),
    status: "pending" as const,
    ...(t.priority ? { priority: t.priority as TodoItem["priority"] } : {}),
  }));

  context.todoList.push(...toAdd);
  normalizeInProgress(context.todoList);
  return { content: formatList(context.todoList), isError: false };
}

function applyAddNotes(input: Record<string, unknown>, context: ToolContext): ToolResult {
  const id = typeof input.id === "string" ? input.id : "";
  const notes = typeof input.notes === "string" ? input.notes : "";
  if (!id || !notes) return { content: "add_notes requires 'id' and 'notes' strings", isError: true };

  const task = findById(context.todoList, id);
  if (!task) return { content: `Task ${id} not found`, isError: true };

  const trimmed = notes.slice(0, MAX_NOTES_LENGTH);
  task.notes = task.notes ? `${task.notes}\n${trimmed}` : trimmed;
  return { content: formatList(context.todoList), isError: false };
}

const MUTATION_REINFORCEMENT =
  "Todos updated. Continue using todo_list to track progress — mark each task complete as you finish it.";

export function executeTodoList(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolResult {
  if (typeof input.operation !== "string") {
    return { content: "todo_list requires a string 'operation' parameter", isError: true };
  }

  switch (input.operation) {
    case "read":
      return { content: formatList(context.todoList), isError: false };
    case "write":
    case "complete":
    case "start":
    case "abandon":
    case "add_tasks":
    case "add_notes": {
      const result = applyMutation(input.operation, input, context);
      if (result.isError) return result;
      return { content: `${MUTATION_REINFORCEMENT}\n\n${result.content}`, isError: false };
    }
    default:
      return { content: `Unknown operation '${input.operation}'. Use read, write, complete, start, abandon, add_tasks, or add_notes.`, isError: true };
  }
}

function applyMutation(
  op: string,
  input: Record<string, unknown>,
  context: ToolContext,
): ToolResult {
  switch (op) {
    case "write": return applyWrite(input, context);
    case "complete": return applyComplete(input, context);
    case "start": return applyStart(input, context);
    case "abandon": return applyAbandon(input, context);
    case "add_tasks": return applyAddTasks(input, context);
    case "add_notes": return applyAddNotes(input, context);
    default: return { content: "Unknown mutation", isError: true };
  }
}
