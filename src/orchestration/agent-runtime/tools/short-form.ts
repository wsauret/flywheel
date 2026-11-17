/**
 * The short form of a rarely used tool (ARCH-CONTEXT-038): its real name, one line, and an open object schema. The
 * planner gives a tool this form once per tree, so every agent and request of the tree sends the same tool bytes. The
 * tool's full contract, which is its description, guidelines, examples, and schema, reaches the model only as the
 * result of a call to the tool (ARCH-TOOLS-058).
 */

import type { AdvertisedTool, RuntimeTool } from "./types.js";

/** One `type: "object"` root that admits any arguments (ARCH-TOOLS-003). Dispatch validates a call against the full
 *  schema, which the short form keeps as its validation schema. */
const SHORT_FORM_SCHEMA = { type: "object", properties: {}, additionalProperties: true } as const;

const CONTRACT_HINT = "Call with {} to read its full contract first.";

function contractHeading(name: string): string {
  return `Contract of the ${name} tool.`;
}

/** Whether `text` is the result of a call that read `name`'s contract. Such a result is standing context: the model
 *  cannot recover it by repeating a call with arguments (ARCH-CONTEXT-011). */
export function isToolContractResult(name: string, text: string): boolean {
  return text.startsWith(contractHeading(name));
}

function renderContract(tool: AdvertisedTool, schema: RuntimeTool["inputSchema"]): string {
  const guidelines = [...tool.promptGuidelines ?? [], ...tool.livePromptGuidelines?.() ?? []];
  return [
    `${contractHeading(tool.name)} It holds for the rest of this context: call ${tool.name} again with arguments that match it.`,
    tool.description,
    ...guidelines.length > 0 ? [`Guidelines:\n${guidelines.map((guideline) => `- ${guideline}`).join("\n")}`] : [],
    ...tool.promptExamples ? [`Examples:\n${tool.promptExamples}`] : [],
    ...tool.contractReference ? [tool.contractReference()] : [],
    `Input schema: ${JSON.stringify(schema)}`,
  ].join("\n\n");
}

/** `tool` in its short form with `summary` as its one line. Its guidelines and examples leave the system prompt and
 *  render only in its contract. */
export function shortFormTool<Tool extends AdvertisedTool>(tool: Tool, summary: string): Tool {
  const schema = tool.inputValidationSchema ?? tool.inputSchema;
  return {
    ...tool,
    description: `${summary} ${CONTRACT_HINT}`,
    promptGuidelines: undefined,
    livePromptGuidelines: undefined,
    promptExamples: undefined,
    contractReference: undefined,
    inputSchema: SHORT_FORM_SCHEMA,
    inputValidationSchema: schema,
    shortForm: true,
    contract: () => renderContract(tool, schema),
  };
}
