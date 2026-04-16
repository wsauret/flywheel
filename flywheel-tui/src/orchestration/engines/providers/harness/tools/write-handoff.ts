/**
 * Handoff writing tool. Validates input against the worker handoff schema
 * and writes the result to the configured handoff path.
 */

import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/log.js";
import { WorkerHandoffSchema } from "../../../../../infra/handoff-schemas.js";
import type { ToolDefinition, ToolResult, ToolContext } from "./types.js";

const log = Log.create({ service: "harness-handoff" });

export const writeHandoffDefinition: ToolDefinition = {
  name: "write_handoff",
  description: "Write the handoff file to complete the current task",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string" },
      key_changes: { type: "array", items: { type: "string" } },
      remaining_work: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["summary", "key_changes", "remaining_work", "confidence"],
  },
};

export async function executeWriteHandoff(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResult> {
  if (!context.handoffPath) {
    return { content: "No handoff path configured for this session.", isError: true };
  }

  const parsed = WorkerHandoffSchema.safeParse(input);
  if (!parsed.success) {
    const errors = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    log.warn("handoff validation failed", { errors });
    return { content: `Handoff validation failed: ${errors}`, isError: true };
  }

  try {
    await Bun.write(context.handoffPath, JSON.stringify(parsed.data, null, 2));
    log.info("handoff written", { path: context.handoffPath });
    return { content: `Handoff written to ${context.handoffPath}`, isError: false };
  } catch (err) {
    const msg = errorMessage(err);
    log.error("failed to write handoff", { error: msg });
    return { content: `Failed to write handoff: ${msg}`, isError: true };
  }
}
