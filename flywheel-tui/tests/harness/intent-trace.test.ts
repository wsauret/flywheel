import { describe, expect, it } from "bun:test";
import {
  INTENT_FIELD,
  extractIntent,
  injectIntentIntoSchema,
  normalizeTools,
} from "../../src/harness/intent-trace.js";
import type { ToolDefinition } from "../../src/harness/llm.js";

// ═══════════════════════════════════════════════════════════════════════════
// Schema Injection
// ═══════════════════════════════════════════════════════════════════════════

describe("injectIntentIntoSchema", () => {
  it("adds _i field to a schema with existing properties", () => {
    const schema = {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    };
    const result = injectIntentIntoSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, unknown>;

    expect(props[INTENT_FIELD]).toBeDefined();
    expect(props.path).toBeDefined();
    // _i should be first key for model visibility
    expect(Object.keys(props)[0]).toBe(INTENT_FIELD);
  });

  it("does not duplicate _i if already present", () => {
    const schema = {
      type: "object",
      properties: {
        [INTENT_FIELD]: { type: "string" },
        path: { type: "string" },
      },
    };
    const result = injectIntentIntoSchema(schema);
    expect(result).toBe(schema); // same reference, no modification
  });

  it("handles schema with no properties", () => {
    const schema = { type: "object" };
    const result = injectIntentIntoSchema(schema) as Record<string, unknown>;
    const props = result.properties as Record<string, unknown>;

    expect(props[INTENT_FIELD]).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Intent Extraction
// ═══════════════════════════════════════════════════════════════════════════

describe("extractIntent", () => {
  it("extracts and removes _i from input", () => {
    const input: Record<string, unknown> = {
      [INTENT_FIELD]: "reading the config file",
      path: "/etc/config",
    };
    const intent = extractIntent(input);

    expect(intent).toBe("reading the config file");
    expect(input[INTENT_FIELD]).toBeUndefined();
    expect(input.path).toBe("/etc/config");
  });

  it("returns undefined when _i is not present", () => {
    const input: Record<string, unknown> = { path: "/etc/config" };
    expect(extractIntent(input)).toBeUndefined();
  });

  it("returns undefined for empty or whitespace-only _i", () => {
    const input: Record<string, unknown> = { [INTENT_FIELD]: "   " };
    expect(extractIntent(input)).toBeUndefined();
  });

  it("returns undefined when _i is not a string", () => {
    const input: Record<string, unknown> = { [INTENT_FIELD]: 42 };
    expect(extractIntent(input)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Tool Normalization
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizeTools", () => {
  it("injects _i into all tool schemas", () => {
    const tools: ToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Write a file",
        input_schema: {
          type: "object",
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
          required: ["path", "content"],
        },
      },
    ];

    const normalized = normalizeTools(tools);

    expect(normalized).toHaveLength(2);
    for (const tool of normalized) {
      const props = tool.input_schema.properties;
      expect(props[INTENT_FIELD]).toBeDefined();
    }
  });

  it("preserves original tool definitions", () => {
    const tools: ToolDefinition[] = [
      {
        name: "grep",
        description: "Search files",
        input_schema: {
          type: "object",
          properties: { pattern: { type: "string" } },
          required: ["pattern"],
        },
      },
    ];

    normalizeTools(tools);

    // Original should be unchanged
    expect(tools[0]!.input_schema.properties[INTENT_FIELD]).toBeUndefined();
  });
});
