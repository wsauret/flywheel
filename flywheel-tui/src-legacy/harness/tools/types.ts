/**
 * Tool interface and types for the Agent Harness.
 *
 * Each tool declares a concurrency mode that controls how it
 * is scheduled relative to other tools in the same batch.
 */

import type { z } from "zod";

/** Controls how a tool is scheduled when multiple tools run in one turn. */
export type ConcurrencyMode = "shared" | "exclusive";

/** Execution context passed to every tool invocation. */
export interface ToolContext {
  cwd: string;
  env: Record<string, string>;
  abortSignal?: AbortSignal;
}

/** Result returned by a tool execution. */
export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** A single tool call request dispatched to the registry. */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/**
 * A registered tool definition.
 *
 * Tools with `concurrency: "shared"` may run in parallel with other
 * shared tools. Tools with `concurrency: "exclusive"` force all prior
 * pending tasks to complete before they execute.
 */
export interface HarnessTool {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  concurrency: ConcurrencyMode;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
