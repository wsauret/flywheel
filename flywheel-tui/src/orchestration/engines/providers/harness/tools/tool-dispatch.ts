/**
 * Closed dispatch table for harness tools.
 *
 * Fixed tool set — intentionally not a registry. All tools are known at
 * compile time. Unknown tool names return an error result (not throw).
 */

import { bashDefinition, runCommand } from "./bash.js";
import { writeHandoffDefinition, executeWriteHandoff } from "./write-handoff.js";
import { readImageDefinition, executeReadImage } from "./image.js";
import { todoListDefinition, executeTodoList } from "./todo-list.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  bashDefinition,
  writeHandoffDefinition,
  readImageDefinition,
  todoListDefinition,
]);

export function getToolDefinitions(): readonly ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  switch (name) {
    case "bash": {
      if (typeof input.command !== "string") {
        return { content: "bash requires a string 'command' parameter", isError: true };
      }
      const timeout = typeof input.timeout === "number" ? input.timeout : undefined;
      return runCommand(input.command, context, timeout);
    }

    case "write_handoff":
      return executeWriteHandoff(input, context);

    case "read_image":
      return executeReadImage(input, context);

    case "todo_list":
      return executeTodoList(input, context);

    default:
      return {
        content: `Unknown tool '${name}'. Available tools: ${getToolDefinitions().map((t) => t.name).join(", ")}`,
        isError: true,
      };
  }
}
