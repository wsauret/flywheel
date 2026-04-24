/**
 * Closed dispatch table for harness tools.
 *
 * Fixed tool set — all tools known at compile time, registered via Map.
 * Unknown tool names return an error result (not throw).
 */

import { bashDefinition } from "./bash.js";
import { writeHandoffDefinition } from "./write-handoff.js";
import { readDefinition } from "./read.js";
import { todoListDefinition } from "./todo-list.js";
import { editDefinition } from "./edit.js";
import { writeDefinition } from "./write.js";
import { textSearchDefinition } from "./text-search.js";
import { astSearchDefinition } from "./ast-search.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

const TOOL_REGISTRY: ReadonlyMap<string, ToolDefinition> = new Map([
  [bashDefinition.name, bashDefinition],
  [writeHandoffDefinition.name, writeHandoffDefinition],
  [readDefinition.name, readDefinition],
  [todoListDefinition.name, todoListDefinition],
  [editDefinition.name, editDefinition],
  [writeDefinition.name, writeDefinition],
  [textSearchDefinition.name, textSearchDefinition],
  [astSearchDefinition.name, astSearchDefinition],
]);

const TOOL_DEFINITIONS: readonly ToolDefinition[] = Array.from(TOOL_REGISTRY.values());

export function getToolDefinitions(): readonly ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context: ToolContext,
  toolCallId?: string,
  extraTools?: ReadonlyMap<string, ToolDefinition>,
): Promise<ToolResult> {
  const definition = extraTools?.get(name) ?? TOOL_REGISTRY.get(name);
  if (!definition) {
    return {
      content: `Unknown tool '${name}'. Available tools: ${getToolDefinitions().map((t) => t.name).join(", ")}`,
      isError: true,
    };
  }
  if (context.signal?.aborted) return { content: "Aborted by user.", isError: true };
  const ctx = toolCallId != null ? { ...context, toolCallId } : context;
  return definition.execute(input, ctx);
}
