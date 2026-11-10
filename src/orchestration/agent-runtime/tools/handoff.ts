import type { HandoffToolSchema } from "../../workflow-host/handoff-tool-schema.js";
import { createHandoffToolCore } from "./handoff-tool.js";
import type { RuntimeTool, ToolContext } from "./types.js";

/** The one input schema every handoff tool shows the model. An agent's output
 *  contract lives in its brief, so every agent of a workflow and every
 *  subagent offers the same tool bytes and shares one prompt-cache prefix; the contract's own
 *  schema still validates and coerces the input (`inputValidationSchema`). */
const HANDOFF_INPUT_SCHEMA = {
  type: "object",
  description: "The handoff JSON object. Pass ALL fields from your handoff instructions directly as top-level keys. Use the fields listed in your handoff instructions.",
  properties: {
    summary: { type: "string", description: "Summary of work done" },
  },
  additionalProperties: true,
} as const;

const HANDOFF_BASE: Pick<
  RuntimeTool,
  "name" | "action" | "description" | "promptGuidelines" | "validatesOwnInput" | "isConcurrencySafe"
> = {
  name: "handoff",
  action: "handoff_write",
  description: "Record the handoff JSON to complete your brief. Pass the handoff fields directly as the input to this tool; each key you provide becomes a top-level key. Do NOT wrap the fields in a 'content' or 'json' key. Follow the handoff instructions in your task message.",
  promptGuidelines: [
    "Finish reviews and verification before handoff: use process to wait for unfinished work, read and act on its results, and stop managed commands that you no longer need. Never hand off first and verify later.",
  ],
  validatesOwnInput: true,
  isConcurrencySafe: false,
};

export function createHandoffTool(options?: { schema?: HandoffToolSchema | undefined }): RuntimeTool {
  const tool = createHandoffToolCore<ToolContext>({
    ...(options?.schema ? { schema: options.schema } : {}),
    logService: "agent-handoff",
    terminateOnSuccess: true,
    noHandoffMessage:
      "The handoff tool was called but this session has no handoff capture configured; this is a chat session, not an agent of a workflow. There is no handoff to submit. Respond directly to the user instead.",
    successMessage: "Handoff recorded.",
    failureMessage: (message) => `Failed to record handoff: ${message}. The handoff was NOT submitted; retry the handoff call.`,
  });
  return {
    ...HANDOFF_BASE,
    inputSchema: HANDOFF_INPUT_SCHEMA,
    ...(tool.inputSchema ? { inputValidationSchema: tool.inputSchema } : {}),
    prepareAdmission: (input) => tool.prepareAdmission(input),
    execute: tool.execute,
  };
}

export const handoffDefinition = createHandoffTool();
