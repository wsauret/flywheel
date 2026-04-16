/**
 * Handoff writing tool. Writes arbitrary JSON to the handoff path.
 * The tool is a pass-through writer — the system prompt tells the LLM what
 * shape to produce, and the downstream readHandoff() validates the schema
 * (DispatcherDecisionHandoffSchema for dispatchers, WorkerHandoffSchema for workers).
 */

import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

const log = Log.create({ service: "harness-handoff" });

export const writeHandoffDefinition: ToolDefinition = {
  name: "write_handoff",
  description:
    "Write the handoff JSON file to complete the current task. " +
    "Pass the handoff fields directly as the input to this tool — each key you provide " +
    "becomes a top-level key in the written JSON file. Do NOT wrap the fields in a " +
    "'content' or 'json' key. Follow the exact schema from your system prompt.",
  input_schema: {
    type: "object",
    description:
      "The handoff JSON object. For dispatchers: schema_version, step_index, task_content, " +
      "context_files, and evaluation_criteria are required. For workers: summary is required.",
    properties: {
      schema_version: { type: "number", description: "Schema version (always 1 for dispatchers)" },
      step_index: { type: "number", description: "Current step index (0-based, dispatchers only)" },
      task_content: { type: "string", description: "Task prompt for the worker (dispatchers only)" },
      context_files: {
        type: "array",
        items: { type: "string" },
        description: "Files the worker should read (dispatchers only)",
      },
      evaluation_criteria: {
        type: "object",
        description: "How to verify completion (dispatchers only)",
        additionalProperties: true,
      },
      summary: { type: "string", description: "Summary of work done (workers/evaluators)" },
    },
    additionalProperties: true,
  },
};

// Detect dispatcher handoffs missing required fields.
// Returns missing field names, or empty array if valid (or not a dispatcher handoff).
function checkDispatcherFields(input: Record<string, unknown>): string[] {
  // Only validate if this looks like a dispatcher handoff (has schema_version or task_content)
  const isDispatcher = "schema_version" in input || "task_content" in input || "step_index" in input;
  if (!isDispatcher) return [];

  const required = ["schema_version", "step_index", "task_content", "context_files"] as const;
  return required.filter((k) => !(k in input));
}

export async function executeWriteHandoff(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  if (!context.handoffPath) {
    return { content: "No handoff path configured for this session.", isError: true };
  }

  // Pre-write validation: warn the model about missing required fields so it can retry
  const missingFields = checkDispatcherFields(input);
  if (missingFields.length > 0) {
    log.warn("dispatcher handoff missing fields", { missing: missingFields });
    return {
      content:
        `Dispatcher handoff is missing required fields: ${missingFields.join(", ")}. ` +
        `Please call write_handoff again with all required fields: ` +
        `schema_version (must be 1), step_index, task_content, context_files.`,
      isError: true,
    };
  }

  try {
    await Bun.write(context.handoffPath, JSON.stringify(input, null, 2));
    log.info("handoff written", { path: context.handoffPath });
    return { content: `Handoff written to ${context.handoffPath}`, isError: false };
  } catch (err) {
    const msg = errorMessage(err);
    log.error("failed to write handoff", { error: msg });
    return { content: `Failed to write handoff: ${msg}`, isError: true };
  }
}
