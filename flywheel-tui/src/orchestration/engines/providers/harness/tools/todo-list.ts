/**
 * Requirements tracking via in-memory todo list.
 *
 * State lives on ToolContext.todoList, surviving context summarization
 * because the model calls todo_list(read) after recovery.
 */

import type { ToolDefinition, ToolResult, ToolContext, TodoItem } from "./types.js";

const MAX_ITEMS = 50;
const MAX_CONTENT_LENGTH = 500;

export const todoListDefinition: ToolDefinition = {
  name: "todo_list",
  description:
    "Read or write a structured requirements tracking list. " +
    "CRITICAL: Call twice per task — mark in_progress before starting work, then completed when done. " +
    "Keep exactly one task in_progress at all times during multi-step work. " +
    "Create a todo list when the task requires 3+ distinct steps. " +
    "Mark tasks as abandoned when blocked or no longer relevant. " +
    "Call todo_list(read) after any context recovery to restore your task state.",
  input_schema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["read", "write"] },
      todos: {
        type: "array",
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
    },
    required: ["operation"],
  },
  execute: (input: unknown, context: ToolContext) =>
    Promise.resolve(executeTodoList(input as Record<string, unknown>, context)),
};

export function executeTodoList(
  input: Record<string, unknown>,
  context: ToolContext,
): ToolResult {
  if (typeof input.operation !== "string") {
    return { content: "todo_list requires a string 'operation' parameter", isError: true };
  }
  const operation = input.operation;

  if (operation === "read") {
    if (context.todoList.length === 0) {
      return { content: "Todo list is empty.", isError: false };
    }
    const formatted = context.todoList
      .map((item, i) => {
        const status =
          item.status === "completed" ? "[x]"
          : item.status === "in_progress" ? "[~]"
          : item.status === "abandoned" ? "[!]"
          : "[ ]";
        const priority = item.priority ? ` (${item.priority})` : "";
        return `${i + 1}. ${status} ${item.content}${priority}`;
      })
      .join("\n");
    return { content: formatted, isError: false };
  }

  if (operation === "write") {
    if (!Array.isArray(input.todos)) {
      return { content: "write operation requires a 'todos' array", isError: true };
    }
    const todos = input.todos as TodoItem[];

    const enforced = todos.slice(0, MAX_ITEMS).map((item) => ({
      content: item.content.slice(0, MAX_CONTENT_LENGTH),
      status: item.status,
      ...(item.priority ? { priority: item.priority } : {}),
    })) as TodoItem[];

    context.todoList = enforced;
    return { content: `Todo list updated (${enforced.length} items).`, isError: false };
  }

  return { content: `Unknown operation '${operation}'. Use 'read' or 'write'.`, isError: true };
}
