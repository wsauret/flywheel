/**
 * Intent tracing for tool calls.
 *
 * Injects an optional `_i` field into tool input schemas so the model
 * can explain its reasoning for using a tool. This aids debugging and
 * makes agent behavior more transparent.
 */

import type { ToolDefinition } from "./llm.js";

export const INTENT_FIELD = "_i";

/** Adds an optional `_i` string field to a tool's JSON schema. */
export function injectIntentIntoSchema(schema: object): object {
  const record = schema as Record<string, unknown>;
  const propertiesValue = record.properties;
  const properties =
    propertiesValue && typeof propertiesValue === "object" && !Array.isArray(propertiesValue)
      ? (propertiesValue as Record<string, unknown>)
      : {};

  if (INTENT_FIELD in properties) return schema;

  return {
    ...record,
    properties: {
      [INTENT_FIELD]: { type: "string", description: "Your reasoning for using this tool" },
      ...properties,
    },
  };
}

/** Extracts and removes `_i` from a tool input object. */
export function extractIntent(input: Record<string, unknown>): string | undefined {
  const intent = input[INTENT_FIELD];
  if (typeof intent !== "string") return undefined;
  delete input[INTENT_FIELD];
  const trimmed = intent.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Injects the `_i` intent field into all tool schemas. */
export function normalizeTools(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => ({
    ...tool,
    input_schema: injectIntentIntoSchema(tool.input_schema) as ToolDefinition["input_schema"],
  }));
}
